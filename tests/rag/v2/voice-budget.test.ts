import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { runRetrieval } from '@/lib/rag';
import { resolveReranker, resetRerankerFactoryForTests, setRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import {
  adminWithRpc,
  fakeAssemblyAdmin,
  fakeEmbedder,
  fakeReranker,
  fakeRpcClient,
  installDeps,
  uninstallDeps,
} from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const COHERE_KEY = 'cohere-test-placeholder-key';

const BASE_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'cohere',
  RAG_REFUSAL_THRESHOLD: 'false',
  COHERE_API_KEY: COHERE_KEY,
};

function delayedBackend(delayMs: number): RetrievalBackend {
  return {
    id: 'pgvector',
    search: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        dense: [hit('chunk-1', { similarity: 0.85, content: 'refund policy and warranty terms' })],
        lexical: [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function setup(options: { searchDelayMs: number; rerankDelayMs: number; envOver?: Record<string, string> }) {
  uninstallDeps();
  resetRerankerFactoryForTests();
  const env = { ...BASE_ENV, ...options.envOver };
  let rerankCalls = 0;
  const { embedder } = fakeEmbedder({ delayMs: 50 });
  const rpc = fakeRpcClient();
  installDeps({ embedder, ragEnv: () => env, adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()) });
  setRetrievalBackendForTests(delayedBackend(options.searchDelayMs));
  const model = options.rerankDelayMs >= 300 ? 'fake-quality-v1' : 'fake-fast-v1';
  const base = fakeReranker({ model, delayMs: options.rerankDelayMs });
  setRerankerFactoryForTests(() => ({
    ...base.reranker,
    rerank(...args: Parameters<typeof base.reranker.rerank>) {
      rerankCalls += 1;
      return base.reranker.rerank(...args);
    },
  }));
  return { env, rerankCalls: () => rerankCalls };
}

async function runVoice() {
  const started = Date.now();
  const result = await runRetrieval({
    scope,
    query: 'refund policy',
    profile: 'voice',
    options: { maxResults: 5 },
    signal: new AbortController().signal,
  });
  return { result, elapsed: Date.now() - started };
}

describe('v2 voice latency budget (D-25)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetV2StartupForTests();
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRerankerFactoryForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('stays under 800 ms for 20 runs with fast rerank at 150 ms and search at 200 ms', async () => {
    const { env } = setup({ searchDelayMs: 200, rerankDelayMs: 150 });
    await verifyV2Startup();
    const durations: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const { result, elapsed } = await runVoice();
      durations.push(elapsed);
      expect(elapsed, `run ${index + 1}`).toBeLessThan(800);
      expect(result.voice?.results.length).toBeGreaterThan(0);
      expect(result.stages.find((stage) => stage.name === 'rerank')?.status).toBe('ok');
    }
    const sorted = [...durations].sort((a, b) => a - b);
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
    expect(p95).toBeLessThan(800);
    const config = loadRagConfig(env);
    const resolved = resolveReranker(config, 'voice', 'en', undefined, env, globalThis.fetch);
    expect(resolved.tier).toBe('fast');
    expect(resolved.model).toBe('rerank-v5.0-fast');
  });

  it('skips rerank when the reranker exceeds the capped timeout but finishes under 800 ms', async () => {
    setup({ searchDelayMs: 200, rerankDelayMs: 400 });
    await verifyV2Startup();
    const { result, elapsed } = await runVoice();
    expect(elapsed).toBeLessThan(800);
    const rerank = result.stages.find((stage) => stage.name === 'rerank');
    expect(rerank?.status).toBe('skipped');
    expect(rerank?.reason).toBe('timeout');
    expect(result.status).toBe('degraded');
    expect(result.voice?.results.length).toBeGreaterThan(0);
  });

  it('skips rerank with budget_exhausted when search consumes the deadline and never calls the vendor', async () => {
    const { rerankCalls } = setup({ searchDelayMs: 700, rerankDelayMs: 150 });
    await verifyV2Startup();
    const { result, elapsed } = await runVoice();
    expect(elapsed).toBeLessThan(800);
    const rerank = result.stages.find((stage) => stage.name === 'rerank');
    expect(rerank?.status).toBe('skipped');
    expect(rerank?.detail).toBe('budget_exhausted');
    expect(rerankCalls()).toBe(0);
  });

  it('waits longer on chat than voice when the reranker is slow', async () => {
    const { env } = setup({ searchDelayMs: 50, rerankDelayMs: 400 });
    await verifyV2Startup();

    const voice = await runVoice();
    expect(voice.elapsed).toBeLessThan(800);
    expect(voice.result.stages.find((stage) => stage.name === 'rerank')?.status).toBe('skipped');

    const chatStarted = Date.now();
    const chat = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
    });
    const chatElapsed = Date.now() - chatStarted;
    expect(chat.stages.find((stage) => stage.name === 'rerank')?.status).toBe('ok');
    expect(chatElapsed).toBeGreaterThanOrEqual(350);
    expect(resolveReranker(loadRagConfig(env), 'chat', 'en', undefined, env, globalThis.fetch).tier).toBe('quality');
  });
});