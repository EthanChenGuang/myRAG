import type { RpcClient } from '../../backend/supabase-rpc';
import { backendForRequest, getRetrievalBackend } from '../../backend/registry';
import type { BackendLegs, RankedHit, RetrievalFilters, VersionScope } from '../../backend/types';
import type { AssemblyDocumentRow, TableRowAttachment } from '../../context/assemble';
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
import { exactIdStage } from '../../retrieval/exact-id';
import { identifierSuggestions, resolveQueryIdentifiers, type QueryIdentifiers } from '../../retrieval/identifiers';
import { loadTenantIdentifierPatterns } from '../../identifiers/patterns';
import { tableLookupStage, type TableLookupRow } from '../../retrieval/table-lookup';
import type { LexicalOptions } from '../../lexical/options';
import type { LexicalStamp } from '../../lexical/resolve-options';
import { scopeKey, type TenantScope } from '../../tenant/scope';
import type { TraceCollector } from '../../trace/collector';
import type { Profile, QueryVariant, RunRetrievalInput, StageOverrides } from '../../types';
import { getV2StartupVerdict } from '../startup';
import { terminologyParams } from '../../terminology/expand';
import { reserveTerminologyHits } from '../../terminology/reserve';
import { evalChunkingOverride, evalTuningOverrides } from '../overrides';
import { effectiveTuningParams } from '../tuning-params';
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
import { effectiveVersionScope } from '../../query/filters';

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
  /** D-16: the terminology stage's expansion; non-empty tokens add one lexical-only term:0 list. */
  terminology?: { tokens: readonly string[]; expansionWeight: number; reserveSlots?: number } | null;
  /** D-18: factor on the dense leg weight for a variant of kind terminology; absent reads TerminologyParams.dense_weight. */
  terminologyDenseWeight?: number;
  /** LANG-07 (D-08, D-09): resolved once per request; present only while a lexical option switch is on. */
  lexical?: QueryLexicalOptions;
}

/** The request's query-side lexical options and what they were built from. */
export interface QueryLexicalOptions {
  options: LexicalOptions | undefined;
  stamp: LexicalStamp;
  /** True when the dictionary could not be loaded (resolver failure or lexical_dictionary_unavailable). */
  unavailable: boolean;
}

export const LEXICAL_DICT_UNAVAILABLE = 'dict=unavailable';
const STALE_COUNT_RPC = 'rag_lexical_stale_count';
const STALE_COUNT_TTL_MS = 60_000;
const STALE_COUNT_TIMEOUT_MS = 250;
const staleCounts = new Map<string, { value: number; at: number }>();

export function resetLexicalStaleCountForTests(): void {
  staleCounts.clear();
}

/** A scalar function answers a bare value (PostgREST, bigint as text) or one row keyed by the function name. */
function staleCountValue(data: unknown): number | null {
  const row = Array.isArray(data) ? data[0] : data;
  const raw = row !== null && typeof row === 'object' ? (row as Record<string, unknown>)[STALE_COUNT_RPC] : row;
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** D-09: chunks of the tenant not yet relexed with this dictionary version; null when the count failed or took too long. */
async function lexicalStaleCount(scope: TenantScope, version: string, signal: AbortSignal): Promise<number | null> {
  const tenantKey = scopeKey(scope);
  const key = `${tenantKey}|${version}`;
  const cached = staleCounts.get(key);
  if (cached && Date.now() - cached.at < STALE_COUNT_TTL_MS) return cached.value;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = requireAdminSearchClient(getRagDeps());
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, STALE_COUNT_TIMEOUT_MS);
    });
    const call = Promise.resolve(client.rpc(STALE_COUNT_RPC, { p_tenant_key: tenantKey, p_dict_version: version }).abortSignal(controller.signal)).then(
      (response) => (response.error ? null : staleCountValue(response.data)),
      () => null,
    );
    const value = await Promise.race([call, timeout]);
    if (value !== null) staleCounts.set(key, { value, at: Date.now() });
    return value;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/** D-09: `dict=<version> stale_chunks=<n|unknown>` or `dict=unavailable`; a version string and a count, never a term. */
function lexicalDictionaryDetail(lexical: QueryLexicalOptions, staleCount: number | null): string {
  const version = lexical.stamp.dictVersion;
  if (lexical.unavailable || version === null) return LEXICAL_DICT_UNAVAILABLE;
  return `dict=${version} stale_chunks=${staleCount ?? 'unknown'}`;
}

/** D-16: the expansion list id; no dense/lexical prefix, so nothing that inspects list ids by prefix counts it as a leg. */
export const TERMINOLOGY_LIST_ID = 'term:0';

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
  /** D-12: the version scope this request read; the context stage and later legs read this one value. */
  versionScope: VersionScope;
  /** D-17: the matched table row per chunk of the table:0 list; absent when the list is empty. */
  tableRows?: ReadonlyMap<string, TableRowAttachment>;
  /** D-31: the identifier_resolve outcome; absent while RAG_IDENTIFIER_FILTER is off or the stage did not run. */
  identifiers?: SearchIdentifiers;
}

/** D-31, D-51: what the identifier_resolve stage found, for the rank (guard) and context (suggestion line) stages and the result. */
export interface SearchIdentifiers {
  /** Normalized forms the question names (at most 16). */
  asked: string[];
  found: string[];
  missing: string[];
  /** True when the legs were filtered to chunks carrying a found identifier. */
  filtered: boolean;
  /** True when the filtered search found nothing and the unfiltered search ran instead. */
  fallback: boolean;
  /** True when the question names identifiers and none exists in the tenant. */
  notFound: boolean;
  /** At most 3 raw spellings from the caller's tenant; set only when notFound. */
  suggestions: string[];
  /** The tenant's compiled patterns, so the guard reads candidates as ingestion indexed them. */
  patterns: readonly RegExp[];
}

/** D-12, D-40: fixed trace codes of the search stage detail. */
export const VERSIONS_IGNORED = 'versions_ignored';
export const SUPERSEDED_DENSE_UNAVAILABLE = 'superseded_dense_unavailable';
export const BACKEND_FIELD_UNSUPPORTED = 'backend_field_unsupported';
/** D-45: the table_lookup stage detail when a narrowing filter makes it stand down. */
export const TABLE_LOOKUP_NARROWED = 'narrowing_filters';
export const TABLE_LIST_ID = 'table:0';
/** D-31: fixed codes of the identifier_resolve and search stage details. */
export const IDENTIFIER_FILTER_FALLBACK = 'identifier_filter_fallback';
export const IDENTIFIER_RESOLVE_FAILED = 'identifier_resolve_failed';

function buildFilters(input: RunRetrievalInput): RetrievalFilters {
  const { versionScope: _versionScope, ...extra } = input.retrievalFilters ?? {};
  return { currentOnly: true, ...extra };
}

function joinDetail(parts: readonly (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => part !== undefined && part.length > 0);
  return present.length > 0 ? present.join(';') : undefined;
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

/** The fields a lookup leg's row shares with a search hit: exact-id and table rows alike. */
interface LookupRow {
  chunk_id: string;
  document_id: string;
  content: string;
  metadata: Record<string, unknown> | null;
}

function hitFromLookupRow(
  row: LookupRow,
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

async function lookupRankedList(
  id: string,
  weight: number,
  rows: LookupRow[],
  legsByVariant: BackendLegs[],
  signal: AbortSignal,
): Promise<RankedList | null> {
  if (rows.length === 0) return null;
  const known = legHitsByChunkId(legsByVariant);
  const missing: LookupRow[] = [];
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
    hits.push(hitFromLookupRow(row, rank, undefined, row.metadata));
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
      hits[hitIndex] = hitFromLookupRow(row, index + 1, assembly.documents.get(row.document_id), assembly.chunkMetadata.get(row.chunk_id));
    }
  }
  return { id, weight, hits };
}

/** One hit per matched row, its first qualifying chunk; a chunk two rows share is listed once, with the better row. */
function tableListRows(rows: TableLookupRow[]): { rows: TableLookupRow[]; attachments: Map<string, TableRowAttachment> } {
  const attachments = new Map<string, TableRowAttachment>();
  const kept: TableLookupRow[] = [];
  for (const row of rows) {
    if (attachments.has(row.chunk_id)) continue;
    attachments.set(row.chunk_id, { header: row.header, cells: row.cells });
    kept.push(row);
  }
  return { rows: kept, attachments };
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
  // D-58: the embed channel (set server-side by the embed route) also needs config.v2.embedVersionScope; the rule lives in effectiveVersionScope.
  const versions = effectiveVersionScope(config, profile, input.retrievalFilters?.versionScope, input.channel);
  const historyScope = versions.scope === 'current' ? undefined : versions.scope;
  const versionScopeArg = historyScope ? { versionScope: historyScope } : {};
  // D-18, D-34: the terminology variant's dense list weighs dense_weight × the dense leg weight in force, read at run time.
  const terminologyDenseWeight = ctx.terminologyDenseWeight ?? terminologyParams().dense_weight;
  const denseFactor = (index: number): number => (variants[index]?.kind === 'terminology' ? terminologyDenseWeight : 1);
  const lexical = ctx.lexical;
  const lexicalOptionsArg = lexical?.options ? { lexicalOptions: lexical.options } : {};
  const dictionaryDetailOn = config.v2.lexicalDictionary && lexical !== undefined;
  const dictVersion = dictionaryDetailOn && !lexical.unavailable ? lexical.stamp.dictVersion : null;
  // Started before the legs so the count runs beside the search; bounded by STALE_COUNT_TIMEOUT_MS.
  const stalePending: Promise<number | null> = dictVersion ? lexicalStaleCount(scope, dictVersion, signal) : Promise.resolve(null);
  const lexicalDetail = async (): Promise<string | undefined> =>
    dictionaryDetailOn ? lexicalDictionaryDetail(lexical, await stalePending) : undefined;
  const identifiers = config.v2.identifierFilter ? await runIdentifierResolve(ctx) : null;
  const filterIdentifiers = identifiers && identifiers.found.length > 0 ? identifiers.found : undefined;

  // D-31: with found identifiers every leg is first filtered to chunks carrying one; an empty filtered search reruns once without it.
  const runLegs = async (identifiersNorm: string[] | undefined, legCodes: readonly string[]) => {
    const identifierArg = identifiersNorm ? { identifiersNorm } : {};
    const route =
      historyScope || identifiersNorm
        ? backendForRequest({ ...(historyScope ? { versionScope: historyScope } : {}), ...identifierArg })
        : { backend: getRetrievalBackend() };
    const backend = route.backend;
    const versionCodes = [
      versions.ignored ? VERSIONS_IGNORED : undefined,
      historyScope ? SUPERSEDED_DENSE_UNAVAILABLE : undefined,
      route.reason === 'backend_field_unsupported' ? BACKEND_FIELD_UNSUPPORTED : undefined,
      ...legCodes,
    ];
    const versionDegraded = route.reason === 'backend_field_unsupported';
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
            ...identifierArg,
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

    // D-16: one lexical-only call (no vector, dense limit 0) under the same scope, filters and chunking override as the other legs.
    const termTokens = ctx.terminology && lexicalEnabled && verdict.icuAvailable ? [...ctx.terminology.tokens] : [];
    const runTermLeg = (stageSignal: AbortSignal): Promise<RankedHit[] | null> =>
      termTokens.length > 0
        ? backend
            .search({
              scope,
              embeddingProfileId: embedding.profile?.id ?? LEGACY_PROFILE.id,
              denseVector: null,
              lexicalTokens: termTokens,
              lexicalLanguages: null,
              filters,
              denseLimit: 0,
              lexicalLimit: pool,
              signal: stageSignal,
              ...(chunkingOverride ? { chunkingProfileOverride: chunkingOverride } : {}),
              ...versionScopeArg,
              ...identifierArg,
            })
            .then((legs) => legs.lexical)
        : Promise.resolve(null);

    const runDelegatedSearch = async (stageSignal: AbortSignal, delegate: SearchDelegate) => {
      const domainPending = runDomainLegs(stageSignal);
      const translationPending = runTranslations(stageSignal);
      const termPending = runTermLeg(stageSignal);
      // Awaited below; a delegate failure first must not leave the term call's rejection unhandled.
      termPending.catch(() => undefined);
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
        ...versionScopeArg,
        ...identifierArg,
        terminologyDenseWeight,
        ...lexicalOptionsArg,
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
      const term = await termPending;
      return {
        legsByVariant,
        denseTotal: legsByVariant.reduce((total, legs) => total + legs.dense.length, 0),
        lexicalTotal: legsByVariant.reduce((total, legs) => total + legs.lexical.length, 0),
        domain,
        translation,
        term,
        delegated: { handle, order: order as string[] } as DelegatedFusion | null,
        lexicalDetail: await lexicalDetail(),
      };
    };

    const runBackendSearch = async (stageSignal: AbortSignal) => {
      if (ctx.searchDelegate) return runDelegatedSearch(stageSignal, ctx.searchDelegate);
      let denseTotal = 0;
      let lexicalTotal = 0;
      const domainPending = runDomainLegs(stageSignal);
      const translationPending = runTranslations(stageSignal);
      const [term, ...legsByVariant] = await Promise.all([
        runTermLeg(stageSignal),
        ...variants.map(async (variant, index) => {
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
              ...versionScopeArg,
              ...identifierArg,
              ...lexicalOptionsArg,
            }),
          );
          denseTotal += legs.dense.length;
          lexicalTotal += legs.lexical.length;
          return legs;
        }),
      ]) as [RankedHit[] | null, ...BackendLegs[]];
      const domain = await domainPending;
      const translation = await translationPending;
      return {
        legsByVariant,
        denseTotal,
        lexicalTotal,
        domain,
        translation,
        term,
        delegated: null as DelegatedFusion | null,
        lexicalDetail: await lexicalDetail(),
      };
    };

    type SearchResult = Awaited<ReturnType<typeof runBackendSearch>>;

    const searchCounts = (value: {
      legsByVariant: BackendLegs[];
      denseTotal: number;
      lexicalTotal: number;
      domain: BindingLegsOutput | null;
      translation: TranslationLegsOutput | null;
      term: RankedHit[] | null;
    }) => ({
      dense: value.denseTotal,
      lexical: value.lexicalTotal,
      ...(value.domain ? value.domain.counts : {}),
      ...(value.translation ? value.translation.counts : {}),
      ...(value.term ? { term: value.term.length } : {}),
      ...(historyScope ? { superseded: supersededCount(value) } : {}),
    });

    const extraFailed = (value: SearchResult): boolean =>
      (value.domain !== null && value.domain.failures.length > 0) || (value.translation !== null && value.translation.failures.length > 0);
    const extraDetail = (value: SearchResult): string | undefined =>
      joinDetail([value.domain ? bindingFailureDetail(value.domain.failures) : undefined, translationDetail(value.translation), value.lexicalDetail]);
    const hasVersionCodes = versionCodes.some((code) => code !== undefined);

    let searchValue: Awaited<ReturnType<typeof runBackendSearch>>['legsByVariant'];
    let domainLists: RankedList[] = [];
    let translationOutput: TranslationLegsOutput | null = null;
    let delegated: DelegatedFusion | null = null;
    let termHits: RankedHit[] | null = null;
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
      termHits = searched.term;
      collector.record({
        name: 'search',
        status: 'degraded',
        startedAt,
        endedAt: collector.now(),
        detail: joinDetail(['lexical_icu_unavailable', translationDetail(searched.translation), searched.lexicalDetail, ...versionCodes])!,
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
            ...(bindings || translations || hasVersionCodes || dictionaryDetailOn
              ? {
                  // D-19, D-30: a dropped binding or translation leg degrades the stage; the original legs and the answer continue.
                  // D-12: a backend that cannot serve the version scope is replaced by pgvector and degrades the stage too.
                  status: (value) => (extraFailed(value) || versionDegraded ? 'degraded' : 'ok'),
                  detail: (value) => joinDetail([extraDetail(value), ...versionCodes]),
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
      termHits = searched.term;
    }
    // Mapped to source chunks before fusion; a chunk the original legs also found keeps the original hit (D-30).
    // D-31: translation hits cannot be filtered in SQL; while filtered only chunks the filtered legs also found are kept.
    const knownHits = legHitsByChunkId(searchValue);
    const translationLists =
      translationOutput && translationOutput.lists.length > 0
        ? preferOriginalHits(translationOutput.lists, knownHits)
            .map((list) => (identifiersNorm ? { ...list, hits: list.hits.filter((hit) => knownHits.has(hit.chunkId)) } : list))
            .filter((list) => !identifiersNorm || list.hits.length > 0)
        : [];

    let exactList: RankedList | null = null;
    if (config.exactIdLookup) {
      // rag_exact_id_documents takes no filter arguments, so while a request narrows the search the leg stands down rather than widen it.
      const exactSpec = spec('exact_id_lookup', 'skip');
      const exact = await runStage(
        hasNarrowingFilters(filters) ? { ...exactSpec, enabled: false } : exactSpec,
        signal,
        (stageSignal) =>
          exactIdStage(input.query, scope, {
            client: requireAdminSearchClient(getRagDeps()),
            signal: stageSignal,
            limit: pool,
            ...versionScopeArg,
            ...identifierArg,
          }),
        collector,
        {
          candidatesIn: searchValue.reduce((total, legs) => total + legs.dense.length + legs.lexical.length, 0),
          candidatesOut: (value) => value.rows.length,
          detail: (value) => `tokens=${value.tokenCount}`,
        },
      );
      if (!exact.skipped && exact.value.rows.length > 0) {
        exactList = await lookupRankedList('exact_id', params.leg_weights?.exact_id ?? 1, exact.value.rows, searchValue, signal);
      }
    }

    // D-16, D-45: the structured table leg, one deterministic list of matched rows' chunks. It takes no filter arguments either, so a
    // narrowing filter makes it stand down; the version scope is passed through.
    let tableList: RankedList | null = null;
    let tableRows: Map<string, TableRowAttachment> | undefined;
    if (config.v2.tableLookup) {
      const tableSpec = spec('table_lookup', 'skip');
      const candidatesIn = searchValue.reduce((total, legs) => total + legs.dense.length + legs.lexical.length, 0);
      if (tableSpec.enabled && hasNarrowingFilters(filters)) {
        const at = collector.now();
        collector.record({ name: 'table_lookup', status: 'disabled', reason: 'disabled', startedAt: at, endedAt: at, candidatesIn, detail: TABLE_LOOKUP_NARROWED });
      } else {
        const tuning = effectiveTuningParams(profile, config, evalTuningOverrides(profile, input.stageOverrides?.retrievalOverrides)).tableLookup;
        const table = await runStage(
          tableSpec,
          signal,
          (stageSignal) =>
            tableLookupStage(input.query, scope, tuning, {
              client: requireAdminSearchClient(getRagDeps()),
              signal: stageSignal,
              ...versionScopeArg,
              ...identifierArg,
            }),
          collector,
          {
            candidatesIn,
            candidatesOut: (value) => value.rows.length,
            detail: (value) => `tokens=${value.tokenCount} rows=${value.rows.length}`,
          },
        );
        if (!table.skipped && table.value.rows.length > 0) {
          const listed = tableListRows(table.value.rows);
          tableList = await lookupRankedList(TABLE_LIST_ID, tuning.weight, listed.rows, searchValue, signal);
          if (tableList) tableRows = listed.attachments;
        }
      }
    }

    const found =
      searchValue.reduce((total, legs) => total + legs.dense.length + legs.lexical.length, 0) +
      (termHits?.length ?? 0) +
      domainLists.reduce((total, list) => total + list.hits.length, 0) +
      translationLists.reduce((total, list) => total + list.hits.length, 0) +
      (exactList?.hits.length ?? 0) +
      (tableList?.hits.length ?? 0);
    return { searchValue, domainLists, translationLists, delegated, termHits, exactList, tableList, tableRows, found };
  };

  let legs = await runLegs(filterIdentifiers, []);
  let fallback = false;
  if (filterIdentifiers && legs.found === 0) {
    fallback = true;
    legs = await runLegs(undefined, [IDENTIFIER_FILTER_FALLBACK]);
  }
  const { searchValue, domainLists, translationLists, delegated, termHits, exactList, tableList, tableRows } = legs;

  // D-16: weight = expansion_weight × the lexical leg weight in force, so the list stays a fraction of the lexical leg.
  const termList: RankedList | null =
    termHits && termHits.length > 0 && ctx.terminology
      ? { id: TERMINOLOGY_LIST_ID, weight: ctx.terminology.expansionWeight * (params.leg_weights?.lexical ?? 1), hits: termHits }
      : null;

  const fused = requireValue(
    await runStage(
      spec('fuse', 'throw'),
      signal,
      () => {
        const extraLists = [...(exactList ? [exactList] : []), ...(tableList ? [tableList] : []), ...domainLists, ...translationLists, ...(termList ? [termList] : [])];
        let fusedHits: FusedHit[];
        if (delegated) {
          fusedHits = delegatedFusion(delegated, extraLists, params.rrf_k);
        } else {
          const lists = searchValue.flatMap((legs, index) => listsFromLegs(index, legs.dense, legs.lexical, params, denseFactor(index)));
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

  // D-34: bounded rerank-input places for term:0-only hits; absent reserveSlots reads TerminologyParams.reserve_slots.
  const reserve = (result: DedupeResult): DedupeResult =>
    termList && ctx.terminology
      ? reserveTerminologyHits(result, fused, termList.hits, {
          reserveSlots: ctx.terminology.reserveSlots ?? terminologyParams().reserve_slots,
          byParent: config.v2.parentChild,
        })
      : result;

  const deduped = await runStage(
    spec('dedupe', 'skip'),
    signal,
    () => reserve(dedupeAndCap(fused, { byParent: config.v2.parentChild, cap: params.rerank_input_cap })),
    collector,
    {
      candidatesIn: fused.length,
      candidatesOut: (value) => value.hits.length,
      counts: (value) => ({ ...value.counts }),
    },
  );

  const capped = deduped.skipped ? reserve(sliceCap(fused, params.rerank_input_cap)) : deduped.value;

  return {
    fusedHits: capped.hits,
    dedupeCounts: capped.counts,
    versionScope: versions.scope,
    ...(tableRows ? { tableRows } : {}),
    ...(identifiers ? { identifiers: { ...identifiers, filtered: filterIdentifiers !== undefined && !fallback, fallback } } : {}),
  };
}

type ResolvedIdentifiers = Omit<SearchIdentifiers, 'filtered' | 'fallback'>;

interface IdentifierResolveValue {
  ok: boolean;
  resolved: QueryIdentifiers;
  patterns: readonly RegExp[];
  suggestions: string[];
}

/**
 * D-31: the optional identifier_resolve stage. The tenant's patterns and the resolve call use the scope only; a failure skips the filter
 * and degrades the stage with a fixed code. Detail and counts carry numbers only, never an identifier (D-34).
 */
async function runIdentifierResolve(ctx: SearchStagesInput): Promise<ResolvedIdentifiers | null> {
  const { input, scope, config, profile, signal, collector, stageOverrides } = ctx;
  const outcome = await runStage(
    stageSpec(config, profile, 'identifier_resolve', 'skip', stageOverrides),
    signal,
    async (stageSignal): Promise<IdentifierResolveValue> => {
      const { expressions } = await loadTenantIdentifierPatterns(scope, { signal: stageSignal });
      try {
        const client = requireAdminSearchClient(getRagDeps());
        const resolved = await resolveQueryIdentifiers(scope, input.query, expressions, { client, signal: stageSignal });
        const notFound = resolved.asked.length > 0 && resolved.found.length === 0;
        const suggestions = notFound ? await identifierSuggestions(scope, resolved.missing, { client, signal: stageSignal }) : [];
        return { ok: true, resolved, patterns: expressions, suggestions };
      } catch (error) {
        if (stageSignal.aborted) throw error;
        return { ok: false, resolved: { asked: [], found: [], missing: [] }, patterns: expressions, suggestions: [] };
      }
    },
    collector,
    {
      status: (value) => (value.ok ? 'ok' : 'degraded'),
      detail: (value) =>
        value.ok
          ? `asked=${value.resolved.asked.length} found=${value.resolved.found.length} filtered=${value.resolved.found.length > 0}`
          : IDENTIFIER_RESOLVE_FAILED,
      counts: (value) => ({
        asked: value.resolved.asked.length,
        found: value.resolved.found.length,
        missing: value.resolved.missing.length,
        suggestions: value.suggestions.length,
      }),
    },
  );
  if (outcome.skipped || !outcome.value.ok) return null;
  const { resolved, patterns, suggestions } = outcome.value;
  return {
    asked: resolved.asked.map((entry) => entry.norm),
    found: resolved.found,
    missing: resolved.missing,
    notFound: resolved.asked.length > 0 && resolved.found.length === 0,
    suggestions,
    patterns,
  };
}

function supersededCount(value: { legsByVariant: BackendLegs[]; term: RankedHit[] | null }): number {
  const ids = new Set<string>();
  for (const legs of value.legsByVariant) for (const hit of [...legs.dense, ...legs.lexical]) if (hit.isCurrent === false) ids.add(hit.chunkId);
  for (const hit of value.term ?? []) if (hit.isCurrent === false) ids.add(hit.chunkId);
  return ids.size;
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