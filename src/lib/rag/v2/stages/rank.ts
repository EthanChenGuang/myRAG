import type { RagConfig, RerankerKind, StageName } from '../../config';
import { getRagDeps } from '../../deps';
import { LEGACY_PROFILE } from '../../embeddings/active-profile';
import type { QueryEmbedding } from '../../embeddings/query-embedding';
import type { FusedHit } from '../../fusion/rrf';
import { LEXICAL_VERSION } from '../../lexical/chunk-text';
import { runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { DedupeCounts } from '../../fusion/dedupe';
import { decideRefusal, type GateCandidate, type GateInput, type QueryLanguage } from '../../refusal/gate';
import { evalFloorCalibration, floorsFromCalibration, similarityFloor } from '../../refusal/floor';
import { loadThresholds } from '../../refusal/thresholds';
import type { RefusalRecord } from '../../refusal/types';
import { resolveReranker } from '../../rerank/select';
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

function applyRefusal(
  config: RagConfig,
  profile: Profile,
  embedding: QueryEmbedding,
  queryLanguage: QueryLanguage | null,
  fusedHits: FusedHit[],
  rerankGate: RerankGateState,
): { record: RefusalRecord; gate: RefusalRecord } {
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
    return notRun(hits, 'disabled', config.v2.reranker, null);
  }

  const resolved = resolveReranker(config, profile, queryLanguage ?? '', stageOverrides?.retrievalOverrides, deps.ragEnv(), deps.fetch);
  if (resolved.provider === 'none') {
    await runStage({ ...baseSpec, enabled: false }, signal, async () => null, collector, { candidatesIn: hits.length });
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
      detail: () => `${reranker.id}:${reranker.model}`,
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
  const { config, profile, embedding, queryLanguage, signal, collector, stageOverrides } = ctx;
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);

  const reranked = await runRerankStage(ctx);
  const rankedHits = reranked.hits;
  const preRefusalHits = rankedHits;

  const refused = await runStage(
    spec('refusal', 'skip'),
    signal,
    async () => applyRefusal(config, profile, embedding, queryLanguage, rankedHits, reranked.gate),
    collector,
    {
      candidatesIn: rankedHits.length,
      counts: ({ record }): Record<string, number> => {
        if (record.decision === 'refuse') return { refused: 1 };
        if (record.decision === 'answer') return { answered: 1 };
        return { not_applied: 1 };
      },
      detail: ({ record }) => (record.basis !== 'none' ? record.basis : record.reason),
    },
  );

  const { record: decision, gate } = refused.skipped
    ? applyRefusal(config, profile, embedding, queryLanguage, rankedHits, reranked.gate)
    : refused.value;

  const survivors = decision.decision === 'refuse' ? [] : rankedHits;
  return { decision, gate, survivors, preRefusalHits, rerank: reranked.output };
}
