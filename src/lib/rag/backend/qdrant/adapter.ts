import { BackendNotReadyError, createExternalBackend, type ExternalStoreReader } from '@/lib/rag/backend/external';
import type { SecurityLogSink } from '@/lib/rag/backend/revalidate';
import { RetrievalBackendError, type RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { canonicalTenantKey, qdrantCollectionName } from '@/lib/rag/backend/tenant-key';
import type { BackendSearchRequest, RetrievalBackend, RetrievalFilters } from '@/lib/rag/backend/types';
import type { StoreHealth, StoreHit, StoreLegs, StoreSearchRequest } from '@/lib/rag/sync/stores/types';
import type { TenantScope } from '@/lib/rag/tenant/scope';
import type { QdrantApi } from './client';
import { qdrantErrorStatus } from './errors';
import { QDRANT_DENSE_VECTOR, QDRANT_LEXICAL_FIELD } from './collection';
import { qdrantScopedBatch, type QdrantCondition, type QdrantFilter, type QdrantQueryNode } from './scoped-request';

const RPC_NAME = 'qdrant.query_batch';

/**
 * How each RetrievalFilters key reaches Qdrant. A key added to RetrievalFilters without an entry here fails compilation.
 * - native: translated into a pre-filter on the D-03 payload.
 * - store: guaranteed by what the store holds (the drain writes current, servable chunks only) and by re-validation.
 * - unsupported: the payload has no field for it (D-03); the request throws filter_unsupported and the factory routes it to pgvector.
 */
export const QDRANT_FILTER_SUPPORT = {
  currentOnly: 'store',
  dateRange: 'native',
  sources: 'native',
  documentIds: 'native',
  docTypes: 'native',
  languages: 'native',
  invoice: 'unsupported',
  scopes: 'unsupported',
  scopesIncludeUntagged: 'unsupported',
  effectiveOn: 'unsupported',
} as const satisfies { [K in keyof Required<RetrievalFilters>]: 'native' | 'store' | 'unsupported' };

function unsupported(): never {
  throw new RetrievalBackendError(RPC_NAME, 'filter_unsupported');
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some((v) => v !== undefined && v !== null);
  return true;
}

function matchAny(key: string, values: string[] | undefined): QdrantCondition[] {
  if (!values || values.length === 0) return [];
  return [{ key, match: { any: [...values] } }];
}

/** Native pre-filters for one request; the tenant clause is added by qdrantScopedBatch, never here. */
export function qdrantFilterConditions(filters: RetrievalFilters): QdrantCondition[] {
  for (const key of Object.keys(filters) as Array<keyof RetrievalFilters>) {
    const support = QDRANT_FILTER_SUPPORT[key];
    if (support === undefined) unsupported();
    if (support === 'unsupported' && isSet(filters[key])) unsupported();
  }
  const conditions: QdrantCondition[] = [
    ...matchAny('source', filters.sources),
    ...matchAny('document_id', filters.documentIds),
    ...matchAny('doc_type', filters.docTypes),
    ...matchAny('language', filters.languages),
  ];
  const range = filters.dateRange;
  if (range && (range.from || range.to)) {
    const dated: QdrantCondition = {
      key: 'doc_date',
      range: { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) },
    };
    conditions.push(range.includeUndated === true ? { should: [dated, { is_empty: { key: 'doc_date' } }] } : dated);
  }
  return conditions;
}

/** Request fields beyond the store contract that the D-03 payload cannot honour. */
export function assertQdrantRequestSupported(req: BackendSearchRequest): void {
  if (req.chunkingProfileOverride && Object.keys(req.chunkingProfileOverride).length > 0) unsupported();
  if (req.versionScope !== undefined && req.versionScope !== 'current') unsupported();
  if (req.identifiersNorm && req.identifiersNorm.length > 0) unsupported();
  qdrantFilterConditions(req.filters);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function hitsOf(response: { points?: Array<{ id: string | number; score?: number }> } | undefined): StoreHit[] {
  return (response?.points ?? []).map((point) => ({ id: String(point.id), score: typeof point.score === 'number' ? point.score : 0 }));
}

/**
 * One query batch per request: the dense search (ACORN on, so selective filters keep recall) and the BM25 text search over
 * lexical_text with the query built from the shared tokenizer's tokens. Both go through qdrantScopedBatch, which adds the tenant clause
 * to each filter and scopes the IDF corpus to the tenant. An empty token list sends no text search.
 */
export async function searchQdrantLegs(client: QdrantApi, req: StoreSearchRequest): Promise<StoreLegs> {
  const scope: TenantScope = req.scope;
  canonicalTenantKey(scope);
  req.signal.throwIfAborted();
  const conditions = qdrantFilterConditions(req.filters);
  const filter = (): QdrantFilter => ({ must: conditions.map((c) => structuredClone(c)) });
  const tokens = req.lexicalTokens.filter((token) => token.length > 0);
  const wantDense = req.denseVector !== null && req.denseVector.length > 0 && req.denseLimit > 0;
  const wantLexical = tokens.length > 0 && req.lexicalLimit > 0;
  const searches: Array<{ leg: 'dense' | 'lexical'; node: QdrantQueryNode }> = [];
  if (wantDense) {
    searches.push({
      leg: 'dense',
      node: {
        query: [...(req.denseVector as number[])],
        using: QDRANT_DENSE_VECTOR,
        limit: req.denseLimit,
        filter: filter(),
        params: { acorn: { enable: true } },
        with_payload: false,
      },
    });
  }
  if (wantLexical) {
    searches.push({
      leg: 'lexical',
      node: {
        query: { text: tokens.join(' ') },
        using: QDRANT_LEXICAL_FIELD,
        limit: req.lexicalLimit,
        filter: filter(),
        with_payload: false,
      },
    });
  }
  if (searches.length === 0) return { dense: [], lexical: [] };
  const batch = qdrantScopedBatch(scope, { searches: searches.map((s) => s.node) });
  const collection = qdrantCollectionName(req.profileId);
  let responses: Awaited<ReturnType<QdrantApi['queryBatch']>>;
  try {
    responses = await abortable(
      client.queryBatch(collection, batch as unknown as Parameters<QdrantApi['queryBatch']>[1]),
      req.signal,
    );
  } catch (error) {
    if (req.signal.aborted) throw req.signal.reason;
    const status = qdrantErrorStatus(error);
    if (status === 404) throw new BackendNotReadyError('qdrant', 'collection_missing');
    throw new RetrievalBackendError(RPC_NAME, status === null ? 'unreachable' : `http_${status}`);
  }
  const legs: StoreLegs = { dense: [], lexical: [] };
  searches.forEach((search, i) => {
    legs[search.leg] = hitsOf(responses[i] as { points?: Array<{ id: string | number; score?: number }> });
  });
  return legs;
}

export async function qdrantHealth(client: QdrantApi): Promise<StoreHealth> {
  try {
    const info = await client.versionInfo();
    return { ok: true, detail: typeof info.version === 'string' ? info.version : undefined };
  } catch (error) {
    const status = qdrantErrorStatus(error);
    return { ok: false, detail: status === null ? 'unreachable' : `http_${status}` };
  }
}

export function createQdrantReader(readClient: QdrantApi): ExternalStoreReader {
  return {
    target: 'qdrant',
    searchLegs: (req) => searchQdrantLegs(readClient, req),
    health: () => qdrantHealth(readClient),
  };
}

export interface QdrantBackendDeps {
  readClient: QdrantApi;
  adminClient: () => RpcClient | null;
  /** Injected by the factory (07-12); absent means not ready, so the factory falls back to pgvector. */
  readiness?: (scope: TenantScope) => Promise<boolean>;
  securityLog?: SecurityLogSink;
}

/** Qdrant as a RetrievalBackend: every id from both legs is re-validated and hydrated from Supabase by createExternalBackend. */
export function createQdrantBackend(deps: QdrantBackendDeps): RetrievalBackend {
  const external = createExternalBackend({
    reader: createQdrantReader(deps.readClient),
    adminClient: deps.adminClient,
    isReady: deps.readiness,
    securityLog: deps.securityLog,
  });
  return {
    id: 'qdrant',
    async search(req: BackendSearchRequest) {
      assertQdrantRequestSupported(req);
      return external.search(req);
    },
    health: () => external.health(),
    isReady: (scope: TenantScope) => external.isReady(scope),
  };
}
