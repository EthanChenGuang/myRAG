import { env } from '@/lib/env';
import type { RawChunk } from '../../backend/supabase-rpc';
import { resolveFinalResultCount, validResultCount, type RagConfig, type RerankerKind, type StageName } from '../../config';
import { getRagDeps } from '../../deps';
import { LEGACY_PROFILE } from '../../embeddings/active-profile';
import type { QueryEmbedding } from '../../embeddings/query-embedding';
import type { FusedHit } from '../../fusion/rrf';
import { LEXICAL_VERSION } from '../../lexical/chunk-text';
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
import { v2ProfileSettings } from '../profiles';
import type { ContextRerankInput } from './context';

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
}

function denseLegIndex(variants: QueryVariant[] | undefined): number {
  const original = (variants ?? []).findIndex((variant) => variant.kind === 'original');
  return original >= 0 ? original : 0;
}

/**
 * The fused hits legacy would have judged: rows the original query's dense leg returned (never a lexical-only or a
 * synthetic-similarity row), replayed through the legacy search rule of the entry point (chat and embed: thresholds,
 * match counts, fallback, eval override; voice: the legacy voice search).
 */
function legacyPoolMembers(ctx: RankStagesInput, hits: FusedHit[]): FusedHit[] {
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
  const rule: LegacyPoolRule =
    ctx.profile === 'voice'
      ? legacyVoicePoolRule(thresholds, validResultCount(options?.maxResults) ?? LEGACY_VOICE_DEFAULT_MATCH_COUNT)
      : legacyPoolRule({
          queryContext,
          thresholds,
          maxResults: resolveFinalResultCount(options?.maxResults, env.RAG_FINAL_RESULT_COUNT),
          fallbackToLowerThreshold: options?.fallbackToLowerThreshold ?? true,
          profileRequireActive: !evalProfileId,
        });
  const pool = new Set(legacyPoolFromRows(rule, queryContext, rows).map((candidate) => candidate.chunk_id));
  return hits.filter((row) => pool.has(row.hit.chunkId) && byChunk.get(row.hit.chunkId) === row);
}

function bestDenseSimilarity(hits: FusedHit[]): number | null {
  let best: number | null = null;
  for (const row of hits) {
    const sim = row.hit.similarity;
    if (sim !== null && Number.isFinite(sim) && (best === null || sim > best)) best = sim;
  }
  return best;
}

function applyRefusal(
  ctx: RankStagesInput,
  fusedHits: FusedHit[],
  rerankGate: RerankGateState,
): RefusalOutcome {
  const { config, profile, embedding, queryLanguage } = ctx;
  const { cells } = loadThresholds();
  const gate = decideRefusal({
    enabled: config.v2.refusalThreshold,
    profile,
    reranker: rerankGate.reranker,
    rerankStatus: rerankGate.status,
    reranked: rerankGate.reranked,
    queryLanguage,
    cells,
    versions: { lexical: LEXICAL_VERSION, rerankText: RERANK_TEXT_VERSION },
  });
  if (gate.decision !== 'not_applied') return { record: gate, gate };

  if (config.v2.refusalFloor === 'legacy_rule') {
    const members = legacyPoolMembers(ctx, fusedHits);
    const record =
      members.length === 0 && fusedHits.length > 0
        ? emptyLegacyPool(bestDenseSimilarity(fusedHits))
        : legacyRuleFloor({
            floors: LEGACY_KEEP_FLOORS,
            terms: legacyQueryTerms(ctx.input.query),
            candidates: members.map((row) => ({
              similarity: row.hit.similarity,
              hasImage: hitHasImage(row.hit),
              filename: row.hit.document.filename,
              text: `${row.hit.content} ${row.hit.document.contentPreview}`,
            })),
          });
    return { record, gate, poolSize: members.length };
  }

  const calibration =
    evalFloorCalibration(profile) ?? embedding.profile?.scoreCalibration ?? LEGACY_PROFILE.scoreCalibration;
  const floors = floorsFromCalibration(calibration as Record<string, unknown>);
  const record = similarityFloor({
    floors,
    candidates: fusedHits.map((row) => ({
      similarity: row.hit.similarity,
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
  const variants = ctx.variants ?? [{ text: input.query, language: queryLanguage, kind: 'original' as const }];
  const capturedFrom = ctx.dedupeCounts?.capped_from ?? hits.length;

  const outcome = await runStage(
    { ...baseSpec, timeoutMs },
    signal,
    async (stageSignal) => {
      if (hits.length === 0) return { scores: [] as RerankScore[], usage: undefined };
      const response = await reranker.rerank(
        input.query,
        texts.map((entry) => entry.text),
        {
          signal: stageSignal,
          timeoutMs,
          wantSpans,
          ...(reranker.id === 'local_bm25' ? { queryByDoc: queryByDocument(hits, variants, input.query) } : {}),
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

export async function runRankStages(ctx: RankStagesInput): Promise<RankStagesOutput> {
  const { config, profile, signal, collector, stageOverrides } = ctx;
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);

  const reranked = await runRerankStage(ctx);
  const rankedHits = reranked.hits;
  const preRefusalHits = rankedHits;

  const refused = await runStage(
    spec('refusal', 'skip'),
    signal,
    async () => applyRefusal(ctx, rankedHits, reranked.gate),
    collector,
    {
      candidatesIn: rankedHits.length,
      counts: ({ record }): Record<string, number> => {
        if (record.decision === 'refuse') return { refused: 1 };
        if (record.decision === 'answer') return { answered: 1 };
        return { not_applied: 1 };
      },
      detail: ({ record, gate, poolSize }) => {
        const base = record.basis !== 'none' ? record.basis : record.reason;
        if (record === gate || config.v2.refusalFloor === 'similarity') return base;
        return poolSize === undefined
          ? `${base} floor=${config.v2.refusalFloor}`
          : `${base} floor=${config.v2.refusalFloor} pool=${poolSize}`;
      },
    },
  );

  const { record: decision, gate } = refused.skipped
    ? applyRefusal(ctx, rankedHits, reranked.gate)
    : refused.value;

  const survivors = decision.decision === 'refuse' ? [] : rankedHits;
  return { decision, gate, survivors, preRefusalHits, rerank: reranked.output };
}
