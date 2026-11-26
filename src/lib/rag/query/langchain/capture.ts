import type { DocumentInterface } from '@langchain/core/documents';
import { BaseRetriever } from '@langchain/core/retrievers';

/**
 * Records every query LangChain asks it to retrieve and returns no documents (D-17, D-18): the LangChain retrievers only
 * produce query text here; retrieval runs later through the server-bound port with the tenant held in its closure.
 */
export class CaptureRetriever extends BaseRetriever {
  lc_namespace = ['myrag', 'rag', 'query', 'capture'];
  readonly queries: string[] = [];

  constructor() {
    super({ callbacks: [] });
  }

  async _getRelevantDocuments(query: string): Promise<DocumentInterface[]> {
    this.queries.push(query);
    return [];
  }
}
