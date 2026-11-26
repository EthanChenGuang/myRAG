import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { AnswerGroundedness } from '../generation/groundedness';
import type { TenantScope } from '../tenant/scope';
import type { RetrievalResult, RetrievalStatus } from '../types';
import type { ResolvedSource } from './sources';
import type { CacheTicket, SemanticCache } from './types';

export const CACHE_STORE_GROUNDEDNESS_WAIT_MS = 25_000;

export interface CacheStoreFacts {
  chatId: string | null;
  sourceImages: boolean;
  retrievalStatus: RetrievalStatus;
  answerText: string;
  isRefusal: boolean;
  toolsUsed?: boolean;
}

export interface CacheStoreSource {
  documentId: string;
  name: string;
  version: number | null;
}

export interface ScheduleCacheStoreInput {
  scope: TenantScope | null;
  ticket: CacheTicket | undefined;
  traceId: string;
  facts: CacheStoreFacts;
  citations?: CitationRecord[];
  sources?: CacheStoreSource[];
  groundedness?: Promise<AnswerGroundedness | null> | null;
}

export interface CacheStoreDeps {
  cache: () => SemanticCache | null;
  schedule: (task: () => Promise<void>) => void;
  resolveSources: (scope: TenantScope, documentIds: readonly string[], signal: AbortSignal) => Promise<Map<string, ResolvedSource>>;
  readConfig: () => { groundedness: boolean; embedStore: boolean };
  now: () => Date;
}

export function cacheSourcesFromResult(_result: Pick<RetrievalResult, 'kept'> & Partial<Pick<RetrievalResult, 'blocks'>>): CacheStoreSource[] {
  return [];
}

export function scheduleCacheStore(_input: ScheduleCacheStoreInput, _deps: Partial<CacheStoreDeps> = {}): void {}
