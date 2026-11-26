import type { RpcClient } from '../../backend/supabase-rpc';
import { getRetrievalBackend } from '../../backend/registry';
import type { BackendLegs, RankedHit, RetrievalFilterInput, RetrievalFilters } from '../../backend/types';
import type { AssemblyDocumentRow } from '../../context/assemble';
import { fetchAssemblyRows } from '../../context/fetch-rows';
import type { RagConfig, StageName } from '../../config';
import { getRagDeps, type RagDeps } from '../../deps';
import { dedupeAndCap, type DedupeCounts, type DedupeResult } from '../../fusion/dedupe';
import { rrf, type FusedHit, type RankedList } from '../../fusion/rrf';
import { getEmbeddingProfileById, LEGACY_PROFILE } from '../../embeddings/active-profile';
import {
  embedQueries,
  embedQueriesForEvalProfile,
  embedQuery,
  embedQueryForEvalProfile,
  type QueryEmbedding,
} from '../../embeddings/query-embedding';
import { requireValue, runStage, StageError, stageSpec, type StageSpec } from '../../pipeline';
import { exactIdStage, type ExactIdRow } from '../../retrieval/exact-id';
import type { TenantScope } from '../../tenant/scope';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, QueryVariant, RunRetrievalInput, StageOverrides } from '../../types';
import { getV2StartupVerdict } from '../startup';
import { evalChunkingOverride } from '../overrides';
import { createRetrievalPort, listsFromLegs, variantSearchRequest, type RetrievalPortHandle } from '../port';
import { bindingFailureDetail, hasBindingWork, runBindingLegs, type BindingEmbed, type BindingLegsOutput, type BindingLegsPlan } from './binding-legs';
import {
  hasTranslationWork,
  preferOriginalHits,
  runTranslationLegs,
  translationDetail,
  type TranslationLegsOutput,
  type TranslationLegsPlan,
} from '../translation-legs';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';
import type { SearchDelegate } from '../../query/port-types';

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
  /** A query framework fusing the variant lists through a scope-bound port (D-18); absent means native RRF. */
  searchDelegate?: SearchDelegate;
  /** Planned translation legs (XLG-04, D-30); absent or empty runs none. */
  translations?: TranslationLegsPlan;
}

function evalEmbeddingProfileId(input: RunRetrievalInput): string | undefined {
  return input.profile === 'eval' ? input.options?.embeddingProfile : undefined;
}

/** Embeds texts for the request's dense legs: the eval embedding profile when set, else the active one. */
export async function embedForRetrieval(input: RunRetrievalInput, texts: string[], signal: AbortSignal): Promise<QueryEmbedding[]> {
  const profileId = evalEmbeddingProfileId(input);
  if (texts.length === 1) {
    const [text] = texts;
    if (profileId) return [await embedQueryForEvalProfile(text!, signal, await getEmbeddingProfileById(profileId))];
    return [await embedQuery(text!, signal)];
  }
  if (profileId) return embedQueriesForEvalProfile(texts, signal, await getEmbeddingProfileById(profileId));
  return embedQueries(texts, signal);
}

/**
 * The embed step's batch (research A-2): texts with a precomputed vector (the semantic_cache stage's standalone) are left out
 * of the batch and filled in place, so the standalone is never embedded twice.
 */
export async function embedVariantTexts(
  input: RunRetrievalInput,
  texts: string[],
  signal: AbortSignal,
  precomputed?: ReadonlyMap<string, QueryEmbedding>,
): Promise<QueryEmbedding[]> {
  if (!precomputed || precomputed.size === 0) return embedForRetrieval(input, texts, signal);
  const missing = [...new Set(texts.filter((text) => !precomputed.has(text)))];
  const fresh = missing.length > 0 ? await embedForRetrieval(input, missing, signal) : [];
  const byText = new Map<string, QueryEmbedding>(precomputed);
  missing.forEach((text, index) => byText.set(text, fresh[index]!));
  return texts.map((text) => byText.get(text)!);
}

export const SEARCH_DELEGATE_ERROR = 'search_delegate_error';

/** A search delegate threw or returned something other than a list of chunk ids. */
export class SearchDelegateError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super('[RAG Search] search delegate failed');
    this.name = 'SearchDelegateError';
    this.original = original;
  }
}

function delegateFailureDetail(error: unknown): string | undefined {
  return error instanceof SearchDelegateError ? SEARCH_DELEGATE_ERROR : undefined;
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
    nonEmpty(filters.scopes) ||
    filters.effectiveOn !== undefined ||
    (invoice !== undefined && Object.values(invoice).some((value) => value !== undefined))
  );
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

export interface DelegatedFusion {
  handle: RetrievalPortHandle;
  order: string[];
}

const DELEGATE_LIST_ID = 'delegate';

/**
 * The delegate's order over the variant legs, scored by native RRF over the same lists. Exact-id and binding legs are
 * not visible to the delegate; when present they are fused natively with the delegate order as one ranked list.
 */
export function delegatedFusion(delegated: DelegatedFusion, extraLists: RankedList[], k: number): FusedHit[] {
  const ordered = delegated.handle.fusedHits(delegated.order);
  if (extraLists.length === 0) return ordered;
  const byId = new Map(ordered.map((row) => [row.hit.chunkId, row]));
  const delegateList: RankedList = {
    id: DELEGATE_LIST_ID,
    weight: 1,
    hits: ordered.map((row, index) => ({ ...row.hit, rank: index + 1 })),
  };
  return rrf([delegateList, ...extraLists], k).map((row) => {
    const extraRanks = Object.fromEntries(Object.entries(row.ranks).filter(([listId]) => listId !== DELEGATE_LIST_ID));
    const known = byId.get(row.hit.chunkId);
    return known ? { hit: known.hit, score: row.score, ranks: { ...known.ranks, ...extraRanks } } : { ...row, ranks: extraRanks };
  });
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

  const translations = hasTranslationWork(ctx.translations) ? ctx.translations : null;
  const originalText = variants.find((variant) => variant.kind === 'original')?.text ?? input.query;
  const runTranslations = (stageSignal: AbortSignal): Promise<TranslationLegsOutput | null> =>
    translations
      ? runTranslationLegs({
          backend,
          scope,
          plan: translations,
          queryText: originalText,
          queryEmbedding: embedding,
          embeddingProfileId: embedding.profile?.id ?? LEGACY_PROFILE.id,
          filters,
          params,
          lexicalEnabled: lexicalEnabled && verdict.icuAvailable,
          signal: stageSignal,
          timeoutMs: Math.max(1, searchSpec.timeoutMs - BINDING_STAGE_MARGIN_MS),
          ...(chunkingOverride ? { chunkingProfileOverride: chunkingOverride } : {}),
        })
      : Promise.resolve(null);

  const runDelegatedSearch = async (stageSignal: AbortSignal, delegate: SearchDelegate) => {
    const domainPending = runDomainLegs(stageSignal);
    const translationPending = runTranslations(stageSignal);
    const handle = createRetrievalPort({
      scope,
      backend,
      variants,
      filters,
      params,
      signal: stageSignal,
      // The embed stage already embedded every variant in one batch; the port reuses those vectors.
      embed: async () => variants.map((_variant, index) => ctx.variantEmbeddings?.[index] ?? embedding),
      lexicalEnabled: lexicalEnabled && verdict.icuAvailable,
      ...(chunkingOverride ? { chunkingProfileOverride: chunkingOverride } : {}),
    });
    let order: unknown;
    try {
      order = await delegate(handle.port);
    } catch (error) {
      throw new SearchDelegateError(error);
    }
    if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
      throw new SearchDelegateError(new TypeError('search delegate must return chunk ids'));
    }
    const legsByVariant = handle.collectedLegs();
    const domain = await domainPending;
    const translation = await translationPending;
    return {
      legsByVariant,
      denseTotal: legsByVariant.reduce((total, legs) => total + legs.dense.length, 0),
      lexicalTotal: legsByVariant.reduce((total, legs) => total + legs.lexical.length, 0),
      domain,
      translation,
      delegated: { handle, order: order as string[] } as DelegatedFusion | null,
    };
  };

  const runBackendSearch = async (stageSignal: AbortSignal) => {
    if (ctx.searchDelegate) return runDelegatedSearch(stageSignal, ctx.searchDelegate);
    let denseTotal = 0;
    let lexicalTotal = 0;
    const domainPending = runDomainLegs(stageSignal);
    const translationPending = runTranslations(stageSignal);
    const legsByVariant = await Promise.all(
      variants.map(async (variant, index) => {
        const legs = await backend.search(
          variantSearchRequest({
            scope,
            variant,
            embedding: ctx.variantEmbeddings?.[index] ?? embedding,
            filters,
            pool,
            lexicalEnabled: lexicalEnabled && verdict.icuAvailable,
            signal: stageSignal,
            chunkingProfileOverride: chunkingOverride,
          }),
        );
        denseTotal += legs.dense.length;
        lexicalTotal += legs.lexical.length;
        return legs;
      }),
    );
    const domain = await domainPending;
    const translation = await translationPending;
    return { legsByVariant, denseTotal, lexicalTotal, domain, translation, delegated: null as DelegatedFusion | null };
  };

  type SearchResult = Awaited<ReturnType<typeof runBackendSearch>>;

  const searchCounts = (value: {
    denseTotal: number;
    lexicalTotal: number;
    domain: BindingLegsOutput | null;
    translation: TranslationLegsOutput | null;
  }) => ({
    dense: value.denseTotal,
    lexical: value.lexicalTotal,
    ...(value.domain ? value.domain.counts : {}),
    ...(value.translation ? value.translation.counts : {}),
  });

  const extraFailed = (value: SearchResult): boolean =>
    (value.domain !== null && value.domain.failures.length > 0) || (value.translation !== null && value.translation.failures.length > 0);
  const extraDetail = (value: SearchResult): string | undefined => {
    const parts = [value.domain ? bindingFailureDetail(value.domain.failures) : undefined, translationDetail(value.translation)].filter(
      (part): part is string => part !== undefined,
    );
    return parts.length > 0 ? parts.join(';') : undefined;
  };

  let searchValue: Awaited<ReturnType<typeof runBackendSearch>>['legsByVariant'];
  let domainLists: RankedList[] = [];
  let translationOutput: TranslationLegsOutput | null = null;
  let delegated: DelegatedFusion | null = null;
  if (icuSkipLexical) {
    const startedAt = collector.now();
    let searched: SearchResult;
    try {
      searched = await runAgainstSignal(signal, runBackendSearch);
    } catch (error) {
      if (!(error instanceof SearchDelegateError) || signal.aborted) throw error;
      collector.record({
        name: 'search',
        status: 'error',
        reason: 'failed',
        startedAt,
        endedAt: collector.now(),
        detail: SEARCH_DELEGATE_ERROR,
      });
      throw new StageError('search', 'failed', error);
    }
    searchValue = searched.legsByVariant;
    domainLists = searched.domain?.lists ?? [];
    translationOutput = searched.translation;
    delegated = searched.delegated;
    const translationNote = translationDetail(searched.translation);
    collector.record({
      name: 'search',
      status: 'degraded',
      startedAt,
      endedAt: collector.now(),
      detail: translationNote ? `lexical_icu_unavailable;${translationNote}` : 'lexical_icu_unavailable',
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
          ...(ctx.searchDelegate ? { failureDetail: delegateFailureDetail } : {}),
          ...(bindings || translations
            ? {
                // D-19, D-30: a dropped binding or translation leg degrades the stage; the original legs and the answer continue.
                status: (value) => (extraFailed(value) ? 'degraded' : 'ok'),
                detail: extraDetail,
              }
            : {}),
        },
      ),
      'search',
    );
    searchValue = searched.legsByVariant;
    domainLists = searched.domain?.lists ?? [];
    translationOutput = searched.translation;
    delegated = searched.delegated;
  }
  // Mapped to source chunks before fusion; a chunk the original legs also found keeps the original hit (D-30).
  const translationLists =
    translationOutput && translationOutput.lists.length > 0 ? preferOriginalHits(translationOutput.lists, legHitsByChunkId(searchValue)) : [];

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
        const extraLists = [...(exactList ? [exactList] : []), ...domainLists, ...translationLists];
        let fusedHits: FusedHit[];
        if (delegated) {
          fusedHits = delegatedFusion(delegated, extraLists, params.rrf_k);
        } else {
          const lists = searchValue.flatMap((legs, index) => listsFromLegs(index, legs.dense, legs.lexical, params));
          lists.push(...extraLists);
          fusedHits = rrf(lists, params.rrf_k);
        }
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