import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { QUERY_LAYER_STAGES } from '@/lib/rag/config';
// Loaded up front: the v2 query stage imports it dynamically, which fake timers would stall.
import '@/lib/rag/query/run-layer';
import '@/lib/rag/v2/pipeline';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, RetrievalResult, StageRecord } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const SLOW_MS = 5000;

const HISTORY: HistoryTurn[] = [
  { role: 'user', content: 'Tell me about the sample gateway service.' },
  { role: 'assistant', content: 'The sample gateway service routes synthetic requests between modules.' },
];

type Transform = 'condense' | 'expand' | 'hyde' | 'decompose';

/** One query per transform that the gate routes to it (hyde rides along with expand when RAG_QUERY_HYDE is on). */
const CASES: Record<Transform, { query: string; history?: HistoryTurn[]; timeoutMs: number; plan: string; env?: Record<string, string> }> = {
  condense: { query: 'What changed in it?', history: HISTORY, timeoutMs: 600, plan: 'condense_history' },
  expand: { query: 'gateway logs', timeoutMs: 700, plan: 'expand' },
  hyde: { query: 'gateway logs', timeoutMs: 900, plan: 'hyde', env: { RAG_QUERY_HYDE: 'true' } },
  decompose: { query: 'A 和 B 有什么区别？', timeoutMs: 800, plan: 'decompose' },
};

function backend(): RetrievalBackend {
  return {
    id: 'pgvector',
    async search() {
      return { dense: [hit('chunk-original', { similarity: 0.8, documentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })], lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

/** Installs the fakes, runs the v2 startup check with real timers, then hands the clock to fake timers. */
async function install(entries: FakeQueryLlmEntry[], env: Record<string, string> = {}) {
  resetActiveChunkingProfilesForTests();
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  const { embedder } = fakeEmbedder();
  const rpc = fakeRpcClient();
  installDeps({
    embedder,
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    queryLlm: () => fake,
    ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', ...env }),
  });
  setRetrievalBackendForTests(backend());
  await verifyV2Startup();
  vi.useFakeTimers({ now: Date.parse('2026-06-15T12:00:00Z') });
  return fake;
}

async function run(query: string, options: { history?: HistoryTurn[]; controller?: AbortController; advanceMs?: number } = {}) {
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const controller = options.controller ?? new AbortController();
  const pending = runRetrieval({
    scope,
    query,
    profile: 'chat',
    options: { ragMode: 'balanced', webSearchEnabled: false },
    signal: controller.signal,
    trace: collector,
    ...(options.history ? { history: options.history } : {}),
  });
  await vi.advanceTimersByTimeAsync(options.advanceMs ?? SLOW_MS + 1000);
  const result: RetrievalResult = await pending;
  const stages = collector.stages();
  return { result, stages, stage: (name: string) => stages.find((row) => row.name === name) };
}

function keptOriginal(result: RetrievalResult): boolean {
  return result.candidates.some((candidate) => candidate.chunk_id === 'chunk-original');
}

function layerSpan(stages: StageRecord[]): number {
  const layer = stages.filter((row) => (QUERY_LAYER_STAGES as readonly string[]).includes(row.name) && row.status !== 'disabled');
  const start = Math.min(...layer.map((row) => row.startedAt));
  const end = Math.max(...layer.map((row) => row.endedAt));
  return end - start;
}

describe('query-layer transforms fail soft (D-27, D-28)', () => {
  beforeEach(async () => {
    uninstallDeps();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallDeps();
    resetRetrievalBackendForTests();
    vi.restoreAllMocks();
  });

  for (const transform of Object.keys(CASES) as Transform[]) {
    const c = CASES[transform];

    it(`${transform}: a ${SLOW_MS} ms delay is skipped with reason timeout at ${c.timeoutMs} ms and the original results stay`, async () => {
      await install([{ transform, query: c.query, delay_ms: SLOW_MS, output: outputFor(transform) }], c.env);
      const { result, stage } = await run(c.query, { history: c.history });

      expect(stage(transform)).toMatchObject({ status: 'skipped', reason: 'timeout' });
      expect(stage(transform)!.endedAt - stage(transform)!.startedAt).toBe(c.timeoutMs);
      expect(result.queryPlan?.skipped).toContainEqual({ transform: c.plan, reason: 'timeout' });
      expect(result.status).toBe('degraded');
      expect(keptOriginal(result)).toBe(true);
    });

    for (const fail of ['error', 'invalid'] as const) {
      it(`${transform}: a${fail === 'error' ? ' thrown error' : 'n invalid output'} is skipped with reason error`, async () => {
        await install([{ transform, query: c.query, fail }], c.env);
          const { result, stage } = await run(c.query, { history: c.history });

        expect(stage(transform)).toMatchObject({ status: 'skipped', reason: 'failed' });
        expect(result.queryPlan?.skipped).toContainEqual({ transform: c.plan, reason: 'error' });
        expect(result.status).toBe('degraded');
        expect(keptOriginal(result)).toBe(true);
      });
    }
  }

  it('three slow transforms in the parallel group are cut at the group deadline and the layer stays under 1,250 ms', async () => {
    const query = 'Compare it with the alpha module';
    await install(
      [
        { transform: 'condense', query, delay_ms: 550, output: { standalone: query, unchanged: true } },
        { transform: 'expand', query, delay_ms: SLOW_MS, output: { queries: ['synthetic expansion'] } },
        { transform: 'hyde', query, delay_ms: SLOW_MS, output: { passage: 'A synthetic passage.' } },
        { transform: 'decompose', query, delay_ms: SLOW_MS, output: { questions: ['synthetic part one', 'synthetic part two'] } },
      ],
      { RAG_QUERY_HYDE: 'true' },
    );
    const { result, stages, stage } = await run(query, { history: HISTORY });

    expect(stage('condense')?.status).toBe('ok');
    for (const name of ['expand', 'hyde', 'decompose']) {
      expect(stage(name)).toMatchObject({ status: 'skipped', reason: 'timeout' });
      // Group deadline: min(900, 1200 - 550 elapsed) = 650 ms, shorter than every per-transform timeout.
      expect(stage(name)!.endedAt - stage(name)!.startedAt).toBe(650);
    }
    expect(layerSpan(stages)).toBeLessThan(1250);
    expect(result.status).toBe('degraded');
    expect(keptOriginal(result)).toBe(true);
  });

  it('aborting the request records aborted, not timeout', async () => {
    const c = CASES.expand;
    await install([{ transform: 'expand', query: c.query, delay_ms: SLOW_MS, output: outputFor('expand') }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('client went away', 'AbortError')), 100);
    const { result, stage } = await run(c.query, { controller });

    expect(stage('expand')?.status).toBe('aborted');
    expect(stage('expand')?.reason).toBe('aborted');
    expect(result.status).toBe('error');
    expect(result.reason).toBe('aborted');
  });
});

function outputFor(transform: Transform): unknown {
  switch (transform) {
    case 'condense':
      return { standalone: 'What changed in the gateway?', unchanged: false };
    case 'expand':
      return { queries: ['gateway log files'] };
    case 'hyde':
      return { passage: 'A synthetic passage.' };
    case 'decompose':
      return { questions: ['A 是什么？', 'B 是什么？'] };
  }
}
