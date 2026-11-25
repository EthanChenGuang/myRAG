import type { BackendLegs, RetrievalBackend, RetrievalFilters } from '../backend/types';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import type { FusedHit } from '../fusion/rrf';
import type { RetrievalPort } from '../query/port-types';
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
  embed: (texts: string[]) => Promise<QueryEmbedding[]>;
  lexicalEnabled: boolean;
  chunkingProfileOverride?: Record<string, string>;
}

export interface RetrievalPortHandle {
  readonly port: RetrievalPort;
  collectedLegs(): BackendLegs[];
  fusedHits(fusedChunkIds: readonly string[]): FusedHit[];
}

export function createRetrievalPort(_ctx: RetrievalPortContext): RetrievalPortHandle {
  const port: RetrievalPort = {
    variants: [],
    searchVariant: async () => ({ dense: [], lexical: [] }),
    finishRetrieval: () => [],
  };
  return { port, collectedLegs: () => [], fusedHits: () => [] };
}
