import type { RpcClient } from '../../backend/supabase-rpc';
import { getRetrievalBackend } from '../../backend/registry';
import type { BackendLegs, RankedHit, RetrievalFilterInput, RetrievalFilters } from '../../backend/types';
import type { AssemblyDocumentRow } from '../../context/assemble';
import { fetchAssemblyRows } from '../../context/fetch-rows';
import type { RagConfig, StageName } from '../../config';
import { getRagDeps, type RagDeps } from '../../deps';
import { dedupeAndCap, type DedupeCounts, type DedupeResult } from '../../fusion/dedupe';
import { rrf, type FusedHit, type RankedList } from '../../fusion/rrf';
import { LEGACY_PROFILE } from '../../embeddings/active-profile';
import type { QueryEmbedding } from '../../embeddings/query-embedding';
import { queryLexicalTokens } from '../../lexical/tokenize';
import { requireValue, runStage, stageSpec, type StageSpec } from '../../pipeline';
import { exactIdStage, type ExactIdRow } from '../../retrieval/exact-id';
import type { TenantScope } from '../../tenant/scope';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, QueryVariant, RunRetrievalInput, StageOverrides } from '../../types';
import { getV2StartupVerdict } from '../startup';
import { evalChunkingOverride } from '../overrides';
import { bindingFailureDetail, hasBindingWork, runBindingLegs, type BindingEmbed, type BindingLegsOutput, type BindingLegsPlan } from './binding-legs';
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
  /** Index-aligned with variants; a missing entry falls back to the embedding of the original. */
  variantEmbeddings?: QueryEmbedding[];
  filters?: RetrievalFilters;
  /** Query layer on: record each hit's dense similarity under the standalone variant (condensed, else original). */
  trackStandalone?: boolean;
  /** Planned binding legs and their embeds, started before the global embed stage (D-18). */
  bindings?: { plan: BindingLegsPlan; embeds: readonly Promise<BindingEmbed>[] };
}

/** Keeps a binding leg's backend call inside the search stage budget so a slow leg can never time the stage out. */
const BINDING_STAGE_MARGIN_MS = 10;

export interface SearchStagesOutput {
  fusedHits: FusedHit[];
  dedupeCounts: DedupeCounts;
}

function buildFilters(input: RunRetrievalInput): RetrievalFilters {
  const extra: RetrievalFilterInput = input.retrievalFilters ?? {};
  return { currentOnly: true, ...extra };
}

function nonEmpty(values: readonly unknown[] | undefined): boolean {
  return values !== undefined && values.length > 0;
}

/** Mirrors what the backend sends as filter arguments: an empty list is no filter. */
export function hasNarrowingFilters(filters: RetrievalFilters): boolean {
  const invoice = filters.invoice;
  return (
    filters.dateRange?.from !== undefined ||
    filters.dateRange?.to !== undefined ||
    nonEmpty(filters.sources) ||
    nonEmpty(filters.documentIds) ||
    nonEmpty(filters.docTypes) ||
    nonEmpty(filters.languages) ||
    (invoice !== undefined && Object.values(invoice).some((value) => value !== undefined))
  );
}

function lexicalLanguagesFor(variant: QueryVariant): string[] | null {
  return variant.kind === 'translated' && variant.language ? [variant.language] : null;
}

function profileId(embedding: QueryEmbedding): string {
  return embedding.profile?.id ?? LEGACY_PROFILE.id;
}

function requireAdminSearchClient(deps: RagDeps): RpcClient {
  const admin = deps.adminClient();
  if (!admin) throw new Error('[RAG Search] admin client unavailable');
  return admin as unknown as RpcClient;
}

function legHitsByChunkId(legsByVariant: BackendLegs[]): Map<string, RankedHit> {
  const map = new Map<string, RankedHit>();
  for (const legs of legsByVariant) {
    for (const hit of [...legs.dense, ...legs.lexical]) {
      if (!map.has(hit.chunkId)) map.set(hit.chunkId, hit);
    }
  }
  return map;
}

function hitFromExactRow(
  row: ExactIdRow,
  rank: number,
  doc: AssemblyDocumentRow | undefined,
  chunkMeta: Record<string, unknown> | null | undefined,
): RankedHit {
  const metadata = (chunkMeta ?? row.metadata ?? {}) as Record<string, unknown>;
  return {
    rank,
    chunkId: row.chunk_id,
    documentId: row.document_id,
    parentId: null,
    content: row.content,
    metadata,
    chunkIndex: null,
    sectionPath: [],
    chunkKind: typeof metadata.chunk_kind === 'string' ? metadata.chunk_kind : null,
    similarity: 1,
    lexicalScore: null,
    docType: null,
    language: null,
    document: {
      filename: doc?.filename ?? '',
      createdAt: doc?.created_at ?? null,
      metadata: (doc?.metadata ?? {}) as Record<string, unknown>,
      contentPreview: typeof doc?.content === 'string' ? doc.content.slice(0, 200) : '',
    },
  };
}

async function exactIdRankedList(
  rows: ExactIdRow[],
  legsByVariant: BackendLegs[],
  params: RetrievalParams,
  signal: AbortSignal,
): Promise<RankedList | null> {
  if (rows.length === 0) return null;
  const known = legHitsByChunkId(legsByVariant);
  const missing: ExactIdRow[] = [];
  const hits: RankedHit[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const rank = index + 1;
    const existing = known.get(row.chunk_id);
    if (existing) {
      hits.push({ ...existing, rank });
      continue;
    }
    missing.push(row);
    hits.push(hitFromExactRow(row, rank, undefined, row.metadata));
  }
  if (missing.length > 0) {
    const adminClient = getRagDeps().adminClient();
    if (!adminClient) throw new Error('[RAG Search] admin client unavailable');
    const assembly = await fetchAssemblyRows(
      missing.map((row) => ({
        chunk_id: row.chunk_id,
        document_id: row.document_id,
        content: row.content,
        similarity: 1,
        metadata: row.metadata,
      })),
      { adminClient, signal },
    );
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (known.has(row.chunk_id)) continue;
      const hitIndex = hits.findIndex((entry) => entry.chunkId === row.chunk_id);
      if (hitIndex < 0) continue;
      hits[hitIndex] = hitFromExactRow(row, index + 1, assembly.documents.get(row.document_id), assembly.chunkMetadata.get(row.chunk_id));
    }
  }
  const weight = params.leg_weights?.exact_id ?? 1;
  return { id: 'exact_id', weight, hits };
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

/** D-06: the standalone variant is the condensed one when present, else the original; never hyde, expanded or translated. */
function standaloneVariantIndex(variants: readonly QueryVariant[]): number {
  const condensed = variants.findIndex((variant) => variant.kind === 'condensed');
  return condensed >= 0 ? condensed : variants.findIndex((variant) => variant.kind === 'original');
}

function withStandaloneSimilarity(fused: FusedHit[], variants: readonly QueryVariant[], legsByVariant: BackendLegs[]): FusedHit[] {
  const index = standaloneVariantIndex(variants);
  const similarity = new Map<string, number>();
  for (const hit of index >= 0 ? (legsByVariant[index]?.dense ?? []) : []) {
    if (!similarity.has(hit.chunkId)) similarity.set(hit.chunkId, hit.similarity ?? 0);
  }
  return fused.map((row) => ({ ...row, standaloneSimilarity: similarity.get(row.hit.chunkId) ?? 0 }));
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
  const filters = ctx.filters ?? buildFilters(input);
  const backend = getRetrievalBackend();
  const lexicalEnabled = config.v2.lexicalSearch;
  const verdict = getV2StartupVerdict();
  const icuSkipLexical = lexicalEnabled && !verdict.icuAvailable;
  const chunkingOverride = evalChunkingOverride(profile, stageOverrides?.retrievalOverrides);
  const bindings = ctx.bindings && hasBindingWork(ctx.bindings.plan) ? ctx.bindings : null;
  const searchSpec = spec('search', 'throw');
  const bindingTimeoutMs = Math.max(
    1,
    Math.min(config.v2.domainEmbeddings.timeoutMs, searchSpec.timeoutMs - BINDING_STAGE_MARGIN_MS),
  );

  const runDomainLegs = (stageSignal: AbortSignal): Promise<BindingLegsOutput | null> =>
    bindings
      ? runBindingLegs({
          backend,
          scope,
          filters,
          params,
          plan: bindings.plan,
          embeds: bindings.embeds,
          globalEmbedding: embedding,
          signal: stageSignal,
          timeoutMs: bindingTimeoutMs,
          ...(chunkingOverride ? { chunkingProfileOverride: chunkingOverride } : {}),
        })
      : Promise.resolve(null);

  const runBackendSearch = async (stageSignal: AbortSignal) => {
    let denseTotal = 0;
    let lexicalTotal = 0;
    const domainPending = runDomainLegs(stageSignal);
    const legsByVariant = await Promise.all(
      variants.map(async (variant, index) => {
        const variantEmbedding = ctx.variantEmbeddings?.[index] ?? embedding;
        // P-6: a dense-only variant (HyDE) sends no lexical tokens, so it contributes no lexical list.
        const useLexical = lexicalEnabled && verdict.icuAvailable && variant.legs !== 'dense';
        const tokens = useLexical ? queryLexicalTokens(variant.text) : [];
        const legs = await backend.search({
          scope,
          embeddingProfileId: profileId(variantEmbedding),
          denseVector: variantEmbedding.vector,
          lexicalTokens: tokens,
          lexicalLanguages: lexicalLanguagesFor(variant),
          filters,
          denseLimit: pool,
          lexicalLimit: pool,
          signal: stageSignal,
          ...(chunkingOverride ? { chunkingProfileOverride: chunkingOverride } : {}),
        });
        denseTotal += legs.dense.length;
        lexicalTotal += legs.lexical.length;
        return legs;
      }),
    );
    const domain = await domainPending;
    return { legsByVariant, denseTotal, lexicalTotal, domain };
  };

  type SearchResult = Awaited<ReturnType<typeof runBackendSearch>>;

  const searchCounts = (value: { denseTotal: number; lexicalTotal: number; domain: BindingLegsOutput | null }) => ({
    dense: value.denseTotal,
    lexical: value.lexicalTotal,
    ...(value.domain ? value.domain.counts : {}),
  });

  let searchValue: Awaited<ReturnType<typeof runBackendSearch>>['legsByVariant'];
  let domainLists: RankedList[] = [];
  if (icuSkipLexical) {
    const startedAt = collector.now();
    const searched = await runAgainstSignal(signal, runBackendSearch);
    searchValue = searched.legsByVariant;
    domainLists = searched.domain?.lists ?? [];
    collector.record({
      name: 'search',
      status: 'degraded',
      startedAt,
      endedAt: collector.now(),
      detail: 'lexical_icu_unavailable',
      counts: searchCounts(searched),
      candidatesOut: searched.denseTotal + searched.lexicalTotal,
    });
  } else {
    const searched = requireValue(
      await runStage<SearchResult>(
        searchSpec,
        signal,
        (stageSignal) => runBackendSearch(stageSignal),
        collector,
        {
          candidatesOut: (value) => value.denseTotal + value.lexicalTotal,
          counts: searchCounts,
          ...(bindings
            ? {
                // D-19: a dropped binding leg degrades the stage; the global legs and the answer continue.
                status: (value) => (value.domain && value.domain.failures.length > 0 ? 'degraded' : 'ok'),
                detail: (value) => (value.domain ? bindingFailureDetail(value.domain.failures) : undefined),
              }
            : {}),
        },
      ),
      'search',
    );
    searchValue = searched.legsByVariant;
    domainLists = searched.domain?.lists ?? [];
  }

  let exactList: RankedList | null = null;
  if (config.exactIdLookup) {
    // rag_exact_id_documents takes no filter arguments, so while a request narrows the search the leg stands down rather than widen it.
    const exactSpec = spec('exact_id_lookup', 'skip');
    const exact = await runStage(
      hasNarrowingFilters(filters) ? { ...exactSpec, enabled: false } : exactSpec,
      signal,
      (stageSignal) =>
        exactIdStage(input.query, scope, { client: requireAdminSearchClient(getRagDeps()), signal: stageSignal, limit: pool }),
      collector,
      {
        candidatesIn: searchValue.reduce((total, legs) => total + legs.dense.length + legs.lexical.length, 0),
        candidatesOut: (value) => value.rows.length,
        detail: (value) => `tokens=${value.tokenCount}`,
      },
    );
    if (!exact.skipped && exact.value.rows.length > 0) {
      exactList = await exactIdRankedList(exact.value.rows, searchValue, params, signal);
    }
  }

  const fused = requireValue(
    await runStage(
      spec('fuse', 'throw'),
      signal,
      () => {
        const lists = searchValue.flatMap((legs, index) => listsFromLegs(index, legs.dense, legs.lexical, params));
        if (exactList) lists.push(exactList);
        lists.push(...domainLists);
        const fusedHits = rrf(lists, params.rrf_k);
        return ctx.trackStandalone ? withStandaloneSimilarity(fusedHits, variants, searchValue) : fusedHits;
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