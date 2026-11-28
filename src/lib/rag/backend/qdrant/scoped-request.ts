import { canonicalTenantKey } from '@/lib/rag/backend/tenant-key';
import type { TenantScope } from '@/lib/rag/tenant/scope';

export type QdrantPointId = string | number;
export type QdrantMatch =
  | { value: string | number | boolean }
  | { any: (string | number)[] }
  | { except: (string | number)[] }
  | { text: string }
  | { phrase: string };
export interface QdrantRange {
  gt?: number | string | null;
  gte?: number | string | null;
  lt?: number | string | null;
  lte?: number | string | null;
}
export interface QdrantFieldCondition {
  key: string;
  match?: QdrantMatch;
  range?: QdrantRange;
}
export interface QdrantHasIdCondition {
  has_id: QdrantPointId[];
}
export interface QdrantIsEmptyCondition {
  is_empty: { key: string };
}
export interface QdrantIsNullCondition {
  is_null: { key: string };
}
export interface QdrantNestedCondition {
  nested: { key: string; filter: QdrantFilter };
}
export type QdrantCondition =
  | QdrantFieldCondition
  | QdrantHasIdCondition
  | QdrantIsEmptyCondition
  | QdrantIsNullCondition
  | QdrantNestedCondition
  | QdrantFilter;
export interface QdrantFilter {
  must?: QdrantCondition | QdrantCondition[] | null;
  should?: QdrantCondition | QdrantCondition[] | null;
  must_not?: QdrantCondition | QdrantCondition[] | null;
  min_should?: { conditions: QdrantCondition[]; min_count: number } | null;
}
export interface QdrantSparseVector {
  indices: number[];
  values: number[];
}
export interface QdrantDocument {
  text: string;
  model?: string;
  options?: Record<string, string | number | boolean>;
}
export type QdrantVectorInput = number[] | number[][] | QdrantSparseVector | QdrantDocument;
export type QdrantQuery =
  | QdrantVectorInput
  | { nearest: QdrantVectorInput }
  | { fusion: 'rrf' | 'dbsf' }
  | { rrf: { k?: number } };
export interface QdrantIdfParams {
  corpus?: QdrantFilter;
}
export interface QdrantSearchParams {
  hnsw_ef?: number;
  exact?: boolean;
  indexed_only?: boolean;
  quantization?: { ignore?: boolean; rescore?: boolean; oversampling?: number };
  acorn?: { enable: boolean; max_selectivity?: number };
  idf?: QdrantIdfParams | 'global';
}
export interface QdrantQueryNode {
  query?: QdrantQuery | null;
  using?: string;
  filter?: QdrantFilter | null;
  params?: QdrantSearchParams;
  prefetch?: QdrantQueryNode | QdrantQueryNode[];
  limit?: number;
  offset?: number;
  score_threshold?: number;
  with_payload?: boolean | string[] | { include?: string[]; exclude?: string[] };
  with_vector?: boolean | string[];
}
export interface QdrantQueryBatch {
  searches: QdrantQueryNode[];
  timeout?: number;
}
export interface QdrantCountRequest {
  filter?: QdrantFilter | null;
  exact?: boolean;
}
export interface QdrantScrollRequest {
  filter?: QdrantFilter | null;
  limit?: number;
  offset?: QdrantPointId | null;
  with_payload?: boolean | string[] | { include?: string[]; exclude?: string[] };
  with_vector?: boolean | string[];
  order_by?: string | { key: string; direction?: 'asc' | 'desc' };
}
export interface QdrantDeleteRequest {
  filter: QdrantFilter;
}

declare const scopedBrand: unique symbol;
/** Only the builders below produce this type; the client wrapper in the adapter accepts nothing else. */
export type Scoped<T> = T & { readonly [scopedBrand]: true };

type TenantClause = { key: 'tenant_key'; match: { value: string } };
type PlainObject = Record<string, unknown>;

const TENANT_FIELD = 'tenant_key';
/** lookup_from and with_lookup read another collection; shard_key picks a shard outside the tenant filter. */
const FORBIDDEN_KEYS: readonly string[] = ['lookup_from', 'shard_key', 'with_lookup'];
const MAX_PREFETCH_DEPTH = 8;
const MAX_WALK_DEPTH = 64;
const FILTER_KEYS = new Set(['must', 'should', 'must_not', 'min_should']);
const NODE_KEYS = new Set([
  'query',
  'using',
  'filter',
  'params',
  'prefetch',
  'limit',
  'offset',
  'score_threshold',
  'with_payload',
  'with_vector',
]);
const PARAM_KEYS = new Set(['hnsw_ef', 'exact', 'indexed_only', 'quantization', 'acorn', 'idf']);
const BATCH_KEYS = new Set(['searches', 'timeout']);
const COUNT_KEYS = new Set(['filter', 'exact']);
const SCROLL_KEYS = new Set(['filter', 'limit', 'offset', 'with_payload', 'with_vector', 'order_by']);
const DELETE_KEYS = new Set(['filter']);
const ANY_REQUEST_KEYS = new Set([...NODE_KEYS, ...COUNT_KEYS, ...SCROLL_KEYS, ...DELETE_KEYS]);
const POINT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw new Error(`[RAG Security] qdrant ${message}`);
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tenantClause(key: string): TenantClause {
  return { key: TENANT_FIELD, match: { value: key } };
}

function checkKeys(value: PlainObject, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${where} key ${key} not allowed`);
  }
}

/** Walks the whole request: forbidden selectors and global IDF anywhere, and caller-built tenant_key clauses on input. */
function rejectForbidden(value: unknown, allowTenantClause: boolean, depth = 0): void {
  if (depth > MAX_WALK_DEPTH) fail('request nested too deeply');
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'object' && item !== null) rejectForbidden(item, allowTenantClause, depth + 1);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) fail(`${key} not allowed`);
    if (key === 'idf' && child === 'global') fail('global idf not allowed');
    if (key === 'key' && child === TENANT_FIELD && !allowTenantClause) fail('tenant_key condition is set only by the wrapper');
    if (typeof child === 'object' && child !== null) rejectForbidden(child, allowTenantClause, depth + 1);
  }
}

function conditionsOf(list: unknown): QdrantCondition[] {
  if (list === null || list === undefined) return [];
  if (Array.isArray(list)) return [...(list as QdrantCondition[])];
  if (isPlainObject(list)) return [list as QdrantCondition];
  return fail('filter conditions must be objects');
}

function scopeFilter(filter: unknown, key: string): QdrantFilter {
  if (filter === null || filter === undefined) return { must: [tenantClause(key)] };
  if (!isPlainObject(filter)) fail('filter must be an object');
  checkKeys(filter, FILTER_KEYS, 'filter');
  return { ...(filter as QdrantFilter), must: [tenantClause(key), ...conditionsOf(filter.must)] };
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function isDocument(value: unknown): value is QdrantDocument {
  return (
    isPlainObject(value) &&
    typeof value.text === 'string' &&
    Object.keys(value).every((k) => k === 'text' || k === 'model' || k === 'options')
  );
}

function isVectorInput(value: unknown): boolean {
  if (isNumberArray(value)) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(isNumberArray);
  if (isDocument(value)) return true;
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.indices) &&
    Array.isArray(value.values) &&
    value.indices.every((n) => typeof n === 'number') &&
    value.values.every((n) => typeof n === 'number')
  );
}

/** Point-id queries (recommend, discover, context, a bare id) would read stored vectors outside the filter. */
function validateQuery(query: unknown): void {
  if (query === null || query === undefined) return;
  if (isVectorInput(query)) return;
  if (isPlainObject(query)) {
    const keys = Object.keys(query);
    if (keys.length === 1) {
      if (keys[0] === 'nearest' && isVectorInput(query.nearest)) return;
      if (keys[0] === 'fusion' && (query.fusion === 'rrf' || query.fusion === 'dbsf')) return;
      if (
        keys[0] === 'rrf' &&
        isPlainObject(query.rrf) &&
        Object.keys(query.rrf).every((k) => k === 'k' && typeof (query.rrf as PlainObject).k === 'number')
      ) {
        return;
      }
    }
  }
  fail('query form not allowed');
}

function isLexical(query: unknown): boolean {
  return isDocument(query) || (isPlainObject(query) && isDocument(query.nearest));
}

function scopeParams(params: unknown, key: string, lexical: boolean): QdrantSearchParams | undefined {
  if (params === null || params === undefined) {
    return lexical ? { idf: { corpus: scopeFilter(undefined, key) } } : undefined;
  }
  if (!isPlainObject(params)) fail('params must be an object');
  checkKeys(params, PARAM_KEYS, 'params');
  const idf = params.idf;
  if (idf === 'global') fail('global idf not allowed');
  if (idf === undefined || idf === null) {
    return lexical ? { ...(params as QdrantSearchParams), idf: { corpus: scopeFilter(undefined, key) } } : (params as QdrantSearchParams);
  }
  if (!isPlainObject(idf)) fail('idf must be an object');
  checkKeys(idf, new Set(['corpus']), 'idf');
  return { ...(params as QdrantSearchParams), idf: { corpus: scopeFilter(idf.corpus, key) } };
}

function scopeNode(node: unknown, key: string, depth: number): QdrantQueryNode {
  if (depth > MAX_PREFETCH_DEPTH) fail('prefetch nested too deeply');
  if (!isPlainObject(node)) fail('query must be an object');
  checkKeys(node, NODE_KEYS, 'query');
  validateQuery(node.query);
  const out: QdrantQueryNode = { ...(node as QdrantQueryNode), filter: scopeFilter(node.filter, key) };
  const params = scopeParams(node.params, key, isLexical(node.query));
  if (params !== undefined) out.params = params;
  if (node.prefetch !== undefined && node.prefetch !== null) {
    const list: unknown[] = Array.isArray(node.prefetch) ? node.prefetch : [node.prefetch];
    out.prefetch = list.map((child) => scopeNode(child, key, depth + 1));
  }
  return out;
}

function isExactClause(condition: unknown, key: string): boolean {
  if (!isPlainObject(condition)) return false;
  const keys = Object.keys(condition);
  if (keys.length !== 2 || condition.key !== TENANT_FIELD || !isPlainObject(condition.match)) return false;
  const match = condition.match;
  return Object.keys(match).length === 1 && match.value === key && keys.includes('match');
}

function requireClause(filter: unknown, key: string, where: string): void {
  if (!isPlainObject(filter) || !conditionsOf(filter.must).some((c) => isExactClause(c, key))) {
    fail(`${where} lacks the tenant clause`);
  }
}

function assertNode(node: unknown, key: string, depth: number, allowed: ReadonlySet<string>, where: string): void {
  if (depth > MAX_PREFETCH_DEPTH) fail('prefetch nested too deeply');
  if (!isPlainObject(node)) fail(`${where} must be an object`);
  checkKeys(node, allowed, where);
  requireClause(node.filter, key, `${where} filter`);
  validateQuery(node.query);
  const params = node.params;
  if (params !== undefined && params !== null) {
    if (!isPlainObject(params)) fail('params must be an object');
    checkKeys(params, PARAM_KEYS, 'params');
  }
  const idf = isPlainObject(params) ? params.idf : undefined;
  if (idf === 'global') fail('global idf not allowed');
  if (idf !== undefined && idf !== null) {
    if (!isPlainObject(idf)) fail('idf must be an object');
    requireClause(idf.corpus, key, `${where} idf corpus`);
  } else if (isLexical(node.query)) {
    fail(`${where} lexical query lacks a tenant idf corpus`);
  }
  if (node.prefetch !== undefined && node.prefetch !== null) {
    const list: unknown[] = Array.isArray(node.prefetch) ? node.prefetch : [node.prefetch];
    list.forEach((child, i) => assertNode(child, key, depth + 1, NODE_KEYS, `${where} prefetch[${i}]`));
  }
}

/**
 * Throws unless every filter location (top filter, every prefetch at every depth, every idf corpus) carries the
 * exact tenant clause for this scope. Each builder runs it on its own output, so a bug in injection still throws.
 */
export function assertScoped(request: unknown, scope: TenantScope): void {
  const key = canonicalTenantKey(scope);
  rejectForbidden(request, true);
  if (!isPlainObject(request)) fail('request must be an object');
  if ('searches' in request) {
    checkKeys(request, BATCH_KEYS, 'batch');
    const searches = request.searches;
    if (!Array.isArray(searches) || searches.length === 0) fail('batch needs at least one search');
    searches.forEach((search, i) => assertNode(search, key, 0, NODE_KEYS, `searches[${i}]`));
    return;
  }
  assertNode(request, key, 0, ANY_REQUEST_KEYS, 'request');
}

export function qdrantScopedRequest(scope: TenantScope, node: QdrantQueryNode): Scoped<QdrantQueryNode> {
  const key = canonicalTenantKey(scope);
  rejectForbidden(node, false);
  const out = scopeNode(node, key, 0);
  assertScoped(out, scope);
  return out as Scoped<QdrantQueryNode>;
}

export function qdrantScopedBatch(scope: TenantScope, batch: QdrantQueryBatch): Scoped<QdrantQueryBatch> {
  const key = canonicalTenantKey(scope);
  rejectForbidden(batch, false);
  if (!isPlainObject(batch)) fail('batch must be an object');
  checkKeys(batch, BATCH_KEYS, 'batch');
  if (!Array.isArray(batch.searches) || batch.searches.length === 0) fail('batch needs at least one search');
  const out: QdrantQueryBatch = { ...batch, searches: batch.searches.map((search) => scopeNode(search, key, 0)) };
  assertScoped(out, scope);
  return out as Scoped<QdrantQueryBatch>;
}

function scopeFilterRequest<T extends { filter?: QdrantFilter | null }>(
  scope: TenantScope,
  request: T,
  allowed: ReadonlySet<string>,
  where: string,
): Scoped<T & { filter: QdrantFilter }> {
  const key = canonicalTenantKey(scope);
  rejectForbidden(request, false);
  if (!isPlainObject(request)) fail(`${where} must be an object`);
  checkKeys(request, allowed, where);
  const out = { ...request, filter: scopeFilter(request.filter, key) };
  assertScoped(out, scope);
  return out as Scoped<T & { filter: QdrantFilter }>;
}

function isPointId(value: unknown): value is QdrantPointId {
  return (typeof value === 'string' && POINT_UUID_RE.test(value)) || (Number.isSafeInteger(value) && (value as number) >= 0);
}

export function scopedCount(scope: TenantScope, request: QdrantCountRequest = {}): Scoped<QdrantCountRequest> {
  return scopeFilterRequest(scope, request, COUNT_KEYS, 'count');
}

export function scopedScroll(scope: TenantScope, request: QdrantScrollRequest = {}): Scoped<QdrantScrollRequest> {
  if (request.offset !== undefined && request.offset !== null && !isPointId(request.offset)) fail('scroll offset must be a point id');
  return scopeFilterRequest(scope, request, SCROLL_KEYS, 'scroll');
}

/** Refuses a filter with no condition of its own, so a mistake cannot wipe a whole tenant. */
export function scopedDeleteByFilter(scope: TenantScope, filter: QdrantFilter): Scoped<QdrantDeleteRequest> {
  if (!isPlainObject(filter)) fail('delete filter must be an object');
  const own =
    conditionsOf(filter.must).length +
    conditionsOf(filter.should).length +
    conditionsOf(filter.must_not).length +
    (isPlainObject(filter.min_should) ? conditionsOf(filter.min_should.conditions).length : 0);
  if (own === 0) fail('delete needs a condition besides the tenant');
  return scopeFilterRequest(scope, { filter }, DELETE_KEYS, 'delete');
}

/** Deletes by id only inside the tenant: a foreign point id matches nothing. */
export function scopedDeleteIds(scope: TenantScope, ids: readonly QdrantPointId[]): Scoped<QdrantDeleteRequest> {
  if (!Array.isArray(ids) || ids.length === 0) fail('delete needs at least one point id');
  if (!ids.every(isPointId)) fail('delete ids must be point ids');
  const key = canonicalTenantKey(scope);
  const out: QdrantDeleteRequest = { filter: { must: [tenantClause(key), { has_id: [...ids] }] } };
  assertScoped(out, scope);
  return out as Scoped<QdrantDeleteRequest>;
}

export const SCOPED_BUILDERS = {
  qdrantScopedRequest,
  qdrantScopedBatch,
  scopedCount,
  scopedScroll,
  scopedDeleteByFilter,
  scopedDeleteIds,
} as const;
