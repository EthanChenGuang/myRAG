import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { backendForRequest, resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { exactIdLookup } from '@/lib/rag/retrieval/exact-id';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const PROFILE = 'openai-3-small-1536';

function recordingClient(rows: Record<string, unknown>[] = []) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, args });
          return Promise.resolve<RpcResponse>({ data: rows, error: null }).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function request(over: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  return {
    scope: mintScope('personal', USER_A, null),
    embeddingProfileId: PROFILE,
    denseVector: [0.1, 0.2, 0.3],
    lexicalTokens: ['term'],
    lexicalLanguages: null,
    filters: { currentOnly: true },
    denseLimit: 5,
    lexicalLimit: 5,
    signal: new AbortController().signal,
    ...over,
  };
}

function backendWith(rows: Record<string, unknown>[] = []) {
  const { client, calls } = recordingClient(rows);
  const config = loadRagConfig({ RAG_PIPELINE: 'v2' });
  return { backend: createPgvectorBackend({ adminClient: () => client, getConfig: () => config }), calls };
}

const ROW = {
  leg: 'lexical',
  rank: 1,
  chunk_id: '00000000-0000-4000-8000-000000000001',
  document_id: '00000000-0000-4000-8000-000000000002',
  content: 'neutral sample body',
  metadata: {},
  chunk_index: 0,
  similarity: null,
  lexical_score: 0.5,
  doc_type: 'general',
  language: 'en',
  parent_id: null,
  section_path: [],
  chunk_kind: null,
  document_filename: 'sample.md',
  document_created_at: null,
  document_metadata: {},
  document_content_preview: 'neutral',
  dense_mode: 'n/a',
};

beforeEach(() => {
  resetRagConfigForTests();
  resetRetrievalBackendForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRetrievalBackendForTests();
  resetRagConfigForTests();
});

describe('pgvector request fields (D-12, D-31, D-45)', () => {
  it('a request without versionScope and identifiersNorm sends exactly the keys it sent before', async () => {
    const { backend, calls } = backendWith();
    await backend.search(request());
    expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(
      [
        'p_tenant_key',
        'p_profile_id',
        'p_query_embedding',
        'p_lexical_tokens',
        'p_dense_limit',
        'p_lexical_limit',
        'p_date_from',
        'p_date_to',
        'p_sources',
        'p_document_ids',
        'p_doc_types',
        'p_languages',
        'p_iterative_scan',
        'p_exact_scan_cutoff',
        'p_lexical_languages',
        'p_supplier',
        'p_amount_min',
        'p_amount_max',
        'p_currency',
        'p_chunking_override',
      ].sort(),
    );
  });

  it("versionScope 'current' sends nothing; 'all' and a range send p_version_scope", async () => {
    const { backend, calls } = backendWith();
    await backend.search(request({ versionScope: 'current' }));
    await backend.search(request({ versionScope: 'all' }));
    await backend.search(request({ versionScope: { from: '2024-01-01', to: '2024-06-30' } }));
    await backend.search(request({ versionScope: { from: '2024-01-01' } }));
    expect(calls[0]?.args).not.toHaveProperty('p_version_scope');
    expect(calls[1]?.args.p_version_scope).toEqual({ mode: 'all' });
    expect(calls[2]?.args.p_version_scope).toEqual({ mode: 'range', from: '2024-01-01', to: '2024-06-30' });
    expect(calls[3]?.args.p_version_scope).toEqual({ mode: 'range', from: '2024-01-01' });
    for (const call of calls) expect(call.args).not.toHaveProperty('p_identifiers_norm');
  });

  it('identifiersNorm sends p_identifiers_norm', async () => {
    const { backend, calls } = backendWith();
    await backend.search(request({ identifiersNorm: ['x1'] }));
    expect(calls[0]?.args.p_identifiers_norm).toEqual(['x1']);
    expect(calls[0]?.args).not.toHaveProperty('p_version_scope');
  });

  it('hits expose dupClusterId, isCurrent and documentVersion from the trailing columns; an older row maps to undefined', async () => {
    const cluster = '00000000-0000-4000-8000-0000000000c9';
    const { backend } = backendWith([
      { ...ROW, dup_cluster_id: cluster, is_current: false, document_version: 3 },
      { ...ROW, rank: 2, chunk_id: '00000000-0000-4000-8000-000000000003', dup_cluster_id: null, is_current: true, document_version: 1 },
      { ...ROW, rank: 3, chunk_id: '00000000-0000-4000-8000-000000000004' },
    ]);
    const legs = await backend.search(request());
    const [first, second, third] = legs.lexical;
    expect(first?.dupClusterId).toBe(cluster);
    expect(first?.isCurrent).toBe(false);
    expect(first?.documentVersion).toBe(3);
    expect(second?.dupClusterId).toBeUndefined();
    expect(second?.isCurrent).toBe(true);
    expect(second?.documentVersion).toBe(1);
    expect(third).not.toHaveProperty('dupClusterId');
    expect(third).not.toHaveProperty('isCurrent');
    expect(third).not.toHaveProperty('documentVersion');
  });

  it('the pgvector backend declares both capabilities', () => {
    const { backend } = backendWith();
    expect(backend.capabilities).toEqual({ versionScope: true, identifierFilter: true });
  });
});

describe('exactIdLookup pass-through', () => {
  const tokens = [{ value: 'AB-1234', kind: 'model' as const }];

  it('sends nothing new when unset, and both values when set', async () => {
    const { client, calls } = recordingClient();
    const scope = mintScope('personal', USER_A, null);
    const signal = new AbortController().signal;
    await exactIdLookup(scope, tokens as never, { client, signal });
    await exactIdLookup(scope, tokens as never, { client, signal, versionScope: 'current' });
    await exactIdLookup(scope, tokens as never, { client, signal, versionScope: 'all', identifiersNorm: ['ab1234'] });
    await exactIdLookup(scope, tokens as never, { client, signal, versionScope: { to: '2024-12-31' } });
    expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(['p_limit', 'p_tenant_key', 'p_tokens']);
    expect(Object.keys(calls[1]?.args ?? {}).sort()).toEqual(['p_limit', 'p_tenant_key', 'p_tokens']);
    expect(calls[2]?.args.p_version_scope).toEqual({ mode: 'all' });
    expect(calls[2]?.args.p_identifiers_norm).toEqual(['ab1234']);
    expect(calls[3]?.args.p_version_scope).toEqual({ mode: 'range', to: '2024-12-31' });
  });
});

describe('backendForRequest (research pitfall 13)', () => {
  const bare = (id: RetrievalBackend['id'], capabilities?: RetrievalBackend['capabilities']): RetrievalBackend => ({
    id,
    ...(capabilities ? { capabilities } : {}),
    search: async () => ({ dense: [], lexical: [] }),
    health: async () => ({ ok: true }),
    isReady: async () => true,
  });

  it('a request without a new field always gets the selected backend', () => {
    const external = bare('qdrant');
    setRetrievalBackendForTests(external);
    expect(backendForRequest(request())).toEqual({ backend: external });
    expect(backendForRequest(request({ versionScope: 'current' }))).toEqual({ backend: external });
  });

  it('a backend that declares every field the request carries serves it', () => {
    const external = bare('qdrant', { versionScope: true, identifierFilter: true });
    setRetrievalBackendForTests(external);
    expect(backendForRequest(request({ versionScope: 'all', identifiersNorm: ['x1'] }))).toEqual({ backend: external });
  });

  it('a field the selected backend does not declare goes to pgvector with backend_field_unsupported', () => {
    const external = bare('qdrant', { versionScope: true });
    setRetrievalBackendForTests(external);
    const routed = backendForRequest(request({ identifiersNorm: ['x1'] }));
    expect(routed.backend.id).toBe('pgvector');
    expect(routed.backend).not.toBe(external);
    expect(routed.backend.capabilities).toEqual({ versionScope: true, identifierFilter: true });
    expect(routed.reason).toBe('backend_field_unsupported');
    const scoped = backendForRequest(request({ versionScope: { from: '2024-01-01' } }));
    expect(scoped).toEqual({ backend: external });
    setRetrievalBackendForTests(bare('weaviate'));
    expect(backendForRequest(request({ versionScope: 'all' })).reason).toBe('backend_field_unsupported');
  });
});
