/**
 * The narrow retrieval port a query framework adapter calls back into (D-18). Plain data and two methods only:
 * the tenant, filters, signal, embeddings and backend stay in the server-side closure that created the port.
 */

export type RetrievalPortVariantKind =
  | 'original'
  | 'translated'
  | 'condensed'
  | 'expanded'
  | 'hyde'
  | 'sub_question';

export interface RetrievalPortVariant {
  readonly index: number;
  readonly text: string;
  readonly kind: RetrievalPortVariantKind | string;
  readonly legs: 'both' | 'dense';
}

/** One variant's legs as ranked chunk-id lists, best first. A dense-only variant has an empty lexical list. */
export interface RetrievalPortLists {
  readonly dense: readonly string[];
  readonly lexical: readonly string[];
}

/** A collected hit in the fused order, with its rank in each leg list (`dense:<i>`, `lexical:<i>`). */
export interface RetrievalPortHit {
  readonly chunkId: string;
  readonly legs: Readonly<Record<string, number>>;
}

export interface RetrievalPort {
  readonly variants: readonly RetrievalPortVariant[];
  /** One backend search per variant however often it is asked for; rejects once the request is aborted. */
  searchVariant(index: number): Promise<RetrievalPortLists>;
  /** Maps a fused chunk-id order back to the hits collected so far; unknown and repeated ids are dropped. */
  finishRetrieval(fusedChunkIds: readonly string[]): RetrievalPortHit[];
}

/** What the search stage hands a delegate besides the port: the stage signal and the RRF settings of retrieval-params.json. */
export interface SearchDelegateContext {
  readonly signal: AbortSignal;
  /** retrieval-params.json rrf_k. */
  readonly rrfK: number;
  /** retrieval-params.json leg_weights for the variant legs. */
  readonly legWeights: { readonly dense: number; readonly lexical: number };
}

/** Fuses the port's variant lists and returns the fused chunk-id order. */
export type SearchDelegate = (port: RetrievalPort, context?: SearchDelegateContext) => Promise<string[]>;
