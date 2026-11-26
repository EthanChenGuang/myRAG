import {
  CachePairsRunSchema,
  RagTraceSchema,
  type CachePairsRun,
  type GoldenItem,
  type RagRunRequest,
  type RagTrace,
} from '../../src/lib/rag-eval/contracts.generated.ts';
import type { EvalRequestOptions } from './run-eval.mts';

export const CACHE_PAIRS_FILE = 'cache-pairs.json';
/** The probe: the contract's largest cache distance, so every pair within it reports its distance (D-37). */
export const CACHE_PROBE_MAX_DISTANCE = 0.2;
/** Trusted harness variables of an in-process pair run: the pgvector backend, checked at the probe distance. */
export const CACHE_PAIRS_APP_ENV: Readonly<Record<string, string>> = Object.freeze({
  RAG_SEMANTIC_CACHE: 'pgvector',
  RAG_SEMANTIC_CACHE_MAX_DISTANCE: String(CACHE_PROBE_MAX_DISTANCE),
});

const CACHE_STAGE = 'semantic_cache';
const BYPASS_PREFIX = 'bypass_';
const PAIR_CATEGORIES: ReadonlySet<string> = new Set(['cache_paraphrase', 'cache_near_miss']);

type PairRow = CachePairsRun['pairs'][number];
type Outcome = PairRow['outcome'];
type Send = (payload: RagRunRequest) => Promise<{ status: number; body: unknown }>;

export interface CachePairSpec {
  pair: GoldenItem;
  anchor: GoldenItem;
}

/** Each cache pair candidate with the anchor its pair_of names, in golden order; a missing anchor stops the run. */
export function cachePairSpecs(items: GoldenItem[]): CachePairSpec[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return items
    .filter((item) => PAIR_CATEGORIES.has(item.category))
    .map((pair) => {
      const anchor = pair.pair_of ? byId.get(pair.pair_of) : undefined;
      if (!anchor) throw new Error(`[Eval Harness] cache pair ${pair.id}: anchor ${String(pair.pair_of)} is not in the golden file`);
      return { pair, anchor };
    });
}

/**
 * The pair requests: the scope and generator identity of the run plus the cache override. No max_results, degrade, filters,
 * bindings or document references, so no pair is bypassed by document_refs or retrieval_options (plan 06-17).
 */
export function cachePairOptions(base: EvalRequestOptions): EvalRequestOptions {
  const options: EvalRequestOptions = { semantic_cache: 'pgvector' };
  for (const key of ['organization_id', 'user_id', 'generator_model', 'query_framework', 'query_layer', 'query_transforms', 'query_params'] as const) {
    const value = base[key];
    if (value !== undefined && value !== null) (options as Record<string, unknown>)[key] = value;
  }
  return options;
}

/** The semantic_cache stage outcome of one trace, read like the eval report does (hit 1/0 and distance, or bypass_<reason>). */
export function cachePairOutcome(trace: Pick<RagTrace, 'stage_status' | 'stage_counts'>): {
  outcome: Outcome | null;
  distance: number | null;
  bypassReason: string | null;
} {
  const status = trace.stage_status?.[CACHE_STAGE];
  const counts = trace.stage_counts?.[CACHE_STAGE] ?? {};
  const bypassed = Object.keys(counts)
    .filter((key) => key.startsWith(BYPASS_PREFIX) && (counts[key] ?? 0) > 0)
    .map((key) => key.slice(BYPASS_PREFIX.length))
    .sort();
  if (bypassed.length > 0) return { outcome: 'bypass', distance: null, bypassReason: bypassed[0]! };
  if (status === undefined || status === 'disabled') return { outcome: null, distance: null, bypassReason: null };
  if (status !== 'ok') return { outcome: 'failure', distance: null, bypassReason: null };
  if ((counts.hit ?? 0) > 0) return { outcome: 'hit', distance: typeof counts.distance === 'number' ? counts.distance : null, bypassReason: null };
  return { outcome: 'miss', distance: null, bypassReason: null };
}

function payloadFor(item: GoldenItem, options: EvalRequestOptions, seed: string | null): RagRunRequest {
  return {
    schema_version: 1,
    item_id: item.id,
    query: item.question,
    conversation: [],
    rag_mode: 'strict',
    web_search: false,
    options: { ...options, ...(seed !== null ? { cache_seed_answer: seed } : {}) },
  } as RagRunRequest;
}

async function sendTrace(send: Send, payload: RagRunRequest): Promise<RagTrace> {
  const { status, body } = await send(payload);
  if (status !== 200) {
    const detail = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : 'no error body';
    throw new Error(`[Eval Harness] cache pair item ${String(payload.item_id)}: route returned ${status} (${detail})`);
  }
  return RagTraceSchema.partial().parse(body) as RagTrace;
}

/**
 * D-37: per pair, the cache is cleared (when the caller can), the anchor is sent with its expected answer as cache_seed_answer
 * (stored), then the candidate is sent and its semantic_cache outcome recorded. Clearing makes the candidate's distance the
 * distance to its own anchor, even when one anchor serves several pairs.
 */
export async function runCachePairs(input: {
  specs: CachePairSpec[];
  options: EvalRequestOptions;
  send: Send;
  clear?: () => Promise<void>;
  onTrace?: (trace: RagTrace) => void;
}): Promise<PairRow[]> {
  const rows: PairRow[] = [];
  for (const { pair, anchor } of input.specs) {
    await input.clear?.();
    const anchorTrace = await sendTrace(input.send, payloadFor(anchor, input.options, anchor.expected_answer));
    input.onTrace?.(anchorTrace);
    const candidateTrace = await sendTrace(input.send, payloadFor(pair, input.options, null));
    input.onTrace?.(candidateTrace);
    const anchorOutcome = cachePairOutcome(anchorTrace).outcome;
    const candidate = cachePairOutcome(candidateTrace);
    if (candidate.outcome === null) {
      throw new Error(`[Eval Harness] cache pair ${pair.id}: the semantic_cache stage did not run (RAG_PIPELINE=v2 and RAG_QUERY_LAYER=true needed)`);
    }
    rows.push({
      pair_id: pair.id,
      anchor_id: anchor.id,
      category: pair.category as PairRow['category'],
      split: pair.split,
      language: pair.language as PairRow['language'],
      outcome: candidate.outcome,
      hit: candidate.outcome === 'hit',
      distance: candidate.distance,
      bypass_reason: candidate.bypassReason,
      anchor_outcome: anchorOutcome,
    });
  }
  return rows;
}

/** The cache-pairs.json body, validated against the contract. */
export function cachePairsRun(input: { rows: PairRow[]; source: CachePairsRun['source']; embeddingProfileId: string | null }): CachePairsRun {
  return CachePairsRunSchema.parse({
    schema_version: 1,
    source: input.source,
    embedding_profile_id: input.embeddingProfileId,
    probe_max_distance: CACHE_PROBE_MAX_DISTANCE,
    pairs: input.rows,
  });
}
