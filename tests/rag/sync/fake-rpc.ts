import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

/** An in-memory model of the 0703 outbox lifecycle and the 0705 reads, enough to drive drainSlice without a database. */

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
  enqueue(row: Pick<FakeOutboxRow, 'entity' | 'entity_id' | 'tenant_key'> & Partial<FakeOutboxRow>): FakeOutboxRow;
  addDocument(doc: Partial<FakeDocument> & { id: string; tenant_key: string }, chunks: FakeChunk[]): void;
  /** Called after each RPC with its name; tests use it to move the clock or inject failures. */
  onCall: ((fn: string, args: Record<string, unknown>) => void) | null;
  /** Answers the next call of fn with this error instead of running it. */
  failNext(fn: string, code: string): void;
}

const NIL = '00000000-0000-0000-0000-000000000000';

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

  function toRow(chunk: FakeChunk) {
    const doc = state.documents.get(chunk.document_id) as FakeDocument;
    return {
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      tenant_key: chunk.tenant_key,
      vector: chunk.vector,
      lexical_text: chunk.lexical_text,
      lexical_version: 1,
      content_hash: `h-${chunk.id.slice(-4)}`,
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
