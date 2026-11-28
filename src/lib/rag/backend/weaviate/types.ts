/**
 * The subset of the Weaviate v3 client the adapter and the sync store use, typed structurally so only client.ts imports the
 * vendor package. A collection handle exposes no query, data or aggregate API: those exist only on a tenant handle (D-07).
 */
export interface WeaviateFilterValue {
  operator: string;
  value: unknown;
  filters?: WeaviateFilterValue[];
  target?: unknown;
}

export interface WeaviateFilterProperty {
  equal(value: string | number): WeaviateFilterValue;
  containsAny(values: string[]): WeaviateFilterValue;
  greaterOrEqual(value: string): WeaviateFilterValue;
  lessOrEqual(value: string): WeaviateFilterValue;
  isNull(value: boolean): WeaviateFilterValue;
}

export interface WeaviateFilterId {
  containsAny(ids: string[]): WeaviateFilterValue;
}

export interface WeaviateResultObject {
  uuid: string;
  properties?: Record<string, unknown>;
  metadata?: { distance?: number; score?: number };
}

export interface WeaviateQueryResult {
  objects: WeaviateResultObject[];
}

export interface WeaviateCallOptions {
  abortSignal?: AbortSignal;
}

export interface WeaviateSearchOptions {
  limit: number;
  filters?: WeaviateFilterValue;
  returnMetadata: string[];
  returnProperties: string[];
}

export interface WeaviateBm25Options extends WeaviateSearchOptions {
  queryProperties: string[];
}

export interface WeaviateFetchOptions {
  limit: number;
  after?: string;
  offset?: number;
  filters?: WeaviateFilterValue;
  returnProperties: string[];
}

export interface WeaviateInsertObject {
  id: string;
  properties: Record<string, unknown>;
  vectors: number[];
}

export interface WeaviateInsertResult {
  hasErrors: boolean;
  errors: Record<number, { message: string }>;
}

export interface WeaviateDeleteResult {
  matches: number;
  successful: number;
  failed: number;
}

export interface WeaviateTenantCollection {
  filter: { byProperty(name: string): WeaviateFilterProperty; byId(): WeaviateFilterId };
  query: {
    nearVector(vector: number[], opts: WeaviateSearchOptions, call?: WeaviateCallOptions): Promise<WeaviateQueryResult>;
    bm25(query: string, opts: WeaviateBm25Options, call?: WeaviateCallOptions): Promise<WeaviateQueryResult>;
    fetchObjects(opts: WeaviateFetchOptions): Promise<WeaviateQueryResult>;
  };
  data: {
    insertMany(objects: WeaviateInsertObject[]): Promise<WeaviateInsertResult>;
    deleteMany(where: WeaviateFilterValue, opts?: { dryRun?: boolean; verbose?: boolean }): Promise<WeaviateDeleteResult>;
  };
  aggregate: { overAll(opts?: { filters?: WeaviateFilterValue }): Promise<{ totalCount: number }> };
}

export interface WeaviateTenantInfo {
  name: string;
  activityStatus?: string;
}

/** Collection admin only: tenants and the tenant handle. No data path is reachable without withTenant. */
export interface WeaviateCollectionHandle {
  withTenant(name: string): WeaviateTenantCollection;
  /** Schema changes on an existing collection (SEC-12: the access_groups property); no data path. */
  config: { addProperty(property: Record<string, unknown>): Promise<unknown> };
  tenants: {
    create(tenants: { name: string }[]): Promise<unknown>;
    getByName(name: string): Promise<WeaviateTenantInfo | null>;
    get(): Promise<Record<string, WeaviateTenantInfo>>;
  };
}

export interface WeaviateClientLike {
  collections: {
    use(name: string): WeaviateCollectionHandle;
    listAll(): Promise<Array<{ name: string }>>;
    exists(name: string): Promise<boolean>;
    create(config: Record<string, unknown>): Promise<unknown>;
    export(name: string): Promise<{ description?: string | null; properties?: Array<{ name: string }> | null }>;
    delete(name: string): Promise<void>;
  };
  isReady(): Promise<boolean>;
}
