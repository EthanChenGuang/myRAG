import type { QdrantApi } from '@/lib/rag/backend/qdrant/client';

export interface RecordedRequest {
  method: keyof QdrantApi;
  collection: string | null;
  body: Record<string, unknown>;
}

interface StoredPoint {
  id: string;
  vector: Record<string, number[]>;
  payload: Record<string, unknown>;
}

interface FakeCollection {
  config: Record<string, unknown>;
  payload_schema: Record<string, unknown>;
  points: Map<string, StoredPoint>;
  /** Index fields created while the collection already held points. */
  lateIndexes: string[];
}

export interface FakeQdrantClient extends QdrantApi {
  requests: RecordedRequest[];
  collections: Map<string, FakeCollection>;
  /** 'ignore' answers every search over all points, as a server that dropped the filter would. */
  filterMode: 'evaluate' | 'ignore';
  /** Holds every queryBatch until release() runs. */
  holdQueries: boolean;
  release(): void;
  seed(collection: string, points: StoredPoint[]): void;
}

type Json = Record<string, unknown>;

function notFound(): Error {
  return Object.assign(new Error('Not Found'), { status: 404, statusText: 'Not Found' });
}

function list(value: unknown): Json[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as Json[];
}

function empty(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function compare(a: unknown, b: unknown): number {
  const x = typeof a === 'string' ? Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a) : Number(a);
  const y = typeof b === 'string' ? Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b) : Number(b);
  return x - y;
}

function condition(cond: Json, point: StoredPoint): boolean {
  if ('has_id' in cond) return (cond.has_id as unknown[]).map(String).includes(point.id);
  if ('is_empty' in cond) return empty(point.payload[(cond.is_empty as Json).key as string]);
  if ('is_null' in cond) return point.payload[(cond.is_null as Json).key as string] === null;
  if ('must' in cond || 'should' in cond || 'must_not' in cond) return matches(cond, point);
  const value = point.payload[cond.key as string];
  if (cond.match) {
    const match = cond.match as Json;
    if ('value' in match) return value === match.value;
    if ('any' in match) return (match.any as unknown[]).includes(value);
    if ('except' in match) return value !== undefined && value !== null && !(match.except as unknown[]).includes(value);
    if ('text' in match) return typeof value === 'string' && value.split(/\s+/).includes(String(match.text));
  }
  if (cond.range) {
    if (empty(value)) return false;
    const range = cond.range as Json;
    if (range.gte !== undefined && compare(value, range.gte) < 0) return false;
    if (range.gt !== undefined && compare(value, range.gt) <= 0) return false;
    if (range.lte !== undefined && compare(value, range.lte) > 0) return false;
    if (range.lt !== undefined && compare(value, range.lt) >= 0) return false;
    return true;
  }
  throw new Error(`fake qdrant: unknown condition ${JSON.stringify(cond)}`);
}

export function matches(filter: unknown, point: StoredPoint): boolean {
  if (filter === undefined || filter === null) return true;
  const f = filter as Json;
  if (!list(f.must).every((c) => condition(c, point))) return false;
  const should = list(f.should);
  if (should.length > 0 && !should.some((c) => condition(c, point))) return false;
  if (list(f.must_not).some((c) => condition(c, point))) return false;
  return true;
}

function cosine(a: number[], b: number[]): number {
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

function sortedPoints(col: FakeCollection): StoredPoint[] {
  return [...col.points.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** An in-memory Qdrant that records every request and evaluates filters the way the server does for the conditions the app sends. */
export function createFakeQdrantClient(): FakeQdrantClient {
  const collections = new Map<string, FakeCollection>();
  const requests: RecordedRequest[] = [];
  let waiting: Array<() => void> = [];

  function record(method: keyof QdrantApi, collection: string | null, body: unknown): void {
    requests.push({ method, collection, body: structuredClone((body ?? {}) as Json) });
  }

  function get(name: string): FakeCollection {
    const col = collections.get(name);
    if (!col) throw notFound();
    return col;
  }

  function candidates(client: FakeQdrantClient, col: FakeCollection, filter: unknown): StoredPoint[] {
    const all = sortedPoints(col);
    return client.filterMode === 'ignore' ? all : all.filter((point) => matches(filter, point));
  }

  const client: FakeQdrantClient = {
    requests,
    collections,
    filterMode: 'evaluate',
    holdQueries: false,
    release() {
      const pending = waiting;
      waiting = [];
      for (const resolve of pending) resolve();
    },
    seed(name, points) {
      const col = get(name);
      for (const point of points) col.points.set(point.id, structuredClone(point));
    },
    async getCollections() {
      record('getCollections', null, {});
      return { collections: [...collections.keys()].sort().map((name) => ({ name })) } as never;
    },
    async getCollection(name) {
      record('getCollection', name, {});
      const col = get(name);
      return { status: 'green', config: structuredClone(col.config), payload_schema: structuredClone(col.payload_schema) } as never;
    },
    async createCollection(name, body) {
      record('createCollection', name, body);
      if (collections.has(name)) throw Object.assign(new Error('Conflict'), { status: 409 });
      const spec = body as Json;
      collections.set(name, {
        config: { params: { vectors: spec.vectors }, hnsw_config: spec.hnsw_config, metadata: spec.metadata ?? null },
        payload_schema: {},
        points: new Map(),
        lateIndexes: [],
      });
      return true;
    },
    async createPayloadIndex(name, body) {
      record('createPayloadIndex', name, body);
      const col = get(name);
      const { field_name: field, field_schema: schema } = body as { field_name: string; field_schema: unknown };
      if (col.points.size > 0) col.lateIndexes.push(field);
      col.payload_schema[field] = schema;
      return { operation_id: 0, status: 'completed' } as never;
    },
    async updateCollection(name, body = {}) {
      record('updateCollection', name, body);
      const col = get(name);
      const metadata = (body as Json).metadata;
      if (metadata && typeof metadata === 'object') {
        const merged = { ...((col.config.metadata as Json | null) ?? {}) };
        for (const [key, value] of Object.entries(metadata as Json)) {
          if (value === null) delete merged[key];
          else merged[key] = structuredClone(value);
        }
        col.config.metadata = merged;
      }
      return true;
    },
    async deleteCollection(name) {
      record('deleteCollection', name, {});
      return collections.delete(name);
    },
    async upsert(name, body) {
      record('upsert', name, body);
      const col = get(name);
      for (const point of (body as { points: StoredPoint[] }).points) {
        col.points.set(String(point.id), structuredClone({ ...point, id: String(point.id) }));
      }
      return { operation_id: 0, status: 'completed' } as never;
    },
    async delete(name, body) {
      record('delete', name, body);
      const col = get(name);
      const filter = (body as Json).filter;
      for (const point of sortedPoints(col)) if (matches(filter, point)) col.points.delete(point.id);
      return { operation_id: 0, status: 'completed' } as never;
    },
    async scroll(name, body = {}) {
      record('scroll', name, body);
      const col = get(name);
      const req = body as Json;
      let all = candidates(client, col, req.filter);
      if (req.offset !== undefined && req.offset !== null) all = all.filter((point) => point.id >= String(req.offset));
      const limit = typeof req.limit === 'number' ? req.limit : 10;
      const page = all.slice(0, limit);
      const include = Array.isArray(req.with_payload) ? (req.with_payload as string[]) : null;
      return {
        points: page.map((point) => ({
          id: point.id,
          payload:
            req.with_payload === false || req.with_payload === undefined
              ? null
              : include
                ? Object.fromEntries(include.map((k) => [k, point.payload[k]]))
                : point.payload,
        })),
        next_page_offset: all.length > limit ? all[limit].id : null,
      } as never;
    },
    async count(name, body = {}) {
      record('count', name, body);
      return { count: candidates(client, get(name), (body as Json).filter).length };
    },
    async queryBatch(name, body) {
      record('queryBatch', name, body);
      const col = get(name);
      if (client.holdQueries) await new Promise<void>((resolve) => waiting.push(resolve));
      return (body as { searches: Json[] }).searches.map((search) => {
        const pool = candidates(client, col, search.filter);
        const query = search.query as unknown;
        const limit = typeof search.limit === 'number' ? search.limit : 10;
        let scored: Array<{ id: string; score: number }>;
        if (Array.isArray(query)) {
          scored = pool.map((point) => ({ id: point.id, score: cosine(query as number[], point.vector[search.using as string] ?? []) }));
        } else {
          const text = (query as Json).text;
          const raw = text !== null && typeof text === 'object' ? (text as Json).query : text;
          const tokens = new Set(String(raw).split(' ').filter(Boolean));
          scored = pool
            .map((point) => {
              const words = String(point.payload[search.using as string] ?? '').split(/\s+/);
              return { id: point.id, score: words.filter((w) => tokens.has(w)).length };
            })
            .filter((hit) => hit.score > 0);
        }
        scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
        return { points: scored.slice(0, limit) };
      }) as never;
    },
    async versionInfo() {
      record('versionInfo', null, {});
      return { title: 'qdrant - vector search engine', version: '1.20.2' };
    },
  };
  return client;
}

/** The request body without the vendor transport fields (wait, ordering, timeout) that the scoped builders never see. */
export function scopedBodyOf(request: RecordedRequest): Record<string, unknown> {
  const transport = new Set(['wait', 'ordering', 'timeout']);
  return Object.fromEntries(Object.entries(request.body).filter(([key]) => !transport.has(key)));
}
