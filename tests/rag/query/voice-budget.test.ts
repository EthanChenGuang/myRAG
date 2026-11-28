import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlm } from '../../../eval/harness/fake-query-llm.mts';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { resetRagConfigForTests } from '@/lib/rag/config';
// Loaded up front: the v2 query stage imports it dynamically, which fake timers would stall.
import '@/lib/rag/query/run-layer';
import '@/lib/rag/v2/pipeline';
import { resetRerankerFactoryForTests, setRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, RetrievalResult, StageRecord } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeReranker, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const RUNS = 50;
const BUDGET_MS = 800;
const VOICE_CONDENSE_TIMEOUT_MS = 300;
const FOLLOW_UP = 'What changed in it?';
const STANDALONE = 'What changed in the sample gateway service?';
const HISTORY: HistoryTurn[] = [
  { role: 'user', content: 'Tell me about the sample gateway service.' },
  { role: 'assistant', content: 'The sample gateway service routes synthetic requests between modules.' },
];

const BASE_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'cohere',
  RAG_REFUSAL_THRESHOLD: 'false',
  COHERE_API_KEY: 'cohere-test-placeholder-key',
  RAG_QUERY_LAYER: 'true',
  RAG_QUERY_CONDENSE: 'true',
  RAG_QUERY_EXPAND: 'true',
  RAG_QUERY_DECOMPOSE: 'true',
  RAG_QUERY_HYDE: 'true',
  RAG_QUERY_DATE_NORMALIZE: 'true',
};

function delayedBackend(delayMs: number): RetrievalBackend {
  return {
    id: 'pgvector',
    search: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { dense: [hit('chunk-original', { similarity: 0.85, content: 'synthetic gateway release notes' })], lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

interface Harness {
  embedded: string[];
  setLlm(fake: FakeQueryLlm): void;
  llm(): FakeQueryLlm;
}

/** Installs the fakes (embed 50 ms, search 100 ms, fast rerank 150 ms), runs the v2 startup check, then hands the clock to fake timers. */
async function install(envOver: Record<string, string> = {}): Promise<Harness> {
  resetActiveChunkingProfilesForTests();
  resetRerankerFactoryForTests();
  const env = { ...BASE_ENV, ...envOver };
  const embedded: string[] = [];
  const { embedder } = fakeEmbedder({ delayMs: 50 });
  let current = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  installDeps({
    embedder: (text, opts) => {
      embedded.push(text);
      return embedder(text, opts);
    },
    adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
    queryLlm: () => current,
    ragEnv: () => env,
  });
  setRetrievalBackendForTests(delayedBackend(100));
  const { reranker } = fakeReranker({ model: 'fake-fast-v1', delayMs: 150 });
  setRerankerFactoryForTests(() => reranker);
  await verifyV2Startup();
  vi.useFakeTimers({ now: Date.parse('2026-06-17T12:00:00Z') });
  return {
    embedded,
    setLlm: (fake) => {
      current = fake;
    },
    llm: () => current,
  };
}

async function runVoice(query: string, history?: HistoryTurn[]) {
  const collector = createTraceCollector({ profile: 'voice', tenantKey: 's:default' });
  const pending = runRetrieval({
    scope,
    query,
    profile: 'voice',
    options: { maxResults: 5 },
    signal: new AbortController().signal,
    trace: collector,
    ...(history ? { history } : {}),
  });
  await vi.advanceTimersByTimeAsync(5000);
  const result: RetrievalResult = await pending;
  const stages = collector.stages();
  const total = stages.reduce((latest, stage) => Math.max(latest, stage.endedAt), collector.startedAt) - collector.startedAt;
  return { result, stages, total, stage: (name: string) => stages.find((row: StageRecord) => row.name === name) };
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]!;
}

describe('voice profile with the query layer stays inside its budget (D-27, D-29, D-30, D-31)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetV2StartupForTests();
    resetRagConfigForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRerankerFactoryForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it(`${RUNS} runs with condense delays from 100 to 500 ms keep p95 under ${BUDGET_MS} ms; condense over ${VOICE_CONDENSE_TIMEOUT_MS} ms is skipped`, async () => {
    const harness = await install();
    const totals: number[] = [];
    let skippedRuns = 0;
    for (let index = 0; index < RUNS; index += 1) {
      const delay = 100 + Math.round((index * 400) / (RUNS - 1));
      harness.setLlm(
        createFakeQueryLlm({
          table: { version: 1, entries: [{ transform: 'condense', query: FOLLOW_UP, delay_ms: delay, output: { standalone: STANDALONE, unchanged: false } }] },
        }),
      );
      harness.embedded.length = 0;
      const { result, total, stage } = await runVoice(FOLLOW_UP, HISTORY);
      totals.push(total);
      expect(result.voice?.results.length, `run ${index + 1}`).toBeGreaterThan(0);
      expect(stage('rerank')?.status, `run ${index + 1}`).toBe('ok');
      const condense = stage('condense');
      if (delay > VOICE_CONDENSE_TIMEOUT_MS) {
        skippedRuns += 1;
        expect(condense, `run ${index + 1}`).toMatchObject({ status: 'skipped', reason: 'timeout' });
        expect(condense!.endedAt - condense!.startedAt).toBe(VOICE_CONDENSE_TIMEOUT_MS);
        expect(result.queryPlan?.skipped).toContainEqual({ transform: 'condense_history', reason: 'timeout' });
        expect(result.queryPlan?.standalone).toBe(FOLLOW_UP);
        expect(harness.embedded).toEqual([FOLLOW_UP]);
      } else {
        expect(condense?.status, `run ${index + 1}`).toBe('ok');
        expect(result.queryPlan?.standalone).toBe(STANDALONE);
        expect(harness.embedded).toContain(FOLLOW_UP);
        expect(harness.embedded).toContain(STANDALONE);
      }
    }
    expect(skippedRuns).toBeGreaterThan(0);
    expect(skippedRuns).toBeLessThan(RUNS);
    expect(Math.max(...totals)).toBeLessThan(BUDGET_MS);
    expect(p95(totals)).toBeLessThan(BUDGET_MS);
  });

  it('never runs hyde, expand or decompose for voice even when RAG_QUERY_VOICE_TRANSFORMS lists them', async () => {
    const harness = await install({ RAG_QUERY_VOICE_TRANSFORMS: 'condense_history,hyde,expand,decompose' });
    let blockedSeen = 0;
    for (const query of [FOLLOW_UP, 'gateway logs', 'Compare the alpha module and the beta module']) {
      const { stages } = await runVoice(query, query === FOLLOW_UP ? HISTORY : undefined);
      const banned = stages.filter((row) => ['hyde', 'expand', 'decompose'].includes(row.name));
      // Router decisions are configuration: a blocked transform may appear only as a disabled record, never as a run.
      for (const row of banned) expect(row, query).toMatchObject({ status: 'disabled', reason: 'disabled' });
      expect(banned.filter((row) => row.detail !== 'voice_blocked'), query).toEqual([]);
      blockedSeen += banned.length;
    }
    expect(harness.llm().calls.filter((call) => call.transform !== 'condense')).toEqual([]);
    expect(blockedSeen).toBeGreaterThan(0);
  });

  it('runs normalize_dates for a relative-date question in voice', async () => {
    await install();
    const { result, stage } = await runVoice('what did we sell last week');
    expect(stage('normalize_dates')?.status).toBe('ok');
    expect(result.queryPlan?.date_range).not.toBeNull();
    expect(result.queryPlan?.date_range?.from_date).toBeTruthy();
  });
});
