import type {
  WeaviateBm25Options,
  WeaviateClientLike,
  WeaviateCollectionHandle,
  WeaviateFetchOptions,
  WeaviateFilterValue,
  WeaviateInsertObject,
  WeaviateQueryResult,
  WeaviateSearchOptions,
  WeaviateTenantCollection,
} from '@/lib/rag/backend/weaviate/types';

export interface FakeObject {
  id: string;
  properties: Record<string, unknown>;
  vector: number[];
}

interface FakeCollection {
  config: Record<string, unknown>;
  tenants: Map<string, Map<string, FakeObject>>;
}

export interface FakeWeaviateCall {
  op: string;
  collection: string;
  tenant: string | null;
  args?: unknown;
}

export interface FakeWeaviateOptions {
  /** Pitfall 13: deleteMany removes at most this many objects per call. */
  deleteCap?: number;
  /** A broken server: a handle for the requested tenant answers from another tenant's shard. */
  misroute?: Record<string, string>;
  /** Writes fail with a permission error, as with the read-only key. */
  readOnly?: boolean;
  /** Query calls resolve on a later macrotask so the test can see whether both legs started first. */
  slowQueries?: boolean;
}

export interface FakeWeaviate extends WeaviateClientLike {
  calls: FakeWeaviateCall[];
  events: string[];
  collectionsByName: Map<string, FakeCollection>;
  /** Test-only: plant an object directly in a tenant shard (creates the tenant). */
  plant(collection: string, tenant: string, object: FakeObject): void;
  /** Test-only: the raw handle, including the untenanted query/data/aggregate stubs the store must never reach. */
  rawHandle(name: string): WeaviateCollectionHandle & Record<string, unknown>;
}

const UNTENANTED = 'class has multi-tenancy enabled, but request was without tenant';

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function propertyOf(target: unknown): string {
  return (target as { property: string }).property;
}

function valueOf(object: FakeObject, property: string): unknown {
  return property === '_id' ? object.id : object.properties[property];
}

export function evaluateFilter(filter: WeaviateFilterValue | undefined, object: FakeObject): boolean {
  if (!filter) return true;
  switch (filter.operator) {
    case 'And':
      return (filter.filters ?? []).every((f) => evaluateFilter(f, object));
    case 'Or':
      return (filter.filters ?? []).some((f) => evaluateFilter(f, object));
    case 'Not':
      return !evaluateFilter((filter.filters ?? [])[0], object);
  }
  const value = valueOf(object, propertyOf(filter.target));
  switch (filter.operator) {
    case 'Equal':
      return value === filter.value;
    case 'ContainsAny':
      if (Array.isArray(value)) return value.some((item) => (filter.value as unknown[]).includes(item));
      return value !== undefined && value !== null && (filter.value as unknown[]).includes(value);
    case 'GreaterThanEqual':
      return typeof value === 'string' && value >= String(filter.value);
    case 'LessThanEqual':
      return typeof value === 'string' && value <= String(filter.value);
    case 'IsNull':
      return (value === undefined || value === null) === filter.value;
    default:
      throw new Error(`fake weaviate: unsupported operator ${filter.operator}`);
  }
}

function leaf(property: string) {
  const target = { property };
  return {
    equal: (value: string | number) => ({ operator: 'Equal', value, target }),
    containsAny: (values: string[]) => ({ operator: 'ContainsAny', value: values, target }),
    greaterOrEqual: (value: string) => ({ operator: 'GreaterThanEqual', value, target }),
    lessOrEqual: (value: string) => ({ operator: 'LessThanEqual', value, target }),
    isNull: (value: boolean) => ({ operator: 'IsNull', value, target }),
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export function createFakeWeaviate(options: FakeWeaviateOptions = {}): FakeWeaviate {
  const collections = new Map<string, FakeCollection>();
  const calls: FakeWeaviateCall[] = [];
  const events: string[] = [];
  const deleteCap = options.deleteCap ?? 10_000;

  function requireCollection(name: string): FakeCollection {
    const col = collections.get(name);
    if (!col) throw new Error(`could not find class ${name} in schema`);
    return col;
  }

  function shard(name: string, tenant: string): Map<string, FakeObject> {
    const col = requireCollection(name);
    const actual = options.misroute?.[tenant] ?? tenant;
    const found = col.tenants.get(actual);
    if (!found) throw new Error(`tenant not found: "${tenant}"`);
    return found;
  }

  function sorted(part: Map<string, FakeObject>): FakeObject[] {
    return [...part.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async function query<T>(op: string, run: () => T, signal?: AbortSignal): Promise<T> {
    events.push(`start:${op}`);
    if (options.slowQueries) await tick();
    signal?.throwIfAborted();
    const out = run();
    events.push(`end:${op}`);
    return out;
  }

  function tenantHandle(name: string, tenant: string): WeaviateTenantCollection {
    const record = (op: string, args?: unknown) => calls.push({ op, collection: name, tenant, args });
    return {
      filter: { byProperty: (property: string) => leaf(property), byId: () => ({ containsAny: (ids: string[]) => leaf('_id').containsAny(ids) }) },
      query: {
        nearVector(vector: number[], opts: WeaviateSearchOptions, call?: { abortSignal?: AbortSignal }): Promise<WeaviateQueryResult> {
          record('nearVector', opts);
          return query(
            'nearVector',
            () => ({
              objects: sorted(shard(name, tenant))
                .filter((o) => evaluateFilter(opts.filters, o))
                .map((o) => ({ uuid: o.id, metadata: { distance: 1 - cosine(vector, o.vector) } }))
                .sort((a, b) => a.metadata.distance - b.metadata.distance || (a.uuid < b.uuid ? -1 : 1))
                .slice(0, opts.limit),
            }),
            call?.abortSignal,
          );
        },
        bm25(text: string, opts: WeaviateBm25Options, call?: { abortSignal?: AbortSignal }): Promise<WeaviateQueryResult> {
          record('bm25', { ...opts, query: text });
          if (text.trim() === '') return Promise.reject(new Error('keyword search (bm25) must have query set'));
          const tokens = new Set(text.split(/\s+/).filter(Boolean));
          return query(
            'bm25',
            () => ({
              objects: sorted(shard(name, tenant))
                .filter((o) => evaluateFilter(opts.filters, o))
                .map((o) => {
                  const words = new Set(String(o.properties.lexical_text ?? '').split(/\s+/).filter(Boolean));
                  let score = 0;
                  for (const token of tokens) if (words.has(token)) score += 1;
                  return { uuid: o.id, metadata: { score } };
                })
                .filter((o) => o.metadata.score > 0)
                .sort((a, b) => b.metadata.score - a.metadata.score || (a.uuid < b.uuid ? -1 : 1))
                .slice(0, opts.limit),
            }),
            call?.abortSignal,
          );
        },
        async fetchObjects(opts: WeaviateFetchOptions): Promise<WeaviateQueryResult> {
          record('fetchObjects', opts);
          const all = sorted(shard(name, tenant))
            .filter((o) => evaluateFilter(opts.filters, o))
            .filter((o) => !opts.after || o.id > opts.after);
          const start = opts.offset ?? 0;
          return {
            objects: all.slice(start, start + opts.limit).map((o) => ({ uuid: o.id, properties: { ...o.properties } })),
          };
        },
      },
      data: {
        async insertMany(objects: WeaviateInsertObject[]) {
          record('insertMany', objects);
          if (options.readOnly) throw new Error('forbidden: user does not have permission (403)');
          const part = shard(name, tenant);
          for (const object of objects) part.set(object.id, { id: object.id, properties: { ...object.properties }, vector: [...object.vectors] });
          return { hasErrors: false, errors: {} };
        },
        async deleteMany(where: WeaviateFilterValue) {
          record('deleteMany', where);
          if (options.readOnly) throw new Error('forbidden: user does not have permission (403)');
          const part = shard(name, tenant);
          const matching = sorted(part).filter((o) => evaluateFilter(where, o));
          const removed = matching.slice(0, deleteCap);
          for (const o of removed) part.delete(o.id);
          return { matches: matching.length, successful: removed.length, failed: 0 };
        },
      },
      aggregate: {
        async overAll(opts?: { filters?: WeaviateFilterValue }) {
          record('aggregate', opts);
          const part = shard(name, tenant);
          return { totalCount: opts?.filters ? sorted(part).filter((o) => evaluateFilter(opts.filters, o)).length : part.size };
        },
      },
    };
  }

  function untenanted(name: string) {
    const refuse = () => {
      calls.push({ op: 'untenanted', collection: name, tenant: null });
      throw new Error(UNTENANTED);
    };
    return {
      query: { nearVector: refuse, bm25: refuse, fetchObjects: refuse, hybrid: refuse },
      data: { insert: refuse, insertMany: refuse, deleteMany: refuse, deleteById: refuse },
      aggregate: { overAll: refuse },
      length: refuse,
      iterator: refuse,
    };
  }

  function handle(name: string): WeaviateCollectionHandle & Record<string, unknown> {
    return {
      ...untenanted(name),
      withTenant(tenant: string) {
        calls.push({ op: 'withTenant', collection: name, tenant });
        return tenantHandle(name, tenant);
      },
      config: {
        async addProperty(property: Record<string, unknown>) {
          calls.push({ op: 'config.addProperty', collection: name, tenant: null, args: property });
          if (options.readOnly) throw new Error('forbidden: user does not have permission (403)');
          const col = requireCollection(name);
          const properties = (col.config.properties as Array<Record<string, unknown>> | undefined) ?? [];
          if (properties.some((p) => p.name === property.name)) throw new Error(`property ${String(property.name)} already exists`);
          col.config = { ...col.config, properties: [...properties, property] };
          return {};
        },
      },
      tenants: {
        async create(list: { name: string }[]) {
          if (options.readOnly) throw new Error('forbidden: user does not have permission (403)');
          const col = requireCollection(name);
          for (const t of list) {
            calls.push({ op: 'tenants.create', collection: name, tenant: t.name });
            if (!col.tenants.has(t.name)) col.tenants.set(t.name, new Map());
          }
          return list;
        },
        async getByName(tenant: string) {
          return requireCollection(name).tenants.has(tenant) ? { name: tenant, activityStatus: 'ACTIVE' } : null;
        },
        async get() {
          return Object.fromEntries([...requireCollection(name).tenants.keys()].map((t) => [t, { name: t, activityStatus: 'ACTIVE' }]));
        },
      },
    };
  }

  return {
    calls,
    events,
    collectionsByName: collections,
    collections: {
      use: (name: string) => handle(name),
      async listAll() {
        return [...collections.keys()].sort().map((name) => ({ name }));
      },
      async exists(name: string) {
        return collections.has(name);
      },
      async create(config: Record<string, unknown>) {
        const name = String(config.name);
        calls.push({ op: 'collections.create', collection: name, tenant: null, args: config });
        if (options.readOnly) throw new Error('forbidden: user does not have permission (403)');
        if (collections.has(name)) throw new Error(`class name ${name} already exists`);
        collections.set(name, { config, tenants: new Map() });
        return {};
      },
      async export(name: string) {
        const config = requireCollection(name).config;
        const properties = Array.isArray(config.properties) ? (config.properties as Array<{ name: string }>).map((p) => ({ name: String(p.name) })) : [];
        return { description: String(config.description ?? ''), properties };
      },
      async delete(name: string) {
        calls.push({ op: 'collections.delete', collection: name, tenant: null });
        collections.delete(name);
      },
    },
    async isReady() {
      return true;
    },
    plant(collection: string, tenant: string, object: FakeObject) {
      const col = requireCollection(collection);
      let part = col.tenants.get(tenant);
      if (!part) {
        part = new Map();
        col.tenants.set(tenant, part);
      }
      part.set(object.id, { id: object.id, properties: { ...object.properties }, vector: [...object.vector] });
    },
    rawHandle: (name: string) => handle(name),
  };
}
