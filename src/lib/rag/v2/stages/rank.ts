import { env } from '@/lib/env';
import type { RawChunk } from '../../backend/supabase-rpc';
import { resolveFinalResultCount, validResultCount, type RagConfig, type RerankerKind, type StageName } from '../../config';
import { getRagDeps } from '../../deps';
import { LEGACY_PROFILE } from '../../embeddings/active-profile';
import type { QueryEmbedding } from '../../embeddings/query-embedding';
import type { FusedHit } from '../../fusion/rrf';
import { runStage, StageError, stageSpec, type StageSpec } from '../../pipeline';
import type { DedupeCounts } from '../../fusion/dedupe';
import { decideRefusal, type GateCandidate, type GateInput, type QueryLanguage } from '../../refusal/gate';
import { LEGACY_KEEP_FLOORS, legacyQueryTerms } from '../../context/relevance';
import {
  LEGACY_VOICE_DEFAULT_MATCH_COUNT,
  legacyPoolFromRows,
  legacyPoolRule,
  legacyVoicePoolRule,
  searchThresholdsFor,
  type LegacyPoolRule,
} from '../../legacy/enhanced-retrieval';
import { defaultQueryContext, type TemporalQueryContext } from '../../query/temporal-query-detector';
import { emptyLegacyPool, evalFloorCalibration, floorsFromCalibration, legacyRuleFloor, similarityFloor } from '../../refusal/floor';
import { loadThresholds } from '../../refusal/thresholds';
import type { RefusalRecord } from '../../refusal/types';
import { describeReranker, resolveReranker } from '../../rerank/select';
import { rerankText } from '../../rerank/text';
import { RERANK_TEXT_VERSION, type RerankScore, type RerankSpan } from '../../rerank/types';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, QueryVariant, ReferencedState, RunRetrievalInput, StageOverrides } from '../../types';
import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import { v2ProfileSettings } from '../profiles';
import { reserveSubQuestionCoverage, subQuestionsOf } from '../subq-coverage';
import { diversify, type AlsoIn, type DiversifyCounts } from '../diversify';
import { effectiveRetrievalParams } from '../retrieval-params';
import { effectiveTuningParams } from '../tuning-params';
import { guardNearMisses } from '../../retrieval/identifiers';
import { extractChunkIdentifiers } from '../../identifiers/extract';
import { EXACT_ID_LIMIT, mergeExactCandidates, type ExactIdRow } from '../../retrieval/exact-id';
import type { ContextRerankInput } from './context';
import { fetchAssemblyRows } from '../../context/fetch-rows';
import type { ScopeAccessFilter } from '../../tenant/access';

export interface RankStagesInput {
  input: RunRetrievalInput;
  config: RagConfig;
  profile: Profile;
  embedding: QueryEmbedding;
  queryLanguage: QueryLanguage | null;
  fusedHits: FusedHit[];
  referenced: ReferencedState | null;
  signal: AbortSignal;
  collector: TraceCollector;
  stageOverrides?: StageOverrides;
  variants?: QueryVariant[];
  dedupeCounts?: DedupeCounts;
  /** The query analysis of the query stage; the legacy_rule floor replays the legacy search with it (default context when absent). */
  queryContext?: TemporalQueryContext;
  /** The request's access filter; the legacy_rule evidence read uses it (absent: off). */
  access?: ScopeAccessFilter;
  /** Query layer only (D-06): rerank and refusal read the plan's standalone query and Candidate.standaloneSimilarity. */
  queryPlan?: QueryPlan | null;
  /** D-07: sub-question coverage over the final top-k (retrieval-params `sub_question_coverage`). */
  coverage?: { enabled: boolean; topK: number };
  /** D-21: the final top-k the diversify window is sized from; defaults to the effective retrieval parameters. */
  finalTopK?: number;
  /** D-49: selects a per-profile tuning entry. */
  embeddingProfileId?: string;
  /**
   * D-31, D-51: the question's normalized identifiers (with the stored forms they resolved to) and the tenant's patterns; present only
   * while the identifier filter is on. filteredBy is set when every search leg was filtered to chunks carrying one of norms.
   */
  identifiers?: {
    askedNorms: readonly string[];
    patterns: readonly RegExp[];
    filteredBy?: { norms: readonly string[]; spellings: readonly string[] };
  };
}

export interface RankRerankOutput extends ContextRerankInput {
  ran: boolean;
  status: 'ok' | 'skipped' | 'disabled';
  provider: RerankerKind;
  model: string | null;
  scoreByChunk: Map<string, number>;
}

export interface RankStagesOutput {
  /** Final routing record: the rerank threshold gate, else the similarity floor. */
  decision: RefusalRecord;
  /** The threshold gate's own record, kept when it was not applied and the floor decided. */
  gate: RefusalRecord;
  survivors: FusedHit[];
  /** Candidates before refusal, in rerank order when the rerank stage ran. */
  preRefusalHits: FusedHit[];
  rerank: RankRerankOutput;
  /** D-21: the dropped duplicates of each kept chunk; present only when the diversify stage ran. */
  alsoIn?: Map<string, AlsoIn[]>;
  /** D-31, D-51: how many look-alike candidates the identifier_guard stage removed; present only when it ran. */
  identifierGuard?: { dropped: number };
}

interface RerankGateState {
  reranker: GateInput['reranker'];
  status: 'ok' | 'skipped' | 'disabled';
  reranked: GateCandidate[];
}

interface RerankStageResult {
  hits: FusedHit[];
  output: RankRerankOutput;
  gate: RerankGateState;
}

const GATE_LANGUAGES: readonly string[] = ['zh', 'en', 'it'];

function hitHasImage(hit: FusedHit['hit']): boolean {
  const meta = hit.metadata as Record<string, unknown> | null;
  if (meta?.image_url) return true;
  const name = hit.document.filename.toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].some((ext) => name.endsWith(ext));
}

function gateLanguage(language: string | null): QueryLanguage | null {
  return language !== null && GATE_LANGUAGES.includes(language) ? (language as QueryLanguage) : null;
}

interface RefusalOutcome {
  record: RefusalRecord;
  gate: RefusalRecord;
  /** legacy_rule only: how many fused hits the legacy pool rule admitted. */
  poolSize?: number;
  /** legacy_rule only: how many of them came from the exact_id list. */
  exactMembers?: number;
  /** legacy_rule only: how many documents the evidence read returned; absent when no read happened. */
  evidenceRead?: number;
}

function denseLegIndex(variants: QueryVariant[] | undefined): number {
  const original = (variants ?? []).findIndex((variant) => variant.kind === 'original');
  return original >= 0 ? original : 0;
}

const EXACT_ID_LEG = 'exact_id';

/** The rows of the exact_id list in lookup order, as many as the legacy lookup asks for (its default limit). */
function legacyExactRows(hits: FusedHit[]): ExactIdRow[] {
  const seen = new Set<string>();
  const rows: ExactIdRow[] = [];
  const listed = hits
    .filter((row) => row.ranks[EXACT_ID_LEG] !== undefined)
    .sort((a, b) => (a.ranks[EXACT_ID_LEG] as number) - (b.ranks[EXACT_ID_LEG] as number));
  for (const row of listed) {
    if (seen.has(row.hit.chunkId)) continue;
    seen.add(row.hit.chunkId);
    rows.push({ chunk_id: row.hit.chunkId, document_id: row.hit.documentId, content: row.hit.content, metadata: row.hit.metadata, matched_field: '' });
    if (rows.length >= EXACT_ID_LIMIT) break;
  }
  return rows;
}

interface LegacyPoolMember {
  row: FusedHit;
  /** D-28 revision: set for a row of the exact_id list, with the similarity legacy's merge gives it. */
  exactSimilarity?: number;
}

/**
 * The fused hits legacy would have judged: rows the original query's dense leg returned (never a lexical-only row), replayed through
 * the legacy search rule of the entry point (chat and embed: thresholds, match counts, fallback, eval override; voice: the legacy voice
 * search). D-28 revision: for chat and embed the rows of the exact_id list join that pool through mergeExactCandidates, as the legacy
 * pipeline merges its exact-identifier rows, and carry the similarity it gives them; a synthetic similarity from any other list admits
 * nothing, and the legacy voice search has no exact lookup.
 */
function legacyPoolMembers(ctx: RankStagesInput, hits: FusedHit[]): LegacyPoolMember[] {
  const leg = `dense:${denseLegIndex(ctx.variants)}`;
  const byChunk = new Map<string, FusedHit>();
  const rows: RawChunk[] = [];
  for (const row of hits) {
    const similarity = row.hit.similarity;
    if (row.ranks[leg] === undefined || similarity === null || !Number.isFinite(similarity)) continue;
    if (byChunk.has(row.hit.chunkId)) continue;
    byChunk.set(row.hit.chunkId, row);
    rows.push({
      chunk_id: row.hit.chunkId,
      document_id: row.hit.documentId,
      content: row.hit.content,
      similarity,
      metadata: row.hit.metadata,
    });
  }
  const options = ctx.input.options;
  const evalProfileId = ctx.profile === 'eval' ? options?.embeddingProfile : undefined;
  const queryContext = ctx.queryContext ?? defaultQueryContext();
  const thresholds = searchThresholdsFor(ctx.embedding.profile);
  const maxResults = resolveFinalResultCount(options?.maxResults, env.RAG_FINAL_RESULT_COUNT);
  const rule: LegacyPoolRule =
    ctx.profile === 'voice'
      ? legacyVoicePoolRule(thresholds, validResultCount(options?.maxResults) ?? LEGACY_VOICE_DEFAULT_MATCH_COUNT)
      : legacyPoolRule({
          queryContext,
          thresholds,
          maxResults,
          fallbackToLowerThreshold: options?.fallbackToLowerThreshold ?? true,
          profileRequireActive: !evalProfileId,
        });
  const replayed = legacyPoolFromRows(rule, queryContext, rows);
  const exactRows = ctx.profile === 'voice' ? [] : legacyExactRows(hits);
  if (exactRows.length === 0) {
    const pool = new Set(replayed.map((candidate) => candidate.chunk_id));
    return hits.filter((row) => pool.has(row.hit.chunkId) && byChunk.get(row.hit.chunkId) === row).map((row) => ({ row }));
  }
  const merged = mergeExactCandidates(replayed, exactRows, maxResults);
  const exactIds = new Set(exactRows.map((row) => row.chunk_id));
  const members: LegacyPoolMember[] = [];
  const taken = new Set<string>();
  for (const candidate of merged) {
    const exact = exactIds.has(candidate.chunk_id);
    const row = exact
      ? hits.find((entry) => entry.hit.chunkId === candidate.chunk_id && entry.ranks[EXACT_ID_LEG] !== undefined)
      : byChunk.get(candidate.chunk_id);
    if (!row || taken.has(candidate.chunk_id)) continue;
    taken.add(candidate.chunk_id);
    members.push(exact ? { row, exactSimilarity: candidate.similarity } : { row });
  }
  return members;
}

function bestDenseSimilarity(hits: FusedHit[]): number | null {
  let best: number | null = null;
  for (const row of hits) {
    const sim = row.hit.similarity;
    if (sim !== null && Number.isFinite(sim) && (best === null || sim > best)) best = sim;
  }
  return best;
}

/** D-31: the floors' reason when a candidate of an identifier-filtered search carries an asked identifier the tenant holds. */
export const IDENTIFIER_MATCH_REASON = 'identifier_match';

/**
 * D-31: the similarity floors stand in for relevance evidence. Under an applied identifier filter, a candidate that carries an asked
 * identifier (read with the ingestion extractor, as the guard reads it) is that evidence, as a query-term match is for legacy_rule.
 */
function identifierMatchRecord(ctx: RankStagesInput, fusedHits: FusedHit[], standalone: boolean): RefusalRecord | null {
  const filteredBy = ctx.identifiers?.filteredBy;
  if (!filteredBy || filteredBy.norms.length === 0 || fusedHits.length === 0) return null;
  const wanted = new Set(filteredBy.norms);
  const patterns = ctx.identifiers?.patterns ?? [];
  if (!fusedHits.some((row) => extractChunkIdentifiers(row.hit.content, patterns).norm.some((norm) => wanted.has(norm)))) return null;
  let best: number | null = null;
  for (const row of fusedHits) {
    const sim = floorSimilarity(row, standalone);
    if (sim !== null && Number.isFinite(sim) && (best === null || sim > best)) best = sim;
  }
  return { decision: 'answer', basis: 'none', reason: IDENTIFIER_MATCH_REASON, topScore: best, threshold: null, cellKey: null };
}

/** The text with every occurrence of the spellings removed (both sides NFKC, as the spellings were read from the question). */
function withoutSpellings(text: string, spellings: readonly string[]): string {
  if (spellings.length === 0) return text;
  let out = text.normalize('NFKC');
  for (const spelling of [...spellings].sort((a, b) => b.length - a.length)) {
    if (spelling.length > 0) out = out.split(spelling).join(' ');
  }
  return out.replace(/\s+/gu, ' ').trim();
}

/** D-06: under the query layer the floor reads the standalone variant's similarity, never a HyDE, expanded or translated list. */
function floorSimilarity(row: FusedHit, standalone: boolean): number | null {
  return standalone ? (row.standaloneSimilarity ?? 0) : row.hit.similarity;
}

interface RefusalOptions {
  /** legacy_rule only: read the pool members' whole document text when nothing else kept a member (the stage path, never the skip path). */
  evidence: boolean;
  signal: AbortSignal;
}

/**
 * legacy_rule evidence: the whole documents.content of the pool members' documents, read through the row fetch legacy assembles
 * from (the ids come from the request's own scoped hits, under the request's access filter). Legacy's query-term rule reads this text.
 */
async function legacyEvidenceText(ctx: RankStagesInput, members: FusedHit[], signal: AbortSignal): Promise<Map<string, string>> {
  const adminClient = getRagDeps().adminClient();
  if (!adminClient) throw new Error('[RAG Refusal] admin client unavailable');
  const rows = await fetchAssemblyRows(
    members.map((row) => ({
      chunk_id: row.hit.chunkId,
      document_id: row.hit.documentId,
      content: row.hit.content,
      similarity: row.hit.similarity ?? 0,
      metadata: row.hit.metadata,
    })),
    { adminClient, signal, access: ctx.access ?? { mode: 'off' } },
  );
  const wanted = new Set(members.map((row) => row.hit.documentId));
  const out = new Map<string, string>();
  for (const [id, doc] of rows.documents) {
    if (wanted.has(id) && typeof doc.content === 'string') out.set(id, doc.content);
  }
  return out;
}

async function applyRefusal(
  ctx: RankStagesInput,
  fusedHits: FusedHit[],
  rerankGate: RerankGateState,
  options: RefusalOptions,
): Promise<RefusalOutcome> {
  const { config, profile, embedding, queryLanguage } = ctx;
  const standalone = Boolean(ctx.queryPlan);
  const query = ctx.queryPlan ? ctx.queryPlan.standalone : ctx.input.query;
  const { cells } = loadThresholds();
  const gate = decideRefusal({
    enabled: config.v2.refusalThreshold,
    profile,
    reranker: rerankGate.reranker,
    rerankStatus: rerankGate.status,
    reranked: rerankGate.reranked,
    queryLanguage,
    cells,
    versions: { lexical: config.v2.lexicalVersion, rerankText: RERANK_TEXT_VERSION },
    ragMode: ctx.input.options?.ragMode,
  });
  if (gate.decision !== 'not_applied') return { record: gate, gate };

  const identifierMatch = identifierMatchRecord(ctx, fusedHits, standalone);
  if (identifierMatch) return { record: identifierMatch, gate };

  if (config.v2.refusalFloor === 'legacy_rule') {
    const members = legacyPoolMembers(ctx, fusedHits);
    if (members.length === 0 && fusedHits.length > 0) {
      return { record: emptyLegacyPool(bestDenseSimilarity(fusedHits)), gate, poolSize: 0 };
    }
    const exactMembers = members.filter((member) => member.exactSimilarity !== undefined).length;
    const pool = { poolSize: members.length, ...(exactMembers > 0 ? { exactMembers } : {}) };
    const terms = legacyQueryTerms(query);
    const judge = (textOf: (row: FusedHit) => string) =>
      legacyRuleFloor({
        floors: LEGACY_KEEP_FLOORS,
        terms,
        candidates: members.map(({ row, exactSimilarity }) => ({
          similarity: exactSimilarity ?? floorSimilarity(row, standalone),
          hasImage: hitHasImage(row.hit),
          filename: row.hit.document.filename,
          text: textOf(row),
        })),
      });
    const record = judge((row) => `${row.hit.content} ${row.hit.document.contentPreview}`);
    if (record.decision !== 'refuse' || !options.evidence || terms.length === 0) return { record, gate, ...pool };
    // Nothing kept a member on similarity, image, filename, chunk text or preview: judge the whole document text, as legacy does.
    const evidence = await legacyEvidenceText(
      ctx,
      members.map((member) => member.row),
      options.signal,
    );
    const full = judge((row) => evidence.get(row.hit.documentId) ?? '');
    return { record: full.decision === 'answer' ? full : record, gate, ...pool, evidenceRead: evidence.size };
  }

  const calibration =
    evalFloorCalibration(profile, { evalEntry: ctx.input.evalEntry === true }) ?? embedding.profile?.scoreCalibration ?? LEGACY_PROFILE.scoreCalibration;
  const floors = floorsFromCalibration(calibration as Record<string, unknown>);
  const record = similarityFloor({
    floors,
    candidates: fusedHits.map((row) => ({
      similarity: floorSimilarity(row, standalone),
      hasImage: hitHasImage(row.hit),
    })),
  });
  return { record, gate };
}

function descriptorFor(provider: RerankerKind, model: string | null): GateInput['reranker'] {
  if (provider === 'none' || model === null) return null;
  return { id: provider, model, scoreSemantics: provider === 'local_bm25' ? 'relative' : 'calibrated' };
}

function queryByDocument(hits: FusedHit[], variants: QueryVariant[], query: string): string[] {
  return hits.map((row) => {
    const language = row.hit.language;
    const variant = language === null ? undefined : variants.find((candidate) => candidate.language === language);
    return variant?.text ?? query;
  });
}

function sortedByScore(hits: FusedHit[], scores: RerankScore[]): Array<{ row: FusedHit; score: number; index: number }> {
  const byIndex = new Map(scores.map((entry) => [entry.index, entry.score]));
  return hits
    .map((row, index) => ({ row, index, score: byIndex.get(index) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
}

function notRun(
  hits: FusedHit[],
  status: 'skipped' | 'disabled',
  provider: RerankerKind,
  model: string | null,
): RerankStageResult {
  return {
    hits,
    output: { ran: false, status, provider, model, scoreByChunk: new Map() },
    gate: { reranker: status === 'disabled' ? null : descriptorFor(provider, model), status, reranked: [] },
  };
}

function recordSkipped(collector: TraceCollector, hits: FusedHit[], reason: 'failed' | 'timeout', detail: string): void {
  const at = collector.now();
  collector.record({ name: 'rerank', status: 'skipped', reason, startedAt: at, endedAt: at, candidatesIn: hits.length, detail });
}

async function runRerankStage(ctx: RankStagesInput): Promise<RerankStageResult> {
  const { input, config, profile, queryLanguage, fusedHits: hits, signal, collector, stageOverrides } = ctx;
  const baseSpec = stageSpec(config, profile, 'rerank', 'skip', stageOverrides);
  const deps = getRagDeps();

  if (!baseSpec.enabled) {
    await runStage(baseSpec, signal, async () => null, collector, { candidatesIn: hits.length });
    const configured =
      config.v2.reranker === 'auto'
        ? describeReranker(config, profile, queryLanguage ?? '', stageOverrides?.retrievalOverrides).id
        : config.v2.reranker;
    return notRun(hits, 'disabled', configured, null);
  }

  const resolved = resolveReranker(config, profile, queryLanguage ?? '', stageOverrides?.retrievalOverrides, deps.ragEnv(), deps.fetch);
  if (resolved.provider === 'none') {
    if (resolved.auto) {
      if (signal.aborted) throw new StageError('rerank', 'aborted', signal.reason);
      const at = collector.now();
      collector.record({ name: 'rerank', status: 'disabled', reason: 'disabled', startedAt: at, endedAt: at, candidatesIn: hits.length, detail: 'auto:none' });
    } else {
      await runStage({ ...baseSpec, enabled: false }, signal, async () => null, collector, { candidatesIn: hits.length });
    }
    return notRun(hits, 'disabled', 'none', null);
  }

  const reranker = resolved.reranker;
  if (reranker === null) {
    recordSkipped(collector, hits, 'failed', resolved.reason === 'missing_key' ? 'missing_key' : 'reranker_unavailable');
    return notRun(hits, 'skipped', resolved.provider, resolved.model);
  }

  const settings = v2ProfileSettings(profile, config);
  let timeoutMs = baseSpec.timeoutMs;
  if (settings.deadlineMs !== null) {
    const elapsed = collector.now() - collector.startedAt;
    const remainder = settings.deadlineMs - elapsed - (settings.rerankReserveMs ?? 0);
    if (remainder < (settings.rerankFloorMs ?? 0)) {
      recordSkipped(collector, hits, 'timeout', 'budget_exhausted');
      return notRun(hits, 'skipped', resolved.provider, reranker.model);
    }
    timeoutMs = Math.min(timeoutMs, remainder);
  }

  const wantSpans = settings.compression;
  const texts = hits.map((row) => rerankText({ sectionPath: row.hit.sectionPath, content: row.hit.content }));
  // D-31: under an applied identifier filter every candidate carries a found identifier, so a pool-statistics scorer drops its spelling.
  const constantSpellings = reranker.scoreSemantics === 'relative' ? (ctx.identifiers?.filteredBy?.spellings ?? []) : [];
  const forPool = (text: string) => withoutSpellings(text, constantSpellings);
  const rerankQuery = forPool(ctx.queryPlan ? ctx.queryPlan.standalone : input.query);
  // D-06: under the layer every document is scored against the standalone query, never a generated or translated text.
  const queryByDoc = ctx.queryPlan
    ? hits.map(() => rerankQuery)
    : queryByDocument(hits, ctx.variants ?? [{ text: input.query, language: queryLanguage, kind: 'original' as const }], input.query).map(forPool);
  const capturedFrom = ctx.dedupeCounts?.capped_from ?? hits.length;

  const outcome = await runStage(
    { ...baseSpec, timeoutMs },
    signal,
    async (stageSignal) => {
      if (hits.length === 0) return { scores: [] as RerankScore[], usage: undefined };
      const response = await reranker.rerank(
        rerankQuery,
        texts.map((entry) => entry.text),
        {
          signal: stageSignal,
          timeoutMs,
          wantSpans,
          ...(reranker.id === 'local_bm25' ? { queryByDoc } : {}),
        },
      );
      if (response.scores.length !== hits.length) {
        throw new Error(`[RAG Rerank] expected ${hits.length} scores, got ${response.scores.length}`);
      }
      return response;
    },
    collector,
    {
      candidatesIn: hits.length,
      candidatesOut: (value) => value.scores.length,
      counts: (value) => {
        const counts: Record<string, number> = { rerank_input: hits.length, capped_from: capturedFrom };
        for (const [key, amount] of Object.entries(value.usage ?? {})) {
          counts[`usage_${key.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`] = amount;
        }
        return counts;
      },
      detail: () => (resolved.auto ? `auto:${resolved.provider}` : `${reranker.id}:${reranker.model}`),
    },
  );

  if (outcome.skipped) return notRun(hits, 'skipped', resolved.provider, reranker.model);

  const ordered = sortedByScore(hits, outcome.value.scores);
  const scoreByChunk = new Map<string, number>();
  const spansByChunk = new Map<string, RerankSpan[]>();
  const prefixLengthByChunk = new Map<string, number>();
  const spansByIndex = new Map(outcome.value.scores.map((entry) => [entry.index, entry.spans]));
  for (const entry of ordered) {
    const chunkId = entry.row.hit.chunkId;
    scoreByChunk.set(chunkId, entry.score);
    const spans = spansByIndex.get(entry.index);
    if (wantSpans && spans && spans.length > 0) {
      spansByChunk.set(chunkId, spans);
      prefixLengthByChunk.set(chunkId, texts[entry.index]?.prefixLength ?? 0);
    }
  }

  return {
    hits: ordered.map((entry) => entry.row),
    output: {
      ran: true,
      status: 'ok',
      provider: resolved.provider,
      model: reranker.model,
      scoreByChunk,
      ...(spansByChunk.size > 0 ? { spansByChunk, prefixLengthByChunk } : {}),
    },
    gate: {
      reranker: { id: reranker.id, model: reranker.model, scoreSemantics: reranker.scoreSemantics },
      status: 'ok',
      reranked: ordered.map((entry) => ({ score: entry.score, language: gateLanguage(entry.row.hit.language) })),
    },
  };
}

/** The CI degrade negative control: eval only, the same position legacy drops it (final order, before the refusal). */
function evalDegrade(ctx: RankStagesInput): boolean {
  return ctx.profile === 'eval' && ctx.input.options?.degrade === 'drop_top_candidate';
}

function dropTopCandidate(result: RerankStageResult): RerankStageResult {
  return { ...result, hits: result.hits.slice(1), gate: { ...result.gate, reranked: result.gate.reranked.slice(1) } };
}

export async function runRankStages(ctx: RankStagesInput): Promise<RankStagesOutput> {
  const { config, profile, signal, collector, stageOverrides } = ctx;
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);

  const degrade = evalDegrade(ctx);
  const rerankStage = await runRerankStage(ctx);
  const reranked = degrade ? dropTopCandidate(rerankStage) : rerankStage;
  const rankedHits = reranked.hits;
  const preRefusalHits = rankedHits;
  const variants = ctx.variants ?? [];
  // D-07: only when decomposition produced sub-questions; otherwise the stage output is exactly Phase 4's.
  const coverageActive =
    ctx.coverage !== undefined &&
    (ctx.queryPlan?.sub_questions?.length ?? 0) > 0 &&
    variants.some((variant) => variant.subQuestionIndex !== undefined);

  // D-48, D-38 h: rerank, refusal, diversify, reservation. With diversify disabled the reservation stays in the refusal stage.
  const diversifySpec = spec('diversify', 'skip');
  const diversityOn = diversifySpec.enabled && config.v2.resultDiversity !== 'off';

  const reserve = (hits: FusedHit[]) => {
    if (!coverageActive || !ctx.coverage) return { survivors: hits, reserved: 0 };
    const topK = Math.max(0, ctx.coverage.topK);
    const covered = reserveSubQuestionCoverage(hits.slice(0, topK), hits.slice(topK), variants, {
      enabled: ctx.coverage.enabled,
      max: 4,
    });
    return { survivors: [...covered.topK, ...covered.pool], reserved: covered.reserved };
  };

  const decide = async (options: RefusalOptions) => {
    const refusal = await applyRefusal(ctx, rankedHits, reranked.gate, options);
    if (refusal.record.decision === 'refuse') return { ...refusal, survivors: [] as FusedHit[], reserved: 0 };
    if (diversityOn) return { ...refusal, survivors: rankedHits, reserved: 0 };
    return { ...refusal, ...reserve(rankedHits) };
  };

  const refused = await runStage(
    spec('refusal', 'skip'),
    signal,
    async (stageSignal) => decide({ evidence: true, signal: stageSignal }),
    collector,
    {
      candidatesIn: rankedHits.length,
      counts: ({ record, reserved, evidenceRead }): Record<string, number> => {
        const extra: Record<string, number> = {
          ...(coverageActive && !diversityOn ? { subq_reserved: reserved } : {}),
          ...(evidenceRead !== undefined ? { evidence_documents: evidenceRead } : {}),
        };
        if (record.decision === 'refuse') return { refused: 1, ...extra };
        if (record.decision === 'answer') return { answered: 1, ...extra };
        return { not_applied: 1, ...extra };
      },
      detail: ({ record, gate, poolSize, exactMembers }) => {
        const base = record.basis !== 'none' ? record.basis : record.reason;
        const described =
          record === gate || config.v2.refusalFloor === 'similarity'
            ? base
            : poolSize === undefined
              ? `${base} floor=${config.v2.refusalFloor}`
              : `${base} floor=${config.v2.refusalFloor} pool=${poolSize}${exactMembers ? ` exact=${exactMembers}` : ''}`;
        return degrade ? `${described} degrade=drop_top_candidate` : described;
      },
    },
  );

  // A skipped refusal stage (disabled, failed or timed out) decides without the evidence read, on the hits' own text.
  const { record: decision, gate, survivors: refusalSurvivors } = refused.skipped ? await decide({ evidence: false, signal }) : refused.value;

  // D-31, D-51: rerank, refusal, identifier guard, diversify, reservation. The guard reads each candidate's identifiers in memory.
  let decided = refusalSurvivors;
  let identifierGuard: { dropped: number } | undefined;
  if (ctx.identifiers && ctx.identifiers.askedNorms.length > 0) {
    const { askedNorms, patterns } = ctx.identifiers;
    const guarded = await runStage(
      spec('identifier_guard', 'skip'),
      signal,
      async () => guardNearMisses(refusalSurvivors, askedNorms, { contentOf: (row) => row.hit.content, patterns }),
      collector,
      {
        candidatesIn: refusalSurvivors.length,
        candidatesOut: (value) => value.kept.length,
        counts: (value) => ({ dropped: value.dropped }),
      },
    );
    if (!guarded.skipped) {
      decided = guarded.value.kept;
      identifierGuard = { dropped: guarded.value.dropped };
    }
  }
  const output: RankStagesOutput = {
    decision,
    gate,
    survivors: decided,
    preRefusalHits,
    rerank: reranked.output,
    ...(identifierGuard ? { identifierGuard } : {}),
  };

  if (!diversityOn) {
    await runStage(diversifySpec, signal, async () => null, collector, { candidatesIn: decided.length });
    return output;
  }

  const mode = config.v2.resultDiversity;
  const tuning = effectiveTuningParams(profile, config, undefined, ctx.embeddingProfileId ? { embeddingProfileId: ctx.embeddingProfileId } : undefined);
  const finalTopK = ctx.finalTopK ?? effectiveRetrievalParams(profile, config, null).final_top_k;
  const subQuestionOf = coverageActive ? (row: FusedHit) => [...subQuestionsOf(row, variants)] : undefined;
  const diversified = await runStage(
    diversifySpec,
    signal,
    async (): Promise<{ hits: FusedHit[]; alsoIn: Map<string, AlsoIn[]>; counts: DiversifyCounts; reserved: number }> => {
      const result = diversify(decided, {
        mode,
        lambda: tuning.diversity.mmr_lambda,
        windowFactor: tuning.diversity.mmr_window_factor,
        finalTopK,
        ...(reranked.output.ran ? { relevanceByChunk: reranked.output.scoreByChunk } : {}),
        ...(subQuestionOf ? { subQuestionOf } : {}),
      });
      const covered = reserve(result.hits);
      return { hits: covered.survivors, alsoIn: result.alsoIn, counts: result.counts, reserved: covered.reserved };
    },
    collector,
    {
      candidatesIn: decided.length,
      candidatesOut: (value) => value.hits.length,
      counts: (value): Record<string, number> => ({
        ...value.counts,
        ...(coverageActive ? { subq_reserved: value.reserved } : {}),
      }),
      detail: () => `mode=${mode}`,
    },
  );

  if (diversified.skipped) return { ...output, survivors: reserve(decided).survivors };
  return { ...output, survivors: diversified.value.hits, alsoIn: diversified.value.alsoIn };
}
