import { getRetrievalBackend } from '../../backend/registry';
import type { RankedHit, RetrievalFilterInput, RetrievalFilters } from '../../backend/types';
import type { RagConfig, StageName } from '../../config';
import { dedupeAndCap, type DedupeCounts, type DedupeResult } from '../../fusion/dedupe';
import { rrf, type FusedHit, type RankedList } from '../../fusion/rrf';
import { LEGACY_PROFILE } from '../../embeddings/active-profile';
import type { QueryEmbedding } from '../../embeddings/query-embedding';
import { queryLexicalTokens } from '../../lexical/tokenize';
import { requireValue, runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { TenantScope } from '../../tenant/scope';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, QueryVariant, RunRetrievalInput, StageOverrides } from '../../types';
import { getV2StartupVerdict } from '../startup';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';

export interface SearchStagesInput {
  input: RunRetrievalInput;
  scope: TenantScope;
  config: RagConfig;
  profile: Profile;
  params: RetrievalParams;
  embedding: QueryEmbedding;
  signal: AbortSignal;
  collector: TraceCollector;
  stageOverrides?: StageOverrides;
  variants?: QueryVariant[];
}

export interface SearchStagesOutput {
  fusedHits: FusedHit[];
  dedupeCounts: DedupeCounts;
}

function buildFilters(input: RunRetrievalInput): RetrievalFilters {
  const extra: RetrievalFilterInput = input.retrievalFilters ?? {};
  return { currentOnly: true, ...extra };
}

function profileId(embedding: QueryEmbedding): string {
  return embedding.profile?.id ?? LEGACY_PROFILE.id;
}

function listsFromLegs(
  variantIndex: number,
  dense: RankedHit[],
  lexical: RankedHit[],
  params: RetrievalParams,
): RankedList[] {
  const lists: RankedList[] = [];
  const weights = params.leg_weights ?? { dense: 1, lexical: 1, exact_id: 1 };
  if (dense.length > 0) {
    lists.push({ id: `dense:${variantIndex}`, weight: weights.dense, hits: dense });
  }
  if (lexical.length > 0) {
    lists.push({ id: `lexical:${variantIndex}`, weight: weights.lexical, hits: lexical });
  }
  return lists;
}

function sliceCap(fused: FusedHit[], cap: number): DedupeResult {
  const hits = fused.slice(0, cap);
  return {
    hits,
    counts: {
      candidates_in: fused.length,
      deduped: 0,
      rerank_input: hits.length,
      capped_from: fused.length,
    },
  };
}

export async function runSearchStages(ctx: SearchStagesInput): Promise<SearchStagesOutput> {
  const { input, scope, config, profile, params, embedding, signal, collector, stageOverrides } = ctx;
  const variants = ctx.variants ?? [{ text: input.query, language: null, kind: 'original' as const }];
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);
  const pool = params.candidate_pool_size;
  const filters = buildFilters(input);
  const backend = getRetrievalBackend();
  const lexicalEnabled = config.v2.lexicalSearch;
  const verdict = getV2StartupVerdict();
  const icuSkipLexical = lexicalEnabled && !verdict.icuAvailable;

  const runBackendSearch = async (stageSignal: AbortSignal) => {
    let denseTotal = 0;
    let lexicalTotal = 0;
    const legsByVariant = await Promise.all(
      variants.map(async (variant) => {
        const useLexical = lexicalEnabled && verdict.icuAvailable;
        const tokens = useLexical ? queryLexicalTokens(variant.text) : [];
        const legs = await backend.search({
          scope,
          embeddingProfileId: profileId(embedding),
          denseVector: embedding.vector,
          lexicalTokens: tokens,
          lexicalLanguages: variant.language ? [variant.language] : null,
          filters,
          denseLimit: pool,
          lexicalLimit: pool,
          signal: stageSignal,
        });
        denseTotal += legs.dense.length;
        lexicalTotal += legs.lexical.length;
        return legs;
      }),
    );
    return { legsByVariant, denseTotal, lexicalTotal };
  };

  let searchValue: Awaited<ReturnType<typeof runBackendSearch>>['legsByVariant'];
  if (icuSkipLexical) {
    const startedAt = collector.now();
    const { legsByVariant, denseTotal, lexicalTotal } = await runAgainstSignal(signal, runBackendSearch);
    searchValue = legsByVariant;
    collector.record({
      name: 'search',
      status: 'degraded',
      startedAt,
      endedAt: collector.now(),
      detail: 'lexical_icu_unavailable',
      counts: { dense: denseTotal, lexical: lexicalTotal },
      candidatesOut: denseTotal + lexicalTotal,
    });
  } else {
    searchValue = requireValue(
      await runStage(
        spec('search', 'throw'),
        signal,
        async (stageSignal) => {
          const { legsByVariant, denseTotal, lexicalTotal } = await runBackendSearch(stageSignal);
          return { legsByVariant, denseTotal, lexicalTotal };
        },
        collector,
        {
          candidatesOut: (value) => value.denseTotal + value.lexicalTotal,
          counts: (value) => ({ dense: value.denseTotal, lexical: value.lexicalTotal }),
        },
      ),
      'search',
    ).legsByVariant;
  }

  const fused = requireValue(
    await runStage(
      spec('fuse', 'throw'),
      signal,
      () => {
        const lists = searchValue.flatMap((legs, index) => listsFromLegs(index, legs.dense, legs.lexical, params));
        return rrf(lists, params.rrf_k);
      },
      collector,
      { candidatesOut: (value) => value.length },
    ),
    'fuse',
  );

  const deduped = await runStage(
    spec('dedupe', 'skip'),
    signal,
    () => dedupeAndCap(fused, { byParent: config.v2.parentChild, cap: params.rerank_input_cap }),
    collector,
    {
      candidatesIn: fused.length,
      candidatesOut: (value) => value.hits.length,
      counts: (value) => ({ ...value.counts }),
    },
  );

  const capped = deduped.skipped ? sliceCap(fused, params.rerank_input_cap) : deduped.value;

  await runStage(spec('rerank', 'skip'), signal, async () => null, collector);

  return { fusedHits: capped.hits, dedupeCounts: capped.counts };
}

async function runAgainstSignal<T>(parent: AbortSignal, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(parent.reason);
    if (parent.aborted) {
      onAbort();
      return;
    }
    parent.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(fn(parent))
      .then(resolve, reject)
      .finally(() => parent.removeEventListener('abort', onAbort));
  });
}