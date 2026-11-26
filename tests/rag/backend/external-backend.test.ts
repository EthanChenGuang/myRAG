import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { BackendNotReadyError, createExternalBackend, type ExternalStoreReader } from '@/lib/rag/backend/external';
import { RetrievalBackendError, type RpcClient, type RpcRequest, type RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { canonicalTenantKey } from '@/lib/rag/backend/tenant-key';
import type { BackendSearchRequest } from '@/lib/rag/backend/types';
import { createFakeVectorStore, type FakeVectorStore } from '@/lib/rag/sync/stores/fake';
import type { StoreLegs } from '@/lib/rag/sync/stores/types';
import { mintScope, type TenantScope } from '@/lib/rag/tenant/scope';
import { createEmptyFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { startFakeEdge, type FakeEdge } from '../../../eval/harness/fake-edge.mts';
import { IDS, PROFILE_ID } from '../backend-conformance/dataset';
import { seedExternalStore } from '../backend-conformance/external-seed';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const A = '00000000-0000-4000-8000-00000000aa01';
const B = '00000000-0000-4000-8000-00000000aa02';
const C = '00000000-0000-4000-8000-00000000aa03';
const X = '00000000-0000-4000-8000-00000000aa99';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    chunk_id: id,
    document_id: '00000000-0000-4000-8000-00000000dd01',
    content: `supabase body ${id.slice(-4)}`,
    metadata: { from: 'supabase' },
    chunk_index: 0,
    doc_type: 'general',
    language: 'en',
    parent_id: null,
    section_path: ['s'],
    chunk_kind: 'text',
    document_filename: 'neutral.md',
    document_created_at: '2025-01-01T00:00:00Z',
    document_metadata: { name: 'neutral' },
    document_content_preview: 'preview',
    ...extra,
  };
}

function rpcClient(response: RpcResponse): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, args });
          return Promise.resolve(response).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function reader(legs: StoreLegs): ExternalStoreReader & { searchLegs: ReturnType<typeof vi.fn> } {
  return {
    target: 'qdrant',
    searchLegs: vi.fn(async () => legs),
    health: async () => ({ ok: true }),
  };
}

function request(scope: TenantScope): BackendSearchRequest {
  return {
    scope,
    embeddingProfileId: PROFILE_ID,
    denseVector: [0.1, 0.2],
    lexicalTokens: ['neutral'],
    lexicalLanguages: null,
    filters: { currentOnly: true },
    denseLimit: 10,
    lexicalLimit: 10,
    signal: new AbortController().signal,
  };
}

const LEGS: StoreLegs = {
  dense: [
    { id: A, score: 0.9 },
    { id: X, score: 0.8 },
    { id: B, score: 0.7 },
  ],
  lexical: [
    { id: X, score: 5 },
    { id: C, score: 3 },
  ],
};

describe('createExternalBackend: re-validation and hydration (D-10)', () => {
  const scope = mintScope('personal', USER_A, null);

  it('dropped ids never reach the result; ranks are renumbered per leg in store order; one [RAG Security] line with counts only', async () => {
    const { client, calls } = rpcClient({ data: [row(A), row(B), row(C)], error: null });
    const lines: string[] = [];
    const backend = createExternalBackend({ reader: reader(LEGS), adminClient: () => client, securityLog: (line) => lines.push(line) });
    const legs = await backend.search(request(scope));

    expect(legs.dense.map((hit) => [hit.chunkId, hit.rank, hit.similarity])).toEqual([
      [A, 1, 0.9],
      [B, 2, 0.7],
    ]);
    expect(legs.lexical.map((hit) => [hit.chunkId, hit.rank, hit.lexicalScore])).toEqual([[C, 1, 3]]);
    expect(legs.meta?.tenantValidationDropped).toBe(1);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('rag_validate_chunks');
    expect(calls[0]?.args.p_tenant_key).toBe(canonicalTenantKey(scope));
    expect(calls[0]?.args.p_profile_id).toBe(PROFILE_ID);
    expect([...(calls[0]?.args.p_ids as string[])].sort()).toEqual([A, B, C, X].sort());

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[RAG Security\] /);
    expect(JSON.parse(lines[0]!.slice('[RAG Security] '.length))).toEqual({
      event: 'tenant_validation_dropped',
      backend: 'qdrant',
      requested: 4,
      dropped: 1,
    });
    for (const secret of [X, A, canonicalTenantKey(scope), USER_A, 'supabase body']) expect(lines[0]).not.toContain(secret);
  });

  it('content, metadata and document fields come from the RPC rows; a text field in the store answer is ignored', async () => {
    const planted = {
      dense: [{ id: A, score: 0.5, content: 'vendor text', metadata: { from: 'vendor' }, document: { filename: 'vendor.md' } }],
      lexical: [],
    } as unknown as StoreLegs;
    const { client } = rpcClient({ data: [row(A)], error: null });
    const backend = createExternalBackend({ reader: reader(planted), adminClient: () => client, securityLog: () => undefined });
    const [hit] = (await backend.search(request(scope))).dense;
    expect(hit?.content).toBe(`supabase body ${A.slice(-4)}`);
    expect(hit?.metadata).toEqual({ from: 'supabase' });
    expect(hit?.document).toEqual({ filename: 'neutral.md', createdAt: '2025-01-01T00:00:00Z', metadata: { name: 'neutral' }, contentPreview: 'preview' });
    expect(JSON.stringify(hit)).not.toContain('vendor');
  });

  it('zero dropped ids logs nothing', async () => {
    const { client } = rpcClient({ data: [row(A), row(B), row(C), row(X)], error: null });
    const lines: string[] = [];
    const backend = createExternalBackend({ reader: reader(LEGS), adminClient: () => client, securityLog: (line) => lines.push(line) });
    const legs = await backend.search(request(scope));
    expect(legs.meta?.tenantValidationDropped).toBe(0);
    expect(lines).toEqual([]);
  });

  it('a null admin client throws admin_unavailable; an RPC error throws with its code, never an empty result', async () => {
    const noAdmin = createExternalBackend({ reader: reader(LEGS), adminClient: () => null, securityLog: () => undefined });
    await expect(noAdmin.search(request(scope))).rejects.toMatchObject({ name: 'RetrievalBackendError', rpc: 'rag_validate_chunks', code: 'admin_unavailable' });

    const { client } = rpcClient({ data: null, error: { message: 'permission denied', code: '42501' } });
    const failing = createExternalBackend({ reader: reader(LEGS), adminClient: () => client, securityLog: () => undefined });
    const error = await failing.search(request(scope)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetrievalBackendError);
    expect((error as RetrievalBackendError).code).toBe('42501');
  });

  it('an unminted scope throws before the store is called', async () => {
    const store = reader(LEGS);
    const { client, calls } = rpcClient({ data: [], error: null });
    const backend = createExternalBackend({ reader: store, adminClient: () => client, securityLog: () => undefined });
    const forged = { kind: 'personal', userId: USER_A, organizationId: null } as unknown as TenantScope;
    await expect(backend.search(request(forged))).rejects.toThrow(/\[RAG Tenant\]/);
    expect(store.searchLegs).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('a store without the tenant partition surfaces BackendNotReadyError (mapped to backend_not_ready by the factory)', async () => {
    const store = createFakeVectorStore('qdrant');
    await store.ensureCollection({ profileId: PROFILE_ID, dims: 2 });
    const { client } = rpcClient({ data: [], error: null });
    const backend = createExternalBackend({ reader: store, adminClient: () => client, securityLog: () => undefined });
    await expect(backend.search(request(scope))).rejects.toBeInstanceOf(BackendNotReadyError);
  });
});

describe('seedExternalStore: the conformance dataset through outbox and drain', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let store: FakeVectorStore;

  beforeAll(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseGrants: true })).db;
    edge = await startFakeEdge({ db });
    store = createFakeVectorStore('qdrant');
    await seedExternalStore({ db, edge, store, target: 'qdrant', profileId: PROFILE_ID });
  }, 120_000);

  afterAll(async () => {
    await edge?.close();
    await db?.close();
  });

  it('leaves one point per servable chunk per tenant and none for superseded or quarantined chunks', async () => {
    const tenants = (await db.query<{ k: string }>('SELECT DISTINCT tenant_key AS k FROM document_chunks ORDER BY 1')).rows.map((r) => r.k);
    expect(tenants.length).toBeGreaterThanOrEqual(3);
    for (const key of tenants) {
      const servable = (
        await db.query<{ id: string }>(
          `SELECT s.chunk_id::text AS id FROM rag_servable_chunks s JOIN document_chunks c ON c.id = s.chunk_id
            WHERE s.tenant_key = $1 AND c.embedding IS NOT NULL ORDER BY 1`,
          [key],
        )
      ).rows.map((r) => r.id);
      expect(store.points(PROFILE_ID, key).map((point) => point.id)).toEqual(servable);
    }
    const everywhere = tenants.flatMap((key) => store.points(PROFILE_ID, key).map((point) => point.id));
    expect(everywhere).not.toContain(IDS.chunkSuperseded);
    expect(everywhere).not.toContain(IDS.chunkQuarantined);
    expect(new Set(everywhere).size).toBe(everywhere.length);
    const outbox = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM vector_sync_outbox WHERE status IN ('pending', 'leased')");
    expect(outbox.rows[0]?.n).toBe(0);
  });
});
