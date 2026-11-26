import type { BackendLegs, BackendSearchRequest, RankedHit, RetrievalBackend, RetrievalFilters } from '../backend/types';
import { LEGACY_PROFILE } from '../embeddings/active-profile';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import { rrf, type FusedHit, type RankedList } from '../fusion/rrf';
import { queryLexicalTokens } from '../lexical/tokenize';
import { variantDenseTexts } from '../query/variants';
import type { RetrievalPort, RetrievalPortHit, RetrievalPortLists, RetrievalPortVariant } from '../query/port-types';
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
  /** D-18: factor on the dense leg weight for a variant of kind terminology; absent means 1. */
  terminologyDenseWeight?: number;
}

/** Server-side view of a port: the search stage reads the collected legs; the framework only ever sees `port`. */
export interface RetrievalPortHandle {
  readonly port: RetrievalPort;
  /** Index-aligned with the variants; a variant nobody searched has empty legs. */
  collectedLegs(): BackendLegs[];
  /** The fused hits for an order, scored by native RRF over the collected lists; unknown and repeated ids are dropped. */
  fusedHits(fusedChunkIds: readonly string[]): FusedHit[];
}

function lexicalLanguagesFor(variant: QueryVariant): string[] | null {
  return variant.kind === 'translated' && variant.language ? [variant.language] : null;
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
}): BackendSearchRequest {
  const { variant, embedding } = args;
  // P-6: a dense-only variant (HyDE) sends no lexical tokens, so it contributes no lexical list.
  // D-18: a terminology variant is dense-only whether or not it carries the legs field.
  const useLexical = args.lexicalEnabled && variant.legs !== 'dense' && variant.kind !== 'terminology';
  return {
    scope: args.scope,
    embeddingProfileId: embedding.profile?.id ?? LEGACY_PROFILE.id,
    denseVector: embedding.vector,
    lexicalTokens: useLexical ? queryLexicalTokens(variant.text) : [],
    lexicalLanguages: lexicalLanguagesFor(variant),
    filters: args.filters,
    denseLimit: args.pool,
    lexicalLimit: args.pool,
    signal: args.signal,
    ...(args.chunkingProfileOverride ? { chunkingProfileOverride: args.chunkingProfileOverride } : {}),
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
      const legs = await backend.search(
        variantSearchRequest({
          scope,
          variant: variants[index]!,
          embedding: vectors[index]!,
          filters,
          pool: params.candidate_pool_size,
          lexicalEnabled,
          signal,
          chunkingProfileOverride: ctx.chunkingProfileOverride ?? null,
        }),
      );
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
  return Object.freeze({ port, collectedLegs, fusedHits });
}
