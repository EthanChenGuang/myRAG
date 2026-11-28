import type { BackendLegs, BackendSearchRequest, RankedHit, RetrievalBackend, RetrievalFilters, VersionScope } from '../backend/types';
import { LEGACY_PROFILE } from '../embeddings/active-profile';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import { rrf, type FusedHit, type RankedList } from '../fusion/rrf';
import type { LexicalOptions } from '../lexical/options';
import { queryLexicalTokens } from '../lexical/tokenize';
import { variantDenseTexts } from '../query/variants';
import type { RetrievalPort, RetrievalPortHit, RetrievalPortLists, RetrievalPortVariant } from '../query/port-types';
import { scopeAccessFilter, type ScopeAccessFilter } from '../tenant/access';
import type { TenantScope } from '../tenant/scope';
import type { QueryVariant } from '../types';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';

export interface RetrievalPortContext {
  scope: TenantScope;
  backend: RetrievalBackend;
  variants: readonly QueryVariant[];
  filters: RetrievalFilters;
  params: RetrievalParams;
  signal: AbortSignal;
  /** Called once, with every variant's dense text, before the first search. */
  embed: (texts: string[]) => Promise<QueryEmbedding[]>;
  /** Lexical search on and available; a dense-only variant sends no lexical tokens either way. */
  lexicalEnabled: boolean;
  chunkingProfileOverride?: Record<string, string>;
  /** D-12: the effective non-current version scope; absent reads current versions. */
  versionScope?: Exclude<VersionScope, 'current'>;
  /** D-31: normalized identifiers every variant leg is filtered to; absent sends no filter. */
  identifiersNorm?: string[];
  /** D-18: factor on the dense leg weight for a variant of kind terminology; absent means 1. */
  terminologyDenseWeight?: number;
  /** LANG-07: the tenant's query-side lexical options; absent tokenizes with the defaults. */
  lexicalOptions?: LexicalOptions;
  /** D-05: the request's access filter, computed once by runRetrieval; absent reads it from the scope. */
  access?: ScopeAccessFilter;
  /** Phase 6.2 D-08: retries of empty filtered sub-question searches left within max_searches; absent allows none. */
  filterRetryBudget?: number;
}

/** Phase 6.2 D-08: how one filtered sub-question's search ended. */
export interface VariantFilterRetry {
  subQuestionIndex: number;
  retried: boolean;
  retrySkippedCap: boolean;
}

function intersectList(base: readonly string[] | undefined, narrowed: readonly string[] | undefined): string[] | undefined | null {
  if (!narrowed) return base ? [...base] : undefined;
  const kept = base ? narrowed.filter((value) => base.includes(value)) : [...narrowed];
  return kept.length > 0 ? kept : null;
}

function tagDimension(tag: string): string {
  const colon = tag.indexOf(':');
  return colon < 0 ? tag : tag.slice(0, colon);
}

/** Scope tags: OR within a dimension, AND across them (3.2 D-39); a dimension both filter keeps the common tags only. */
function intersectScopes(base: readonly string[] | undefined, narrowed: readonly string[] | undefined): string[] | undefined | null {
  if (!narrowed) return base ? [...base] : undefined;
  const baseTags = base ?? [];
  const baseDimensions = new Set(baseTags.map(tagDimension));
  const narrowedDimensions = new Set(narrowed.map(tagDimension));
  const kept = narrowed.filter((tag) => !baseDimensions.has(tagDimension(tag)) || baseTags.includes(tag));
  for (const dimension of narrowedDimensions) if (!kept.some((tag) => tagDimension(tag) === dimension)) return null;
  const untouched = baseTags.filter((tag) => !narrowedDimensions.has(tagDimension(tag)));
  return [...new Set([...untouched, ...kept])].sort();
}

/**
 * Phase 6.2 D-08: the filters a variant is searched with. The shared filters are the base; a filtered sub-question's date range,
 * doc types, languages and scope tags are intersected with them and every other field (current-only, documents, sources,
 * effective date, include flags) comes from the base, so the result never widens it. An empty intersection searches the base.
 */
export function applyVariantFilters(base: RetrievalFilters, variant: QueryVariant): RetrievalFilters {
  const narrowed = variant.filters;
  if (!narrowed || variant.filterApplied !== true) return base;
  let dateRange = base.dateRange;
  if (narrowed.dateRange) {
    const fromCandidates = [base.dateRange?.from, narrowed.dateRange.from].filter((value): value is string => value !== undefined);
    const toCandidates = [base.dateRange?.to, narrowed.dateRange.to].filter((value): value is string => value !== undefined);
    const from = fromCandidates.length > 0 ? fromCandidates.reduce((a, b) => (a > b ? a : b)) : undefined;
    const to = toCandidates.length > 0 ? toCandidates.reduce((a, b) => (a < b ? a : b)) : undefined;
    if (from !== undefined && to !== undefined && from > to) return base;
    dateRange = {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(base.dateRange?.includeUndated === true ? { includeUndated: true } : {}),
    };
  }
  const docTypes = intersectList(base.docTypes, narrowed.docTypes);
  const languages = intersectList(base.languages, narrowed.languages);
  const scopes = intersectScopes(base.scopes, narrowed.scopes);
  if (docTypes === null || languages === null || scopes === null) return base;
  const out: RetrievalFilters = {
    ...base,
    ...(dateRange ? { dateRange } : {}),
    ...(docTypes ? { docTypes } : {}),
    ...(languages ? { languages } : {}),
    ...(scopes ? { scopes } : {}),
  };
  return out;
}

/** Server-side view of a port: the search stage reads the collected legs; the framework only ever sees `port`. */
export interface RetrievalPortHandle {
  readonly port: RetrievalPort;
  /** Index-aligned with the variants; a variant nobody searched has empty legs. */
  collectedLegs(): BackendLegs[];
  /** The fused hits for an order, scored by native RRF over the collected lists; unknown and repeated ids are dropped. */
  fusedHits(fusedChunkIds: readonly string[]): FusedHit[];
  /** Phase 6.2 D-08: one entry per filtered variant the framework searched, in variant order. */
  filterRetries(): VariantFilterRetry[];
}

function lexicalLanguagesFor(variant: QueryVariant): string[] | null {
  return variant.kind === 'translated' && variant.language ? [variant.language] : null;
}

/** A translated variant is stemmed in its own language, never in the question's. */
function variantLexicalOptions(options: LexicalOptions | undefined, variant: QueryVariant): LexicalOptions | undefined {
  if (!options?.stemIt || variant.kind !== 'translated' || !variant.language) return options;
  return { ...options, language: variant.language };
}

/** The one backend request a variant makes, shared by the native search and the port. */
export function variantSearchRequest(args: {
  scope: TenantScope;
  variant: QueryVariant;
  embedding: QueryEmbedding;
  filters: RetrievalFilters;
  pool: number;
  lexicalEnabled: boolean;
  signal: AbortSignal;
  chunkingProfileOverride?: Record<string, string> | null;
  /** D-12: set only for a non-current effective scope, so a default request sends today's request object. */
  versionScope?: VersionScope;
  /** D-31: set only while the identifier filter applies, so a default request sends today's request object. */
  identifiersNorm?: string[];
  /** LANG-07: the tenant's query-side lexical options; absent tokenizes with the defaults. */
  lexicalOptions?: LexicalOptions;
  /** D-05: absent reads scopeAccessFilter(scope). */
  access?: ScopeAccessFilter;
}): BackendSearchRequest {
  const { variant, embedding } = args;
  // P-6: a dense-only variant (HyDE) sends no lexical tokens, so it contributes no lexical list.
  // D-18: a terminology variant is dense-only whether or not it carries the legs field.
  const useLexical = args.lexicalEnabled && variant.legs !== 'dense' && variant.kind !== 'terminology';
  return {
    scope: args.scope,
    embeddingProfileId: embedding.profile?.id ?? LEGACY_PROFILE.id,
    denseVector: embedding.vector,
    lexicalTokens: useLexical ? queryLexicalTokens(variant.text, variantLexicalOptions(args.lexicalOptions, variant)) : [],
    lexicalLanguages: lexicalLanguagesFor(variant),
    filters: args.filters,
    access: args.access ?? scopeAccessFilter(args.scope),
    denseLimit: args.pool,
    lexicalLimit: args.pool,
    signal: args.signal,
    ...(args.chunkingProfileOverride ? { chunkingProfileOverride: args.chunkingProfileOverride } : {}),
    ...(args.versionScope !== undefined && args.versionScope !== 'current' ? { versionScope: args.versionScope } : {}),
    ...(args.identifiersNorm !== undefined ? { identifiersNorm: [...args.identifiersNorm] } : {}),
  };
}

/** denseFactor scales the dense leg weight in force for this variant's dense list (D-18: the terminology variant); 1 otherwise. */
export function listsFromLegs(
  variantIndex: number,
  dense: RankedHit[],
  lexical: RankedHit[],
  params: RetrievalParams,
  denseFactor = 1,
): RankedList[] {
  const lists: RankedList[] = [];
  const weights = params.leg_weights ?? { dense: 1, lexical: 1, exact_id: 1 };
  if (dense.length > 0) {
    lists.push({ id: `dense:${variantIndex}`, weight: weights.dense * denseFactor, hits: dense });
  }
  if (lexical.length > 0) {
    lists.push({ id: `lexical:${variantIndex}`, weight: weights.lexical, hits: lexical });
  }
  return lists;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function rankedIds(hits: readonly RankedHit[]): string[] {
  return [...hits].sort((a, b) => a.rank - b.rank).map((hit) => hit.chunkId);
}

function uniqueKnown<T>(ids: readonly string[], known: ReadonlyMap<string, T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    const value = known.get(id);
    if (value === undefined) continue;
    seen.add(id);
    out.push(value);
  }
  return out;
}

export function createRetrievalPort(ctx: RetrievalPortContext): RetrievalPortHandle {
  const { scope, backend, filters, params, signal, embed, lexicalEnabled } = ctx;
  const variants = [...ctx.variants];
  const searches = new Map<number, Promise<BackendLegs>>();
  const collected = new Map<number, BackendLegs>();
  const retryEntries = new Map<number, VariantFilterRetry>();
  let retryBudget = Math.max(0, ctx.filterRetryBudget ?? 0);
  let embeddings: Promise<QueryEmbedding[]> | null = null;

  const embedAll = (): Promise<QueryEmbedding[]> => {
    embeddings ??= embed(variantDenseTexts(variants)).then((out) => {
      if (out.length !== variants.length) throw new Error('[RAG Port] embedding count does not match the variants');
      return out;
    });
    return embeddings;
  };

  const search = (index: number): Promise<BackendLegs> => {
    const memo = searches.get(index);
    if (memo) return memo;
    const pending = embedAll().then(async (vectors) => {
      signal.throwIfAborted();
      const variant = variants[index]!;
      const request = (variantFilters: RetrievalFilters) =>
        variantSearchRequest({
          scope,
          variant,
          embedding: vectors[index]!,
          filters: variantFilters,
          pool: params.candidate_pool_size,
          lexicalEnabled,
          signal,
          chunkingProfileOverride: ctx.chunkingProfileOverride ?? null,
          ...(ctx.versionScope !== undefined ? { versionScope: ctx.versionScope } : {}),
          ...(ctx.identifiersNorm !== undefined ? { identifiersNorm: ctx.identifiersNorm } : {}),
          ...(ctx.lexicalOptions ? { lexicalOptions: ctx.lexicalOptions } : {}),
          ...(ctx.access ? { access: ctx.access } : {}),
        });
      // D-08: a filtered sub-question searches its narrowed filter and, when that finds nothing, once more with the shared filters.
      const variantFilters = applyVariantFilters(filters, variant);
      let legs = await backend.search(request(variantFilters));
      if (variantFilters !== filters) {
        const entry: VariantFilterRetry = { subQuestionIndex: variant.subQuestionIndex ?? index, retried: false, retrySkippedCap: false };
        retryEntries.set(index, entry);
        if (legs.dense.length + legs.lexical.length === 0) {
          if (retryBudget > 0) {
            retryBudget -= 1;
            entry.retried = true;
            signal.throwIfAborted();
            legs = await backend.search(request(filters));
          } else {
            entry.retrySkippedCap = true;
          }
        }
      }
      collected.set(index, legs);
      return legs;
    });
    searches.set(index, pending);
    return pending;
  };

  const searchVariant = async (index: number): Promise<RetrievalPortLists> => {
    if (signal.aborted) throw abortError(signal);
    if (!Number.isInteger(index) || index < 0 || index >= variants.length) {
      throw new RangeError('[RAG Port] no variant at this index');
    }
    const legs = await search(index);
    if (signal.aborted) throw abortError(signal);
    return Object.freeze({ dense: Object.freeze(rankedIds(legs.dense)), lexical: Object.freeze(rankedIds(legs.lexical)) });
  };

  const collectedLegs = (): BackendLegs[] => variants.map((_variant, index) => collected.get(index) ?? { dense: [], lexical: [] });

  const fusedById = (): Map<string, FusedHit> => {
    const lists = [...collected.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([index, legs]) =>
        listsFromLegs(index, legs.dense, legs.lexical, params, variants[index]?.kind === 'terminology' ? (ctx.terminologyDenseWeight ?? 1) : 1),
      );
    return new Map(rrf(lists, params.rrf_k).map((row) => [row.hit.chunkId, row]));
  };

  const fusedHits = (fusedChunkIds: readonly string[]): FusedHit[] => uniqueKnown(fusedChunkIds, fusedById());

  const finishRetrieval = (fusedChunkIds: readonly string[]): RetrievalPortHit[] =>
    fusedHits(fusedChunkIds).map((row) => Object.freeze({ chunkId: row.hit.chunkId, legs: Object.freeze({ ...row.ranks }) }));

  const portVariants: readonly RetrievalPortVariant[] = Object.freeze(
    variants.map((variant, index) =>
      Object.freeze({ index, text: variant.text, kind: variant.kind, legs: variant.legs === 'dense' ? ('dense' as const) : ('both' as const) }),
    ),
  );

  const port: RetrievalPort = Object.freeze({ variants: portVariants, searchVariant, finishRetrieval });
  const filterRetries = (): VariantFilterRetry[] =>
    [...retryEntries.entries()].sort(([a], [b]) => a - b).map(([, entry]) => ({ ...entry }));
  return Object.freeze({ port, collectedLegs, fusedHits, filterRetries });
}
