import type { WeaviateClientLike } from '@/lib/rag/backend/weaviate/types';
import type { VectorStore } from './types';

export interface WeaviateStoreOptions {
  client: WeaviateClientLike;
  maxDeleteRounds?: number;
  pageSize?: number;
}

export function createWeaviateStore(_options: WeaviateStoreOptions): VectorStore {
  return {
    target: 'weaviate',
    async ensureCollection() {},
    async describeCollection() {
      return null;
    },
    async ensureTenant() {},
    async upsert() {
      return 0;
    },
    async deleteIds() {
      return 0;
    },
    async deleteDocument() {
      return 0;
    },
    async deleteTenant() {
      return 0;
    },
    async listDocumentIds() {
      return [];
    },
    async scanTenant() {
      return { points: [], next: null };
    },
    async count() {
      return 0;
    },
    async searchLegs() {
      return { dense: [], lexical: [] };
    },
    async health() {
      return { ok: false };
    },
  };
}
