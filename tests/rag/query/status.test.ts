import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { RetrievalBackendError } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { NO_CONTEXT_TEXT } from '@/lib/rag/context/assemble';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { RetrievalResult } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEYWORDS = 'gateway logs';
const SMALL_TALK = 'hello';

type BackendMode = { hits: number } | { fail: true };

function backend(mode: BackendMode, seen: { searches: number }): RetrievalBackend {
  return {
    id: 'pgvector',
    async search() {
      seen.searches += 1;
      if ('fail' in mode) throw new RetrievalBackendError('hybrid_search_chunks', 'XX000');
      const dense = Array.from({ length: mode.hits }, (_, index) =>
        hit(`chunk-${index + 1}`, { rank: index + 1, similarity: 0.9 - index * 0.01, documentId: DOC, chunkIndex: index }),
      );
      return { dense, lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

async function install(options: { entries?: FakeQueryLlmEntry[]; env?: Record<string, string>; backend?: BackendMode } = {}) {
  resetActiveChunkingProfilesForTests();
  const fake = createFakeQueryLlm({ table: { version: 1, entries: options.entries ?? [] } });
  const { embedder } = fakeEmbedder();
  const rpc = fakeRpcClient();
  const seen = { searches: 0 };
  installDeps({
    embedder,
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    queryLlm: () => fake,
    ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', ...options.env }),
  });
  setRetrievalBackendForTests(backend(options.backend ?? { hits: 5 }, seen));
  await verifyV2Startup();
  return { fake, seen };
}

async function run(query: string, options: { ragMode?: 'strict' | 'balanced'; prime?: (collector: ReturnType<typeof createTraceCollector>) => void } = {}) {
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  options.prime?.(collector);
  const result: RetrievalResult = await runRetrieval({
    scope,
    query,
    profile: 'chat',
    options: { ragMode: options.ragMode ?? 'balanced', webSearchEnabled: false },
    signal: new AbortController().signal,
    trace: collector,
  });
  const stages = collector.stages();
  return { result, stages, stage: (name: string) => stages.find((row) => row.name === name) };
}

const HYDE_FAILS: FakeQueryLlmEntry[] = [
  { transform: 'expand', query: KEYWORDS, output: { queries: ['gateway log files'] } },
  { transform: 'hyde', query: KEYWORDS, fail: 'error' },
];

describe('query-layer stages are soft (A-2) and small talk skips retrieval (D-10)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    vi.restoreAllMocks();
  });

  it('a skipped HyDE with five chunks kept is degraded', async () => {
    await install({ entries: HYDE_FAILS, env: { RAG_QUERY_HYDE: 'true' } });
    const { result, stage } = await run(KEYWORDS);
    expect(stage('hyde')?.status).toBe('skipped');
    expect(result.candidates).toHaveLength(5);
    expect(result.status).toBe('degraded');
  });

  it('a skipped HyDE with zero results and every core stage ok stays empty, so strict mode refuses; the skip stays in the trace', async () => {
    await install({ entries: HYDE_FAILS, env: { RAG_QUERY_HYDE: 'true' }, backend: { hits: 0 } });
    const { result, stage } = await run(KEYWORDS, { ragMode: 'strict' });
    expect(stage('embed')?.status).toBe('ok');
    expect(stage('search')?.status).toBe('ok');
    expect(stage('hyde')).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(result.queryPlan?.skipped).toContainEqual({ transform: 'hyde', reason: 'error' });
    expect(result.status).toBe('empty');
    expect(result.context).toBe(NO_CONTEXT_TEXT);
    expect(result.usedDocuments).toEqual([]);
  });

  it('a skipped semantic_cache record never changes the status', async () => {
    await install({ entries: [{ transform: 'expand', query: KEYWORDS, output: { queries: [] } }] });
    const { result } = await run(KEYWORDS, {
      prime: (collector) => {
        const at = collector.now();
        collector.record({ name: 'semantic_cache', status: 'skipped', reason: 'timeout', startedAt: at, endedAt: at });
      },
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.status).toBe('ok');
  });

  it('expand disabled by config is ok, not degraded', async () => {
    const { fake } = await install({ env: { RAG_QUERY_EXPAND: 'false' } });
    const { result, stage } = await run(KEYWORDS);
    expect(fake.calls).toEqual([]);
    expect(stage('expand')?.status).toBe('disabled');
    expect(result.status).toBe('ok');
  });

  it('a backend error with a skipped transform is error: core failures win', async () => {
    await install({ entries: HYDE_FAILS, env: { RAG_QUERY_HYDE: 'true' }, backend: { fail: true } });
    const { result, stage } = await run(KEYWORDS);
    expect(stage('hyde')?.status).toBe('skipped');
    expect(result.status).toBe('error');
    expect(result.reason).toBe('backend_error');
  });

  it('small talk under the layer runs no search, rank or context stage and is ok with an empty context', async () => {
    const { fake, seen } = await install();
    const { result, stages } = await run(SMALL_TALK, { ragMode: 'strict' });
    const names = stages.map((row) => row.name);
    for (const name of ['embed', 'search', 'fuse', 'dedupe', 'rerank', 'refusal', 'assemble']) expect(names).not.toContain(name);
    expect(seen.searches).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('small_talk');
    expect(result.context).toBe('');
    expect(result.refusalCandidate).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.queryPlan?.gate.skip_retrieval).toBe(true);
  });

  it('with the layer off small talk runs retrieval as in Phase 4', async () => {
    const { seen } = await install({ env: { RAG_QUERY_LAYER: 'false' } });
    const { result, stage } = await run(SMALL_TALK);
    expect(seen.searches).toBeGreaterThan(0);
    expect(stage('search')?.status).toBe('ok');
    expect(stage('query_gate')).toBeUndefined();
    expect(result.reason).not.toBe('small_talk');
    expect(result.queryPlan).toBeUndefined();
  });
});
