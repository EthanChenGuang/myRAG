import type { StoreHit, StoreLegs, StoreSearchRequest } from '../../sync/stores/types';
import type { TenantScope } from '../../tenant/scope';
import { createExternalBackend, type ExternalStoreReader } from '../external';
import type { SecurityLogSink } from '../revalidate';
import { RetrievalBackendError, type RpcClient } from '../supabase-rpc';
import { canonicalTenantKey, isCanonicalTenantKey, weaviateCollectionName, weaviateTenantName } from '../tenant-key';
import type { BackendSearchRequest, RetrievalBackend, RetrievalFilters } from '../types';
import { WEAVIATE_LEXICAL_PROPERTY } from './collection';
import { mapWeaviateError } from './errors';
import type { WeaviateClientLike, WeaviateFilterValue, WeaviateQueryResult, WeaviateTenantCollection } from './types';

export type WeaviateClientSource = WeaviateClientLike | (() => WeaviateClientLike | Promise<WeaviateClientLike>);

/**
 * D-07: the one entry point to a collection's query, data and aggregate APIs. A minted scope or a canonical tenant key read from
 * Supabase rows selects the tenant; there is no code path without one.
 */
export function tenantCollection(client: WeaviateClientLike, tenant: TenantScope | string, profileId: string): WeaviateTenantCollection {
  const handle = client.collections.use(weaviateCollectionName(profileId));
  if (typeof tenant !== 'string') return handle.withTenant(weaviateTenantName(canonicalTenantKey(tenant)));
  if (!isCanonicalTenantKey(tenant)) throw new Error('[RAG Tenant] malformed tenant key');
  return handle.withTenant(weaviateTenantName(tenant));
}

type FilterHandling = 'implicit' | 'native' | 'unsupported';

/** Exhaustive over RetrievalFilters: a new key fails the type check until it is classified here. */
const FILTER_HANDLING: { readonly [K in keyof Required<RetrievalFilters>]: FilterHandling } = {
  currentOnly: 'implicit',
  dateRange: 'native',
  sources: 'native',
  documentIds: 'native',
  docTypes: 'native',
  languages: 'native',
  invoice: 'unsupported',
  scopes: 'unsupported',
  scopesIncludeUntagged: 'unsupported',
  effectiveOn: 'unsupported',
};

function filterUnsupported(): RetrievalBackendError {
  return new RetrievalBackendError('weaviate.search', 'filter_unsupported');
}

function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** D-03: invoice, scope-tag and effective-date fields are not in the payload, so such a request goes to pgvector (07-12). */
export function assertWeaviateFiltersSupported(filters: RetrievalFilters): void {
  for (const [key, value] of Object.entries(filters)) {
    const handling = (FILTER_HANDLING as Record<string, FilterHandling | undefined>)[key];
    if (handling === undefined) throw filterUnsupported();
    if (handling === 'unsupported' && isSet(value)) throw filterUnsupported();
  }
}

export function assertWeaviateRequestSupported(req: BackendSearchRequest): void {
  if (req.chunkingProfileOverride && Object.keys(req.chunkingProfileOverride).length > 0) throw filterUnsupported();
  if (req.versionScope !== undefined && req.versionScope !== 'current') throw filterUnsupported();
  if (req.identifiersNorm && req.identifiersNorm.length > 0) throw filterUnsupported();
  assertWeaviateFiltersSupported(req.filters);
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Weaviate dates are RFC 3339; a date-only value means midnight UTC, the same instant the sync payload stores. */
export function weaviateDate(value: string): string {
  return DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
}

function and(filters: WeaviateFilterValue[]): WeaviateFilterValue | undefined {
  if (filters.length === 0) return undefined;
  if (filters.length === 1) return filters[0];
  return { operator: 'And', filters, value: null };
}

function or(filters: WeaviateFilterValue[]): WeaviateFilterValue {
  return filters.length === 1 ? filters[0] : { operator: 'Or', filters, value: null };
}

/** DATA-08 native pre-filters, the same on both legs. Empty lists mean no filter. */
export function buildWeaviateFilter(col: WeaviateTenantCollection, filters: RetrievalFilters): WeaviateFilterValue | undefined {
  assertWeaviateFiltersSupported(filters);
  const parts: WeaviateFilterValue[] = [];
  const lists: Array<[string, string[] | undefined]> = [
    ['document_id', filters.documentIds],
    ['doc_type', filters.docTypes],
    ['language', filters.languages],
    ['source', filters.sources],
  ];
  for (const [property, values] of lists) {
    if (values && values.length > 0) parts.push(col.filter.byProperty(property).containsAny([...values]));
  }
  const range = filters.dateRange;
  if (range && (range.from || range.to)) {
    const bounds: WeaviateFilterValue[] = [];
    if (range.from) bounds.push(col.filter.byProperty('doc_date').greaterOrEqual(weaviateDate(range.from)));
    if (range.to) bounds.push(col.filter.byProperty('doc_date').lessOrEqual(weaviateDate(range.to)));
    const dated = and(bounds) as WeaviateFilterValue;
    parts.push(range.includeUndated === true ? or([dated, col.filter.byProperty('doc_date').isNull(true)]) : dated);
  }
  return and(parts);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
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

function hits(result: WeaviateQueryResult, score: (metadata: { distance?: number; score?: number }) => number | null): StoreHit[] {
  const out: StoreHit[] = [];
  for (const object of result.objects ?? []) {
    if (typeof object.uuid !== 'string') continue;
    const value = score(object.metadata ?? {});
    out.push({ id: object.uuid, score: value ?? Number.NaN });
  }
  return out;
}

const EMPTY: WeaviateQueryResult = { objects: [] };
const ID_ONLY = ['document_id'];

async function resolveClient(source: WeaviateClientSource): Promise<WeaviateClientLike> {
  return typeof source === 'function' ? source() : source;
}

/**
 * D-13, A-4: nearVector and bm25 run concurrently on the tenant handle with the same native pre-filters; an empty token list
 * skips bm25 (the server rejects an empty query). Similarity is 1 - cosine distance; lexical scores are BM25 scores. A missing
 * or inactive tenant (or collection) throws BackendNotReadyError and is never retried without a tenant.
 */
export async function searchWeaviateLegs(source: WeaviateClientSource, req: StoreSearchRequest): Promise<StoreLegs> {
  const { signal } = req;
  signal.throwIfAborted();
  canonicalTenantKey(req.scope);
  assertWeaviateFiltersSupported(req.filters);
  const client = await resolveClient(source);
  signal.throwIfAborted();
  const col = tenantCollection(client, req.scope, req.profileId);
  const where = buildWeaviateFilter(col, req.filters);
  const tokens = req.lexicalTokens.filter((token) => typeof token === 'string' && token.trim().length > 0);
  const dense =
    req.denseVector && req.denseVector.length > 0 && req.denseLimit > 0
      ? col.query.nearVector(
          req.denseVector,
          { limit: req.denseLimit, filters: where, returnMetadata: ['distance'], returnProperties: ID_ONLY },
          { abortSignal: signal },
        )
      : Promise.resolve(EMPTY);
  const lexical =
    tokens.length > 0 && req.lexicalLimit > 0
      ? col.query.bm25(
          tokens.join(' '),
          {
            queryProperties: [WEAVIATE_LEXICAL_PROPERTY],
            limit: req.lexicalLimit,
            filters: where,
            returnMetadata: ['score'],
            returnProperties: ID_ONLY,
          },
          { abortSignal: signal },
        )
      : Promise.resolve(EMPTY);
  try {
    const [denseResult, lexicalResult] = await withAbort(Promise.all([dense, lexical]), signal);
    return {
      dense: hits(denseResult, (m) => (typeof m.distance === 'number' ? 1 - m.distance : null)),
      lexical: hits(lexicalResult, (m) => (typeof m.score === 'number' ? m.score : null)),
    };
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    throw mapWeaviateError(error, 'search');
  }
}

export function createWeaviateReader(source: WeaviateClientSource): ExternalStoreReader {
  return {
    target: 'weaviate',
    searchLegs: (req) => searchWeaviateLegs(source, req),
    async health() {
      try {
        const ready = await (await resolveClient(source)).isReady();
        return ready ? { ok: true } : { ok: false, detail: 'not_ready' };
      } catch {
        return { ok: false, detail: 'unreachable' };
      }
    },
  };
}

export interface WeaviateBackendDeps {
  readClient: WeaviateClientSource;
  /** The Supabase admin client for rag_validate_chunks (isolation layer 2). */
  revalidate: () => RpcClient | null;
  readiness?: (scope: TenantScope) => Promise<boolean>;
  securityLog?: SecurityLogSink;
}

/** The Weaviate RetrievalBackend: tenant-only legs, then re-validation and hydration from Supabase (createExternalBackend). */
export function createWeaviateBackend(deps: WeaviateBackendDeps): RetrievalBackend {
  const inner = createExternalBackend({
    reader: createWeaviateReader(deps.readClient),
    adminClient: deps.revalidate,
    isReady: deps.readiness,
    securityLog: deps.securityLog,
  });
  return {
    id: 'weaviate',
    search(req) {
      try {
        assertWeaviateRequestSupported(req);
      } catch (error) {
        return Promise.reject(error);
      }
      return inner.search(req);
    },
    health: () => inner.health(),
    isReady: (scope) => inner.isReady(scope),
  };
}
