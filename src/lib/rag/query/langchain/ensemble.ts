import { EnsembleRetriever } from '@langchain/classic/retrievers/ensemble';
import { Document } from '@langchain/core/documents';
import { BaseRetriever } from '@langchain/core/retrievers';
import type { RetrievalPort, RetrievalPortLists, SearchDelegate, SearchDelegateContext } from '../port-types';

type Leg = 'dense' | 'lexical';

/** EnsembleRetriever's own default; used only when the search stage passes no context. */
const DEFAULT_RRF_K = 60;

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * One (variant, leg) list of the scope-bound port as a LangChain retriever (D-18). It closes over the port search and the request
 * signal (BaseRetriever passes none), ignores the query text and returns one Document per chunk id with the id as
 * pageContent and empty metadata, so EnsembleRetriever keys, dedupes and fuses by chunk id, never by content (F-2).
 */
class LegRetriever extends BaseRetriever {
  lc_namespace = ['myrag', 'retrievers', 'leg'];

  constructor(
    private readonly lists: () => Promise<RetrievalPortLists>,
    private readonly leg: Leg,
    private readonly signal: AbortSignal,
  ) {
    super({ callbacks: [] });
  }

  async _getRelevantDocuments(): Promise<Document[]> {
    if (this.signal.aborted) throw abortError(this.signal);
    const lists = await this.lists();
    if (this.signal.aborted) throw abortError(this.signal);
    return lists[this.leg].map((chunkId) => new Document({ pageContent: chunkId, metadata: {} }));
  }
}

/** Rejects as soon as the signal fires, whether or not the LangChain call honours it. */
function raceSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(abortError(signal));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(signal.aborted ? abortError(signal) : error);
      },
    );
  });
}

/**
 * QRY-08 (D-17, D-18, A-4): variant fusion through LangChain's EnsembleRetriever. One LegRetriever per (variant, leg)
 * list of the port (a dense-only variant has no lexical retriever), weights from retrieval-params.json leg_weights and
 * c = rrf_k, invoked once. A variant's two retrievers share one port search.
 * EnsembleRetriever sums weight / (rank + c) over the same lists native RRF fuses; ties keep first-seen order, a
 * reported difference from native (chunk id ascending). The fused ids go through port.finishRetrieval.
 */
export function createLangChainSearchDelegate(): SearchDelegate {
  return async (port: RetrievalPort, context?: SearchDelegateContext): Promise<string[]> => {
    const signal = context?.signal ?? new AbortController().signal;
    const weights = context?.legWeights ?? { dense: 1, lexical: 1 };
    const searches = new Map<number, Promise<RetrievalPortLists>>();
    // One port search per variant, shared by its dense and lexical retrievers.
    const listsOf = (index: number) => () => {
      let pending = searches.get(index);
      if (!pending) {
        pending = port.searchVariant(index);
        searches.set(index, pending);
      }
      return pending;
    };
    const retrievers: LegRetriever[] = [];
    const retrieverWeights: number[] = [];
    for (const variant of port.variants) {
      const legs: Leg[] = variant.legs === 'dense' ? ['dense'] : ['dense', 'lexical'];
      for (const leg of legs) {
        // A list with weight 0 adds nothing to native RRF and is left out there, so it is left out here too.
        if (!(weights[leg] > 0)) continue;
        retrievers.push(new LegRetriever(listsOf(variant.index), leg, signal));
        retrieverWeights.push(weights[leg]);
      }
    }
    if (signal.aborted) throw abortError(signal);
    if (retrievers.length === 0) return [];

    const ensemble = new EnsembleRetriever({ retrievers, weights: retrieverWeights, c: context?.rrfK ?? DEFAULT_RRF_K, callbacks: [] });
    const documents = await raceSignal(signal, () => ensemble.invoke('', { signal, callbacks: [] }));
    return port.finishRetrieval(documents.map((document) => document.pageContent)).map((hit) => hit.chunkId);
  };
}
