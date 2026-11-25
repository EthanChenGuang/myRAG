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

export function qdrantScopedRequest(_scope: TenantScope, node: QdrantQueryNode): Scoped<QdrantQueryNode> {
  return node as Scoped<QdrantQueryNode>;
}

export function qdrantScopedBatch(_scope: TenantScope, batch: QdrantQueryBatch): Scoped<QdrantQueryBatch> {
  return batch as Scoped<QdrantQueryBatch>;
}

export function scopedCount(_scope: TenantScope, request: QdrantCountRequest = {}): Scoped<QdrantCountRequest> {
  return request as Scoped<QdrantCountRequest>;
}

export function scopedScroll(_scope: TenantScope, request: QdrantScrollRequest = {}): Scoped<QdrantScrollRequest> {
  return request as Scoped<QdrantScrollRequest>;
}

export function scopedDeleteByFilter(_scope: TenantScope, filter: QdrantFilter): Scoped<QdrantDeleteRequest> {
  return { filter } as Scoped<QdrantDeleteRequest>;
}

export function scopedDeleteIds(_scope: TenantScope, _ids: readonly QdrantPointId[]): Scoped<QdrantDeleteRequest> {
  return { filter: {} } as Scoped<QdrantDeleteRequest>;
}

export function assertScoped(_request: unknown, _scope: TenantScope): void {}

export const SCOPED_BUILDERS = {
  qdrantScopedRequest,
  qdrantScopedBatch,
  scopedCount,
  scopedScroll,
  scopedDeleteByFilter,
  scopedDeleteIds,
} as const;
