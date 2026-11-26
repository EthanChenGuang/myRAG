import crypto from 'node:crypto';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

/** An in-memory model of the 0703 outbox lifecycle, the 0705 reads and the 0707 reconcile RPCs, enough to drive drainSlice and reconcileSlice without a database. */

export interface FakeClock {
  t: number;
  now(): number;
}

export function fakeClock(start = Date.parse('2026-01-01T00:00:00Z')): FakeClock {
  const clock = {
    t: start,
    now: () => clock.t,
  };
  return clock;
}

export interface FakeOutboxRow {
  id: number;
  target: string;
  entity: 'chunk' | 'document' | 'profile' | 'tenant';
  entity_id: string;
  tenant_key: string | null;
  profile_id: string | null;
  cursor: string | null;
  attempts: number;
  status: 'pending' | 'leased' | 'done' | 'dead';
  lease_until: number | null;
  last_error: string | null;
  enqueued_at: string;
}

export interface FakeDocument {
  id: string;
  tenant_key: string;
  doc_type: string;
  is_current: boolean;
  status: string;
}

export interface FakeChunk {
  id: string;
  document_id: string;
  tenant_key: string;
  vector: number[];
  lexical_text: string | null;
  content: string;
  /** Defaults to `h-<last 4 of id>`; lexical_version defaults to 1. */
  content_hash?: string | null;
  lexical_version?: number | null;
}

export interface FakeIndexState {
  target: string;
  profile_id: string;
  tenant_key: string;
  state: 'building' | 'ready' | 'stale' | 'failed';
  last_reconciled_at: number | null;
  supabase_count: number | null;
  backend_count: number | null;
  last_error: string | null;
}

export interface FakeCall {
  fn: string;
  args: Record<string, unknown>;
}

export interface FakeRpc {
  client: RpcClient;
  calls: FakeCall[];
  outbox: FakeOutboxRow[];
  documents: Map<string, FakeDocument>;
  chunks: Map<string, FakeChunk>;
  profiles: Array<{ profile_id: string; dims: number; storage: string }>;
  /** 0707: enabled targets (default: the fake's own target) and index state keyed `target|profile|tenant`. */
  enabledTargets: Set<string>;
  indexState: Map<string, FakeIndexState>;
  enqueue(row: Pick<FakeOutboxRow, 'entity' | 'entity_id' | 'tenant_key'> & Partial<FakeOutboxRow>): FakeOutboxRow;
  addDocument(doc: Partial<FakeDocument> & { id: string; tenant_key: string }, chunks: FakeChunk[]): void;
  /** Called after each RPC with its name; tests use it to move the clock or inject failures. */
  onCall: ((fn: string, args: Record<string, unknown>) => void) | null;
  /** Answers the next call of fn with this error instead of running it. */
  failNext(fn: string, code: string): void;
}

const NIL = '00000000-0000-0000-0000-000000000000';

function md5(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex');
}

function signed64(hex: string): bigint {
  return BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`));
}

export function createFakeRpc(clock: FakeClock, options: { target?: string } = {}): FakeRpc {
  const target = options.target ?? 'qdrant';
  let nextId = 1;
  const failures = new Map<string, string>();
  const state: FakeRpc = {
    client: null as unknown as RpcClient,
    calls: [],
    outbox: [],
    documents: new Map(),
    chunks: new Map(),
    profiles: [{ profile_id: 'p1', dims: 3, storage: 'halfvec' }],
    enabledTargets: new Set([target]),
    indexState: new Map(),
    onCall: null,
    enqueue(row) {
      const full: FakeOutboxRow = {
        id: nextId++,
        target,
        profile_id: null,
        cursor: null,
        attempts: 0,
        status: 'pending',
        lease_until: null,
        last_error: null,
        enqueued_at: new Date(clock.now()).toISOString(),
        ...row,
      };
      state.outbox.push(full);
      return full;
    },
    addDocument(doc, chunks) {
      state.documents.set(doc.id, { doc_type: 'general', is_current: true, status: 'ready', ...doc });
      for (const chunk of chunks) state.chunks.set(chunk.id, chunk);
    },
    failNext(fn, code) {
      failures.set(fn, code);
    },
  };

  function servable(chunk: FakeChunk, tenantKey: string): boolean {
    const doc = state.documents.get(chunk.document_id);
    return !!doc && doc.is_current && doc.status === 'ready' && doc.tenant_key === tenantKey && chunk.tenant_key === tenantKey;
  }

  function servableOf(tenantKey: string): FakeChunk[] {
    return [...state.chunks.values()].filter((c) => servable(c, tenantKey)).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  function toRow(chunk: FakeChunk) {
    const doc = state.documents.get(chunk.document_id) as FakeDocument;
    return {
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      tenant_key: chunk.tenant_key,
      vector: chunk.vector,
      lexical_text: chunk.lexical_text,
      lexical_version: chunk.lexical_version === undefined ? 1 : chunk.lexical_version,
      content_hash: chunk.content_hash === undefined ? `h-${chunk.id.slice(-4)}` : chunk.content_hash,
      doc_type: doc.doc_type,
      doc_date: null,
      language: 'en',
      source: 'upload',
      chunking_profile_id: null,
      parent_id: null,
    };
  }

  function enqueueDedupe(entity: FakeOutboxRow['entity'], entityId: string, tenantKey: string | null, profileId: string | null): number {
    const absorbed = state.outbox.find(
      (o) =>
        o.status === 'pending' &&
        o.attempts === 0 &&
        o.cursor === null &&
        o.target === target &&
        o.entity === entity &&
        o.entity_id === entityId &&
        o.tenant_key === tenantKey &&
        o.profile_id === profileId,
    );
    if (absorbed) return 0;
    state.enqueue({ entity, entity_id: entityId, tenant_key: tenantKey, profile_id: profileId });
    return 1;
  }

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    rag_vector_sync_claim(args) {
      const now = clock.now();
      const live = (o: FakeOutboxRow) => o.status === 'leased' && (o.lease_until ?? 0) >= now;
      const candidates = state.outbox
        .filter(
          (c) =>
            ((c.status === 'pending' && (c.lease_until === null || c.lease_until < now)) ||
              (c.status === 'leased' && (c.lease_until ?? 0) < now)) &&
            !state.outbox.some((l) => l.id !== c.id && l.target === c.target && l.entity === c.entity && l.entity_id === c.entity_id && live(l)),
        )
        .sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at) || a.id - b.id)
        .slice(0, Number(args.p_limit));
      for (const c of candidates) {
        c.status = 'leased';
        c.lease_until = now + Number(args.p_lease_seconds) * 1000;
        c.attempts += 1;
      }
      return candidates.map((c) => ({ ...c, lease_until: new Date(c.lease_until as number).toISOString() }));
    },
    rag_vector_sync_complete(args) {
      let n = 0;
      for (const o of state.outbox) {
        if ((args.p_ids as number[]).includes(o.id) && o.status === 'leased') {
          o.status = 'done';
          o.lease_until = null;
          n += 1;
        }
      }
      return n;
    },
    rag_vector_sync_fail(args) {
      const o = state.outbox.find((r) => r.id === args.p_id && r.status === 'leased');
      if (!o) return null;
      const code = String(args.p_error).slice(0, 200);
      o.last_error = /^[a-z0-9_.:-]+$/.test(code) ? code : 'invalid_error_code';
      if (o.attempts >= 8) {
        o.status = 'dead';
        o.lease_until = null;
      } else {
        o.status = 'pending';
        o.lease_until = clock.now() + Math.min(2 ** o.attempts, 3600) * 1000;
      }
      return o.status;
    },
    rag_vector_sync_checkpoint(args) {
      const cursor = args.p_cursor;
      if (typeof cursor !== 'string' || cursor === '' || cursor.length > 200) throw Object.assign(new Error('invalid_cursor'), { code: '22023' });
      const o = state.outbox.find((r) => r.id === args.p_id && r.status === 'leased');
      if (!o) return false;
      o.status = 'pending';
      o.lease_until = null;
      o.cursor = cursor;
      o.attempts = Math.max(o.attempts - 1, 0);
      return true;
    },
    rag_vector_sync_expand(args) {
      const o = state.outbox.find((r) => r.id === args.p_id);
      if (!o || o.status !== 'leased' || (o.entity !== 'tenant' && o.entity !== 'profile')) throw Object.assign(new Error('x'), { code: '22023' });
      const limit = Number(args.p_limit);
      const after = o.cursor;
      const docType = o.entity === 'profile' && o.entity_id.startsWith('chunking:') ? o.entity_id.slice('chunking:'.length) : null;
      const docs = [...state.documents.values()]
        .filter((d) => d.is_current && (o.entity === 'profile' || d.tenant_key === o.tenant_key))
        .filter((d) => docType === null || d.doc_type === docType)
        .filter((d) => after === null || d.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const page = docs.slice(0, limit);
      let enqueued = 0;
      for (const d of page) enqueued += enqueueDedupe('document', d.id, d.tenant_key, o.profile_id);
      const last = page.length > 0 ? page[page.length - 1].id : o.cursor;
      o.cursor = last;
      return [{ enqueued, next_cursor: last, has_more: docs.length > limit }];
    },
    rag_vector_sync_profiles() {
      return state.profiles.map((p) => ({ ...p, status: 'active' }));
    },
    rag_vector_sync_document_rows(args) {
      const tenantKey = String(args.p_tenant_key);
      const after = (args.p_after as string | null) ?? null;
      return [...state.chunks.values()]
        .filter((c) => c.document_id === args.p_document_id && servable(c, tenantKey))
        .filter((c) => after === null || c.id > after)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, Number(args.p_limit))
        .map(toRow);
    },
    rag_vector_sync_reconcile_summary(args) {
      const tenantKey = String(args.p_tenant_key);
      const buckets = Array.from({ length: 64 }, (_, bucket) => ({ bucket, row_count: 0, ix: 0n, cx: 0n }));
      for (const chunk of servableOf(tenantKey)) {
        const row = toRow(chunk);
        const m = md5(row.chunk_id);
        const b = buckets[parseInt(m.slice(0, 2), 16) % 64];
        b.row_count += 1;
        b.ix ^= signed64(m);
        b.cx ^= signed64(md5(`${row.chunk_id}:${row.content_hash ?? ''}:${row.lexical_version ?? ''}`));
      }
      return buckets.map((b) => ({ bucket: b.bucket, row_count: b.row_count, id_xor: b.ix.toString(), content_xor: b.cx.toString() }));
    },
    rag_vector_sync_bucket_rows(args) {
      const tenantKey = String(args.p_tenant_key);
      const after = (args.p_after as string | null) ?? null;
      return servableOf(tenantKey)
        .filter((c) => parseInt(md5(c.id).slice(0, 2), 16) % 64 === Number(args.p_bucket))
        .filter((c) => after === null || c.id > after)
        .slice(0, Number(args.p_limit))
        .map((c) => {
          const row = toRow(c);
          return { chunk_id: row.chunk_id, document_id: row.document_id, content_hash: row.content_hash, lexical_version: row.lexical_version };
        });
    },
    rag_vector_sync_tenants(args) {
      const t = String(args.p_target);
      if (!state.enabledTargets.has(t)) return [];
      const keys = new Set<string>();
      for (const chunk of state.chunks.values()) if (servable(chunk, chunk.tenant_key)) keys.add(chunk.tenant_key);
      for (const s of state.indexState.values()) if (s.target === t && s.profile_id === args.p_profile_id) keys.add(s.tenant_key);
      return [...keys]
        .map((key) => {
          const s = state.indexState.get(`${t}|${args.p_profile_id}|${key}`);
          return { tenant_key: key, last: s?.last_reconciled_at ?? null };
        })
        .sort((a, b) => (a.last === null ? (b.last === null ? 0 : -1) : b.last === null ? 1 : a.last - b.last) || (a.tenant_key < b.tenant_key ? -1 : 1))
        .map((r) => ({ tenant_key: r.tenant_key, last_reconciled_at: r.last === null ? null : new Date(r.last).toISOString() }));
    },
    rag_vector_sync_enqueue_repair(args) {
      if (!['weaviate', 'qdrant'].includes(String(args.p_target))) throw Object.assign(new Error('invalid_target'), { code: '22023' });
      if (!['chunk', 'document', 'tenant'].includes(String(args.p_entity))) throw Object.assign(new Error('invalid_entity'), { code: '22023' });
      if (args.p_target !== target || !state.enabledTargets.has(target)) return 0;
      return enqueueDedupe(
        args.p_entity as FakeOutboxRow['entity'],
        String(args.p_entity_id),
        String(args.p_tenant_key),
        (args.p_profile_id as string | null) ?? null,
      );
    },
    rag_set_backend_index_state(args) {
      const key = `${args.p_target}|${args.p_profile_id}|${args.p_tenant_key}`;
      const asked = String(args.p_state);
      if (!['ready', 'stale', 'failed'].includes(asked)) throw Object.assign(new Error('invalid_state'), { code: '22023' });
      const found = state.indexState.get(key);
      const next = asked === 'stale' && (!found || found.state === 'building') ? 'building' : (asked as FakeIndexState['state']);
      const error = asked === 'failed' ? (/^[a-z0-9_.:-]{1,200}$/.test(String(args.p_error)) ? String(args.p_error) : 'store_error') : null;
      state.indexState.set(key, {
        target: String(args.p_target),
        profile_id: String(args.p_profile_id),
        tenant_key: String(args.p_tenant_key),
        state: next,
        last_reconciled_at: clock.now(),
        supabase_count: (args.p_supabase_count as number | null) ?? null,
        backend_count: (args.p_backend_count as number | null) ?? null,
        last_error: error,
      });
      return next;
    },
    rag_vector_sync_prune(args) {
      const cutoff = clock.now() - Number(args.p_days) * 86_400_000;
      let n = 0;
      for (let i = state.outbox.length - 1; i >= 0; i -= 1) {
        const o = state.outbox[i];
        if (o.status === 'done' && Date.parse(o.enqueued_at) < cutoff) {
          state.outbox.splice(i, 1);
          n += 1;
        }
      }
      return n;
    },
    rag_vector_sync_chunk_row(args) {
      const chunk = state.chunks.get(String(args.p_chunk_id));
      return chunk && servable(chunk, String(args.p_tenant_key)) ? [toRow(chunk)] : [];
    },
  };

  state.client = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          const run = async (): Promise<RpcResponse> => {
            state.calls.push({ fn, args });
            const injected = failures.get(fn);
            if (injected !== undefined) {
              failures.delete(fn);
              return { data: null, error: { message: 'injected', code: injected } };
            }
            const handler = handlers[fn];
            if (!handler) return { data: null, error: { message: 'unknown function', code: 'PGRST202' } };
            try {
              const data = handler(args);
              state.onCall?.(fn, args);
              return { data, error: null };
            } catch (error) {
              return { data: null, error: { message: 'refused', code: (error as { code?: string }).code ?? 'P0001' } };
            }
          };
          return run().then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return state;
}

export { NIL };
