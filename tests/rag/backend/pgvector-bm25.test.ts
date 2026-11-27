import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import {
  EmbeddingProfileMismatchError,
  RetrievalBackendError,
  type RpcClient,
  type RpcRequest,
  type RpcResponse,
} from '@/lib/rag/backend/supabase-rpc';
import { bm25CandidateLimit, createPgvectorBackend } from '@/lib/rag/backend/pgvector';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetLexstatsCacheForTests } from '@/lib/rag/lexical/stats';
import type { BackendSearchRequest } from '@/lib/rag/backend/types';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const PROFILE = 'openai-3-small-1536';
const SCORING = { mode: 'bm25' as const, k1: 1.4, b: 0.6 };

type Handler = (args: Record<string, unknown>) => Promise<RpcResponse> | RpcResponse;

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function fakeClient(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      let signal: AbortSignal | undefined;
      const request: RpcRequest = {
        abortSignal(next) {
          signal = next;
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, args });
          if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError')).then(onFulfilled, onRejected);
          const handler = handlers[fn];
          const settled = handler ? Promise.resolve(handler(args)) : Promise.resolve({ data: null, error: { message: 'no handler', code: 'PGRST202' } });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function row(leg: 'dense' | 'lexical', rank: number, id: string, over: Record<string, unknown> = {}) {
  return {
    leg,
    rank,
    chunk_id: id,
    document_id: '00000000-0000-4000-8000-0000000000d1',
    content: `synthetic body ${id}`,
    metadata: {},
    chunk_index: rank,
    similarity: leg === 'dense' ? 0.8 : null,
    lexical_score: leg === 'lexical' ? 0.5 : null,
    doc_type: 'general',
    language: 'en',
    parent_id: null,
    section_path: [],
    chunk_kind: null,
    document_filename: 'f.md',
    document_created_at: null,
    document_metadata: {},
    document_content_preview: 'preview',
    dense_mode: leg === 'dense' ? 'ann' : 'n/a',
    ...over,
  };
}

const READY: Handler = () => ({ data: { state: 'ready', chunk_count: 10, pending: 0 }, error: null });
const NOT_READY: Handler = () => ({ data: { state: 'building', chunk_count: 10, pending: 3 }, error: null });

function baseRequest(over: Partial<BackendSearchRequest> = {}): BackendSearchRequest {
  return {
    scope: mintScope('personal', USER_A, null),
    embeddingProfileId: PROFILE,
    denseVector: [0.1, 0.2, 0.3],
    lexicalTokens: ['w1', 'w2'],
    lexicalLanguages: null,
    access: { mode: 'off' },
    filters: { currentOnly: true },
    denseLimit: 5,
    lexicalLimit: 7,
    signal: new AbortController().signal,
    ...over,
  };
}

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', ...over });
}

const DEFAULT_ARGS = {
  p_tenant_key: `u:${USER_A}`,
  p_profile_id: PROFILE,
  p_query_embedding: [0.1, 0.2, 0.3],
  p_lexical_tokens: ['w1', 'w2'],
  p_dense_limit: 5,
  p_lexical_limit: 7,
  p_date_from: null,
  p_date_to: null,
  p_sources: null,
  p_document_ids: null,
  p_doc_types: null,
  p_languages: null,
  p_iterative_scan: 'off',
  p_exact_scan_cutoff: 0,
  p_lexical_languages: null,
  p_supplier: null,
  p_amount_min: null,
  p_amount_max: null,
  p_currency: null,
  p_chunking_override: null,
};

const FILTERED: Partial<BackendSearchRequest> = {
  filters: {
    currentOnly: true,
    dateRange: { from: '2025-01-01', to: '2025-06-30', includeUndated: true },
    sources: ['upload'],
    docTypes: ['general'],
    languages: ['en'],
    scopes: ['area:one'],
    scopesIncludeUntagged: true,
    effectiveOn: '2025-03-01',
  },
  lexicalLanguages: ['en'],
  chunkingProfileOverride: { general: 'legacy' },
};

const FILTERED_ARGS = {
  ...DEFAULT_ARGS,
  p_date_from: '2025-01-01',
  p_date_to: '2025-06-30',
  p_sources: ['upload'],
  p_doc_types: ['general'],
  p_languages: ['en'],
  p_lexical_languages: ['en'],
  p_chunking_override: { general: 'legacy' },
  p_include_undated: true,
  p_scopes: ['area:one'],
  p_scopes_include_untagged: true,
  p_effective_on: '2025-03-01',
};

const VERSIONED: Partial<BackendSearchRequest> = { versionScope: { from: '2024-01-01' }, identifiersNorm: ['ab12'] };
const VERSIONED_ARGS = { ...DEFAULT_ARGS, p_version_scope: { mode: 'range', from: '2024-01-01' }, p_identifiers_norm: ['ab12'] };

beforeEach(() => {
  resetRagConfigForTests();
  resetLexstatsCacheForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLexstatsCacheForTests();
  resetRagConfigForTests();
});

describe('pgvector backend without lexicalScoring (D-02)', () => {
  it.each([
    ['filter-free', {}, DEFAULT_ARGS],
    ['filtered', FILTERED, FILTERED_ARGS],
    ['version-scoped', VERSIONED, VERSIONED_ARGS],
  ])('sends one hybrid_search_chunks call with today\'s arguments (%s) and no other RPC', async (_name, over, expected) => {
    const { client, calls } = fakeClient({ hybrid_search_chunks: () => ({ data: [row('dense', 1, 'c1'), row('lexical', 1, 'c2')], error: null }), rag_lexstats_status: READY });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const legs = await backend.search(baseRequest(over));
    expect(calls).toEqual([{ fn: 'hybrid_search_chunks', args: expected }]);
    expect(legs.meta).toEqual({ denseMode: 'ann' });
  });
});

describe('pgvector backend with lexicalScoring', () => {
  it('runs the dense hybrid call and the BM25 call in parallel and merges their legs', async () => {
    const dense = deferred<RpcResponse>();
    const bm25 = deferred<RpcResponse>();
    const { client, calls } = fakeClient({
      rag_lexstats_status: READY,
      hybrid_search_chunks: () => dense.promise,
      rag_bm25_search_chunks: () => bm25.promise,
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const pending = backend.search(baseRequest({ ...FILTERED, lexicalScoring: SCORING }));
    await vi.waitFor(() => expect(calls.map((call) => call.fn)).toEqual(['rag_lexstats_status', 'hybrid_search_chunks', 'rag_bm25_search_chunks']));
    dense.resolve({ data: [row('dense', 1, 'c1')], error: null });
    bm25.resolve({ data: [row('lexical', 1, 'c9', { lexical_score: 3.25 }), row('lexical', 2, 'c8', { lexical_score: 1.5 })], error: null });
    const legs = await pending;

    expect(calls[1]?.args).toEqual({ ...FILTERED_ARGS, p_lexical_limit: 0 });
    const { p_dense_limit: _d, p_iterative_scan: _i, p_exact_scan_cutoff: _e, ...rest } = FILTERED_ARGS;
    expect(calls[2]?.args).toEqual({ ...rest, p_k1: 1.4, p_b: 0.6, p_candidate_limit: 500 });
    expect(legs.dense.map((hit) => hit.chunkId)).toEqual(['c1']);
    expect(legs.lexical.map((hit) => [hit.chunkId, hit.lexicalScore])).toEqual([
      ['c9', 3.25],
      ['c8', 1.5],
    ]);
    expect(legs.meta).toEqual({ denseMode: 'ann', lexicalScoring: 'bm25' });
  });

  it('carries the version scope and identifiers into the BM25 call', async () => {
    const { client, calls } = fakeClient({
      rag_lexstats_status: READY,
      hybrid_search_chunks: () => ({ data: [], error: null }),
      rag_bm25_search_chunks: () => ({ data: [], error: null }),
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    await backend.search(baseRequest({ ...VERSIONED, lexicalScoring: SCORING }));
    const bm25 = calls.find((call) => call.fn === 'rag_bm25_search_chunks');
    expect(bm25?.args.p_version_scope).toEqual({ mode: 'range', from: '2024-01-01' });
    expect(bm25?.args.p_identifiers_norm).toEqual(['ab12']);
  });

  it('sends only the BM25 call when the dense limit is 0 (terminology leg)', async () => {
    const { client, calls } = fakeClient({ rag_lexstats_status: READY, rag_bm25_search_chunks: () => ({ data: [row('lexical', 1, 'c3')], error: null }) });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const legs = await backend.search(baseRequest({ denseVector: null, denseLimit: 0, lexicalScoring: SCORING }));
    expect(calls.map((call) => call.fn)).toEqual(['rag_lexstats_status', 'rag_bm25_search_chunks']);
    expect(legs.dense).toEqual([]);
    expect(legs.lexical.map((hit) => hit.chunkId)).toEqual(['c3']);
    expect(legs.meta).toEqual({ denseMode: null, lexicalScoring: 'bm25' });
  });

  it.each([
    ['empty tokens', { lexicalTokens: [] } as Partial<BackendSearchRequest>],
    ['lexical limit 0', { lexicalLimit: 0 } as Partial<BackendSearchRequest>],
  ])('sends only today\'s hybrid call with %s', async (_name, over) => {
    const { client, calls } = fakeClient({ rag_lexstats_status: READY, hybrid_search_chunks: () => ({ data: [], error: null }) });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const legs = await backend.search(baseRequest({ ...over, lexicalScoring: SCORING }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('hybrid_search_chunks');
    expect(calls[0]?.args).toEqual({ ...DEFAULT_ARGS, ...(over.lexicalTokens ? { p_lexical_tokens: [] } : { p_lexical_limit: 0 }) });
    expect(legs.meta).toBeUndefined();
  });

  it('serves a tenant that is not ready with today\'s single call and reports stats_unavailable; the status is cached for 60 s', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { client, calls } = fakeClient({ rag_lexstats_status: NOT_READY, hybrid_search_chunks: () => ({ data: [row('lexical', 1, 'c2')], error: null }) });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const legs = await backend.search(baseRequest({ lexicalScoring: SCORING }));
    expect(calls).toEqual([
      { fn: 'rag_lexstats_status', args: { p_tenant_key: `u:${USER_A}` } },
      { fn: 'hybrid_search_chunks', args: DEFAULT_ARGS },
    ]);
    expect(legs.lexical.map((hit) => hit.chunkId)).toEqual(['c2']);
    expect(legs.meta).toEqual({ denseMode: null, lexicalScoring: 'stats_unavailable' });

    now += 59_000;
    await backend.search(baseRequest({ lexicalScoring: SCORING }));
    expect(calls.filter((call) => call.fn === 'rag_lexstats_status')).toHaveLength(1);
    now += 1_000;
    await backend.search(baseRequest({ lexicalScoring: SCORING }));
    expect(calls.filter((call) => call.fn === 'rag_lexstats_status')).toHaveLength(2);
  });

  it('reads readiness per tenant key', async () => {
    const { client, calls } = fakeClient({
      rag_lexstats_status: (args) => (args.p_tenant_key === `u:${USER_A}` ? READY(args) : NOT_READY(args)),
      hybrid_search_chunks: () => ({ data: [], error: null }),
      rag_bm25_search_chunks: () => ({ data: [], error: null }),
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const a = await backend.search(baseRequest({ lexicalScoring: SCORING }));
    const b = await backend.search(baseRequest({ scope: mintScope('personal', USER_B, null), lexicalScoring: SCORING }));
    expect(a.meta?.lexicalScoring).toBe('bm25');
    expect(b.meta?.lexicalScoring).toBe('stats_unavailable');
    expect(calls.filter((call) => call.fn === 'rag_bm25_search_chunks').every((call) => call.args.p_tenant_key === `u:${USER_A}`)).toBe(true);
  });

  it('falls back on lexical_stats_not_ready: keeps the dense rows, fetches the ts_rank_cd lexical leg only and drops the cache entry', async () => {
    const { client, calls } = fakeClient({
      rag_lexstats_status: READY,
      hybrid_search_chunks: (args) =>
        args.p_lexical_limit === 0
          ? { data: [row('dense', 1, 'c1')], error: null }
          : { data: [row('lexical', 1, 'c2', { lexical_score: 0.1 })], error: null },
      rag_bm25_search_chunks: () => ({ data: null, error: { message: 'lexical_stats_not_ready: the tenant has no ready lexical statistics', code: '55000' } }),
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const legs = await backend.search(baseRequest({ lexicalScoring: SCORING }));
    const hybrid = calls.filter((call) => call.fn === 'hybrid_search_chunks');
    expect(hybrid).toHaveLength(2);
    expect(hybrid[0]?.args).toEqual({ ...DEFAULT_ARGS, p_lexical_limit: 0 });
    expect(hybrid[1]?.args).toEqual({ ...DEFAULT_ARGS, p_dense_limit: 0 });
    expect(legs.dense.map((hit) => hit.chunkId)).toEqual(['c1']);
    expect(legs.lexical.map((hit) => [hit.chunkId, hit.lexicalScore])).toEqual([['c2', 0.1]]);
    expect(legs.meta).toEqual({ denseMode: 'ann', lexicalScoring: 'stats_unavailable' });

    await backend.search(baseRequest({ lexicalScoring: SCORING }));
    expect(calls.filter((call) => call.fn === 'rag_lexstats_status')).toHaveLength(2);
  });

  it('falls back on any other BM25 error with bm25_failed and one log line carrying the rpc name and code only', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { client, calls } = fakeClient({
      rag_lexstats_status: READY,
      hybrid_search_chunks: (args) =>
        args.p_lexical_limit === 0 ? { data: [row('dense', 1, 'c1')], error: null } : { data: [row('lexical', 1, 'c2')], error: null },
      rag_bm25_search_chunks: () => ({ data: null, error: { message: 'statement timeout w1', code: '57014' } }),
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const legs = await backend.search(baseRequest({ lexicalScoring: SCORING }));
    expect(legs.dense.map((hit) => hit.chunkId)).toEqual(['c1']);
    expect(legs.lexical.map((hit) => hit.chunkId)).toEqual(['c2']);
    expect(legs.meta).toEqual({ denseMode: 'ann', lexicalScoring: 'bm25_failed' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('Document Search', 'rag_bm25_search_chunks failed', { rpc: 'rag_bm25_search_chunks', code: '57014' });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('w1');
    expect(calls.filter((call) => call.fn === 'hybrid_search_chunks')[1]?.args.p_dense_limit).toBe(0);
  });

  it('falls back when the BM25 call itself rejects without an abort', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { client } = fakeClient({
      rag_lexstats_status: READY,
      hybrid_search_chunks: () => ({ data: [row('lexical', 1, 'c2')], error: null }),
      rag_bm25_search_chunks: () => Promise.reject(new TypeError('fetch failed')),
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const legs = await backend.search(baseRequest({ lexicalScoring: SCORING }));
    expect(legs.meta?.lexicalScoring).toBe('bm25_failed');
    expect(legs.lexical.map((hit) => hit.chunkId)).toEqual(['c2']);
  });

  it('throws a dense hybrid error exactly as today', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const failing = (message: string, code: string) =>
      fakeClient({
        rag_lexstats_status: READY,
        hybrid_search_chunks: () => ({ data: null, error: { message, code } }),
        rag_bm25_search_chunks: () => ({ data: [], error: null }),
      }).client;
    const mismatch = createPgvectorBackend({ adminClient: () => failing('embedding_profile_mismatch: dims', '22000'), getConfig: () => config() });
    await expect(mismatch.search(baseRequest({ lexicalScoring: SCORING }))).rejects.toBeInstanceOf(EmbeddingProfileMismatchError);
    const other = createPgvectorBackend({ adminClient: () => failing('boom', 'XX000'), getConfig: () => config() });
    const error = await other.search(baseRequest({ lexicalScoring: SCORING })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetrievalBackendError);
    expect((error as RetrievalBackendError).rpc).toBe('hybrid_search_chunks');
    expect((error as RetrievalBackendError).code).toBe('XX000');
  });

  it('rejects an aborted request without a fallback call', async () => {
    const controller = new AbortController();
    const bm25 = deferred<RpcResponse>();
    const { client, calls } = fakeClient({
      rag_lexstats_status: READY,
      hybrid_search_chunks: () => ({ data: [], error: null }),
      rag_bm25_search_chunks: () => bm25.promise,
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config() });
    const pending = backend.search(baseRequest({ signal: controller.signal, lexicalScoring: SCORING }));
    await vi.waitFor(() => expect(calls.some((call) => call.fn === 'rag_bm25_search_chunks')).toBe(true));
    controller.abort();
    bm25.resolve({ data: null, error: { message: 'canceling statement', code: '57014' } });
    await expect(pending).rejects.toBeDefined();
    expect(calls.filter((call) => call.fn === 'hybrid_search_chunks')).toHaveLength(1);
  });

  it('derives the BM25 arguments from the hybrid arguments, so a later filter argument reaches both', async () => {
    const pgvector = await import('@/lib/rag/backend/pgvector');
    const hybrid = { ...DEFAULT_ARGS, p_future_filter: ['x'] };
    const derived = pgvector.bm25ArgsFrom(hybrid, SCORING, 7);
    expect(derived.p_future_filter).toEqual(['x']);
    expect(derived).not.toHaveProperty('p_dense_limit');
    expect(derived).not.toHaveProperty('p_iterative_scan');
    expect(derived).not.toHaveProperty('p_exact_scan_cutoff');
    expect(derived).toMatchObject({ p_k1: 1.4, p_b: 0.6, p_candidate_limit: 500, p_lexical_limit: 7 });
  });

  it('bm25CandidateLimit is min(2000, max(500, 5 x lexical limit))', () => {
    expect(bm25CandidateLimit(1)).toBe(500);
    expect(bm25CandidateLimit(100)).toBe(500);
    expect(bm25CandidateLimit(101)).toBe(505);
    expect(bm25CandidateLimit(200)).toBe(1000);
    expect(bm25CandidateLimit(1000)).toBe(2000);
  });
});

describe('pgvector backend with lexicalScoring and an access filter (04.3-03, 0932)', () => {
  const GROUP = 'g:00000000-0000-4000-8000-0000000000f1';
  const accessRequest = async (mode: 'keys' | 'admin_all', keys: string[]) => {
    const { mintAccessScope, scopeAccessFilter } = await import('@/lib/rag/tenant/access');
    const { withAccess } = await import('@/lib/rag/tenant/scope');
    const scope = withAccess(mintScope('personal', USER_A, null), mintAccessScope(mode, keys));
    return { scope, access: scopeAccessFilter(scope) };
  };

  it.each([
    ['keys', ['all', GROUP], { p_access_keys: ['all', GROUP], p_access_all: false }],
    ['admin_all', [], { p_access_keys: ['all'], p_access_all: true }],
  ] as const)('the BM25 call carries the same access arguments as the dense call (%s)', async (mode, keys, expected) => {
    const { client, calls } = fakeClient({
      rag_lexstats_status: READY,
      hybrid_search_chunks: () => ({ data: [row('dense', 1, 'c1')], error: null }),
      rag_bm25_search_chunks: () => ({ data: [row('lexical', 1, 'c9')], error: null }),
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config(), pgvectorVersion: () => '0.8.0' });
    const { scope, access } = await accessRequest(mode, [...keys]);
    await backend.search(baseRequest({ scope, access, lexicalScoring: SCORING }));
    const dense = calls.find((call) => call.fn === 'hybrid_search_chunks')!.args;
    const bm25 = calls.find((call) => call.fn === 'rag_bm25_search_chunks')!.args;
    const pick = (args: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(args).filter(([key]) => key === 'p_access_keys' || key === 'p_access_all'));
    expect(pick(dense)).toEqual(pick(bm25));
    expect(pick(bm25)).toEqual(expected);
  });

  it('the ts_rank_cd fallback after a BM25 failure keeps the access arguments', async () => {
    const { client, calls } = fakeClient({
      rag_lexstats_status: READY,
      hybrid_search_chunks: () => ({ data: [], error: null }),
      rag_bm25_search_chunks: () => ({ data: null, error: { message: 'statement timeout', code: '57014' } }),
    });
    const backend = createPgvectorBackend({ adminClient: () => client, getConfig: () => config(), pgvectorVersion: () => '0.8.0' });
    const { scope, access } = await accessRequest('keys', ['all', GROUP]);
    await backend.search(baseRequest({ scope, access, lexicalScoring: SCORING }));
    const hybrid = calls.filter((call) => call.fn === 'hybrid_search_chunks');
    expect(hybrid.length).toBe(2);
    for (const call of hybrid) expect(call.args.p_access_keys).toEqual(['all', GROUP]);
  });
});
