import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend, RetrievalFilterInput } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { Profile } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const EXACT_RPC = 'rag_exact_id_documents';
const BASE_ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_EXACT_ID_LOOKUP: 'true' };
const ON = { ...BASE_ENV, RAG_VERSION_SCOPE: 'true' };

function config(env: Record<string, string>): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig(env);
}

interface Harness {
  requests: BackendSearchRequest[];
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
}

function harness(env: Record<string, string>, options: { capable?: boolean } = {}): Harness {
  const requests: BackendSearchRequest[] = [];
  const rpcCalls: Harness['rpcCalls'] = [];
  const legs: BackendLegs = {
    dense: [hit('current', { rank: 1, similarity: 0.8 })],
    lexical: [hit('current', { rank: 1, lexicalScore: 1 }), hit('older', { rank: 2, lexicalScore: 0.9, isCurrent: false, documentVersion: 1 })],
  };
  const backend: RetrievalBackend = {
    id: options.capable === false ? 'qdrant' : 'pgvector',
    ...(options.capable === false ? {} : { capabilities: { versionScope: true, identifierFilter: true } }),
    search: async (req) => {
      requests.push(req);
      return legs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  const rpc: RpcClient = {
    rpc(fn, args): RpcRequest {
      rpcCalls.push({ fn, args: (args ?? {}) as Record<string, unknown> });
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          return Promise.resolve({ data: [], error: null } as RpcResponse).then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  installDeps({ embedder: fakeEmbedder().embedder, adminClient: adminWithRpc(rpc, fakeAssemblyAdmin()), ragEnv: () => env });
  setRetrievalBackendForTests(backend);
  return { requests, rpcCalls };
}

async function run(env: Record<string, string>, profile: Profile, retrievalFilters?: RetrievalFilterInput, query = 'synthetic question FT-2025-00417') {
  const cfg = config(env);
  await verifyV2Startup();
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const output = await runSearchStages({
    input: { scope, query, profile, signal: new AbortController().signal, ...(retrievalFilters ? { retrievalFilters } : {}) },
    scope,
    config: cfg,
    profile,
    params: effectiveRetrievalParams(profile === 'eval' ? 'eval' : profile, cfg, null),
    embedding: { vector: [0.1, 0.2], profile: null },
    signal: new AbortController().signal,
    collector,
  });
  const search = collector.stages().find((row) => row.name === 'search');
  const exact = collector.stages().find((row) => row.name === 'exact_id_lookup');
  return { output, search, exact };
}

describe('runSearchStages version scope (D-12, D-40)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('a default request sends no versionScope, records no version code and reports scope current', async () => {
    const h = harness(ON);
    const { output, search } = await run(ON, 'chat');
    expect(h.requests.length).toBeGreaterThan(0);
    for (const req of h.requests) expect('versionScope' in req).toBe(false);
    expect(search?.detail).toBeUndefined();
    expect(search?.status).toBe('ok');
    expect(output.versionScope).toBe('current');
    const exact = h.rpcCalls.find((call) => call.fn === EXACT_RPC);
    expect(exact && 'p_version_scope' in exact.args).toBe(false);
  });

  it('switch on, versions all: every backend request and the exact-id lookup carry the scope; filters stay currentOnly', async () => {
    const h = harness(ON);
    const { output, search, exact } = await run(ON, 'chat', { versionScope: 'all' });
    expect(h.requests.length).toBeGreaterThan(0);
    for (const req of h.requests) {
      expect(req.versionScope).toBe('all');
      expect(req.filters).toEqual({ currentOnly: true });
    }
    expect(search?.detail?.split(';')).toContain('superseded_dense_unavailable');
    expect(search?.status).toBe('ok');
    expect(search?.counts).toMatchObject({ superseded: 1 });
    expect(exact?.status).toBe('ok');
    const exactCall = h.rpcCalls.find((call) => call.fn === EXACT_RPC);
    expect(exactCall?.args.p_version_scope).toEqual({ mode: 'all' });
    expect(output.versionScope).toBe('all');
  });

  it('a range travels as given', async () => {
    const h = harness(ON);
    await run(ON, 'eval', { versionScope: { from: '2026-01-01', to: '2026-06-30' } });
    for (const req of h.requests) expect(req.versionScope).toEqual({ from: '2026-01-01', to: '2026-06-30' });
  });

  it('the exact-id leg still stands down for a narrowing filter next to a version scope', async () => {
    const h = harness(ON);
    const { exact } = await run(ON, 'chat', { versionScope: 'all', languages: ['en'] });
    expect(exact?.status).toBe('disabled');
    expect(h.rpcCalls.some((call) => call.fn === EXACT_RPC)).toBe(false);
  });

  it.each([
    ['the switch is off', BASE_ENV, 'chat' as Profile],
    ['the profile is voice', ON, 'voice' as Profile],
    ['embed without RAG_EMBED_VERSION_SCOPE', ON, 'embed' as Profile],
  ])('ignores the scope when %s and records versions_ignored', async (_label, env, profile) => {
    const h = harness(env);
    const { output, search } = await run(env, profile, { versionScope: 'all' });
    for (const req of h.requests) expect('versionScope' in req).toBe(false);
    expect(search?.detail?.split(';')).toContain('versions_ignored');
    expect(search?.detail?.split(';')).not.toContain('superseded_dense_unavailable');
    expect(output.versionScope).toBe('current');
  });

  it('embed honours the scope with both switches on', async () => {
    const env = { ...ON, RAG_EMBED_VERSION_SCOPE: 'true' };
    const h = harness(env);
    const { output } = await run(env, 'embed', { versionScope: 'all' });
    for (const req of h.requests) expect(req.versionScope).toBe('all');
    expect(output.versionScope).toBe('all');
  });

  it('a selected backend without the versionScope capability is replaced by pgvector and the stage is degraded', async () => {
    const h = harness(ON, { capable: false });
    const { search } = await run(ON, 'chat', { versionScope: 'all' });
    expect(h.requests).toHaveLength(0);
    const hybrid = h.rpcCalls.filter((call) => call.fn === 'hybrid_search_chunks');
    expect(hybrid.length).toBeGreaterThan(0);
    for (const call of hybrid) expect(call.args.p_version_scope).toEqual({ mode: 'all' });
    expect(search?.status).toBe('degraded');
    expect(search?.detail?.split(';')).toContain('backend_field_unsupported');
  });
});
