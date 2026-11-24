import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  EmbeddingProfileMismatchError,
  RetrievalBackendError,
  type RpcClient,
  type RpcRequest,
  type RpcResponse,
} from '@/lib/rag/backend/supabase-rpc';
import { createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { getRetrievalBackend, resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { BackendSearchRequest } from '@/lib/rag/backend/types';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const PROFILE = 'openai-3-small-1536';

interface RecordedCall {
  fn: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

function recordingClient(rows: Record<string, unknown>[] = [], error: RpcResponse['error'] = null) {
  const calls: RecordedCall[] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      let signal: AbortSignal | undefined;
      const request: RpcRequest = {
        abortSignal(next: AbortSignal) {
          signal = next;
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, args, signal });
          if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError')).then(onFulfilled, onRejected);
          }
          const settled = new Promise<RpcResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
              if (signal?.aborted) {
                reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
                return;
              }
              resolve(error ? { data: null, error } : { data: rows, error: null });
            }, 0);
            signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
          });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function baseRequest(over: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  const scope = mintScope('personal', USER_A, null);
  return {
    scope,
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

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', ...over });
}

beforeEach(() => {
  resetRagConfigForTests();
  resetRetrievalBackendForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetRetrievalBackendForTests();
  resetRagConfigForTests();
});

describe('createPgvectorBackend', () => {
  it('rejects an unminted scope before any RPC', async () => {
    const { client } = recordingClient();
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const fakeScope = { kind: 'personal' as const, userId: USER_A, organizationId: null };
    await expect(backend.search(baseRequest({ scope: fakeScope as never }))).rejects.toThrow('[RAG Tenant] unminted scope');
  });

  it('calls hybrid_search_chunks on the admin client with scopeKey as the only tenant input', async () => {
    const rows = [
      {
        leg: 'dense',
        rank: 1,
        chunk_id: '00000000-0000-4000-8000-000000000001',
        document_id: '00000000-0000-4000-8000-000000000002',
        content: 'body',
        metadata: {},
        chunk_index: 0,
        similarity: 0.9,
        lexical_score: null,
        doc_type: 'general',
        language: 'en',
        parent_id: null,
        section_path: [],
        chunk_kind: null,
        document_filename: 'f.md',
        document_created_at: null,
        document_metadata: {},
        document_content_preview: 'preview',
        dense_mode: 'ann',
      },
    ];
    const { client, calls } = recordingClient(rows);
    const cfg = config({ RAG_HNSW_ITERATIVE_SCAN: 'relaxed_order', RAG_EXACT_SCAN_CUTOFF: '50' });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => cfg });
    const scope = mintScope('personal', USER_A, null);
    const legs = await backend.search(
      baseRequest({
        scope,
        filters: {
          currentOnly: true,
          sources: [],
          documentIds: ['00000000-0000-4000-8000-000000000099'],
          docTypes: ['general'],
        },
        lexicalLanguages: ['zh'],
        chunkingProfileOverride: { general: 'legacy' },
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('hybrid_search_chunks');
    expect(calls[0]?.args.p_tenant_key).toBe(`u:${USER_A}`);
    expect(calls[0]?.args.p_sources).toBeNull();
    expect(calls[0]?.args.p_document_ids).toEqual(['00000000-0000-4000-8000-000000000099']);
    expect(calls[0]?.args.p_iterative_scan).toBe('relaxed_order');
    expect(calls[0]?.args.p_exact_scan_cutoff).toBe(50);
    expect(calls[0]?.args.p_lexical_languages).toEqual(['zh']);
    expect(calls[0]?.args.p_chunking_override).toEqual({ general: 'legacy' });
    expect(legs.dense).toHaveLength(1);
    expect(legs.dense[0]?.chunkId).toBe('00000000-0000-4000-8000-000000000001');
    expect(legs.meta?.denseMode).toBe('ann');
  });

  it('throws admin_unavailable when the admin client is null', async () => {
    const backend = createPgvectorBackend({ adminClient: () => null, getConfig: () => config() });
    await expect(backend.search(baseRequest())).rejects.toMatchObject({
      name: 'RetrievalBackendError',
      code: 'admin_unavailable',
      rpc: 'hybrid_search_chunks',
    });
  });

  it('maps SQLSTATE errors to RetrievalBackendError', async () => {
    const { client } = recordingClient([], { message: 'permission denied', code: '42501' });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    await expect(backend.search(baseRequest())).rejects.toBeInstanceOf(RetrievalBackendError);
    await expect(backend.search(baseRequest())).rejects.toMatchObject({ code: '42501' });
  });

  it('turns embedding_profile_mismatch into EmbeddingProfileMismatchError', async () => {
    const { client } = recordingClient([], { message: 'embedding_profile_mismatch: dims', code: '22000' });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    await expect(backend.search(baseRequest())).rejects.toBeInstanceOf(EmbeddingProfileMismatchError);
  });

  it('rejects with the abort reason after postgrest settles', async () => {
    const { client } = recordingClient([]);
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const controller = new AbortController();
    const reason = new DOMException('user abort', 'AbortError');
    controller.abort(reason);
    await expect(backend.search(baseRequest({ signal: controller.signal }))).rejects.toBe(reason);
  });

  it('isReady is always true', async () => {
    const backend = createPgvectorBackend({ adminClient: () => null, getConfig: () => config() });
    await expect(backend.isReady(mintScope('single', null, null))).resolves.toBe(true);
  });

  it('health reports failure without an admin client', async () => {
    const backend = createPgvectorBackend({ adminClient: () => null, getConfig: () => config() });
  await expect(backend.health()).resolves.toMatchObject({ ok: false, detail: 'admin_unavailable' });
  });

  it('health runs a cheap query when the admin client exists', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [{ id: PROFILE }], error: null });
    const select = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ select }));
    const admin = { from, rpc: vi.fn() } as unknown as SupabaseClient;
    const backend = createPgvectorBackend({ adminClient: () => admin, getConfig: () => config() });
    const result = await backend.health();
    expect(from).toHaveBeenCalledWith('embedding_profiles');
    expect(result.ok).toBe(true);
  });
});

describe('retrieval backend registry', () => {
  it('getRetrievalBackend returns pgvector and test override works', () => {
    const { client } = recordingClient();
    const custom = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    setRetrievalBackendForTests(custom);
    expect(getRetrievalBackend()).toBe(custom);
    resetRetrievalBackendForTests();
    expect(getRetrievalBackend().id).toBe('pgvector');
  });
});