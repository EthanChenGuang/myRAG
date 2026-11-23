import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mintScope } from '@/lib/rag/tenant/scope';
import { runRetrieval } from '@/lib/rag';
import { StageError, runStage, type StageSpec } from '@/lib/rag/pipeline';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { legacyAnalyze, legacyRank } from '@/lib/rag/legacy/enhanced-retrieval';
import {
  SEMANTIC_QUERY,
  fakeEmbedder,
  fakeRpcClient,
  installDeps,
  rows,
  uninstallDeps,
  type FakeRpcOptions,
} from './helpers/pipeline-fakes';
import type { RagEnvInput } from '@/lib/rag/config';
import type { Profile } from '@/lib/rag/types';

vi.mock('@/lib/rag/legacy/enhanced-retrieval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/legacy/enhanced-retrieval')>();
  return { ...actual, legacyRank: vi.fn(actual.legacyRank), legacyAnalyze: vi.fn(actual.legacyAnalyze) };
});

const scope = mintScope('single', null, null);

function spec(overrides: Partial<StageSpec> = {}): StageSpec {
  return { name: 'search', enabled: true, timeoutMs: 1000, onFail: 'throw', ...overrides };
}

function collector() {
  return createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
}

beforeEach(() => {
  uninstallDeps();
});

afterEach(() => {
  uninstallDeps();
  vi.mocked(legacyRank).mockClear();
  vi.mocked(legacyAnalyze).mockClear();
});

describe('runStage', () => {
  test('a successful stage returns its value and records ok with candidate counts', async () => {
    const trace = collector();
    const outcome = await runStage(spec(), new AbortController().signal, async () => [1, 2, 3], trace, {
      candidatesIn: 0,
      candidatesOut: (value) => value.length,
    });
    expect(outcome).toEqual({ skipped: false, value: [1, 2, 3] });
    const [record] = trace.stages();
    expect(record).toMatchObject({ name: 'search', status: 'ok', candidates_in: 0, candidates_out: 3, rules: [] });
  });

  test('a disabled stage is recorded as disabled without running', async () => {
    const trace = collector();
    const fn = vi.fn(async () => 1);
    const outcome = await runStage(spec({ name: 'legacy_rank', enabled: false, onFail: 'skip' }), new AbortController().signal, fn, trace);
    expect(outcome).toEqual({ skipped: true, reason: 'disabled' });
    expect(fn).not.toHaveBeenCalled();
    expect(trace.stages()[0]).toMatchObject({ name: 'legacy_rank', status: 'disabled', reason: 'disabled' });
  });

  test('an optional stage that throws is skipped with reason failed', async () => {
    const trace = collector();
    const outcome = await runStage(spec({ name: 'analyze', onFail: 'skip' }), new AbortController().signal, async () => {
      throw new Error('boom');
    }, trace);
    expect(outcome).toEqual({ skipped: true, reason: 'failed' });
    expect(trace.stages()[0]).toMatchObject({ name: 'analyze', status: 'skipped', reason: 'failed' });
  });

  test('an optional stage slower than its timeout is skipped even when it ignores the signal', async () => {
    const trace = collector();
    const outcome = await runStage(
      spec({ name: 'legacy_rank', onFail: 'skip', timeoutMs: 20 }),
      new AbortController().signal,
      () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 300)),
      trace,
    );
    expect(outcome).toEqual({ skipped: true, reason: 'timeout' });
    expect(trace.stages()[0]).toMatchObject({ status: 'skipped', reason: 'timeout' });
  });

  test('a core stage that throws raises StageError with reason failed', async () => {
    const trace = collector();
    const error = await runStage(spec({ name: 'embed' }), new AbortController().signal, async () => {
      throw new Error('boom');
    }, trace).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StageError);
    expect(error).toMatchObject({ stage: 'embed', reason: 'failed' });
    expect(trace.stages()[0]).toMatchObject({ name: 'embed', status: 'error', reason: 'failed' });
  });

  test('a core stage slower than its timeout raises StageError with reason timeout', async () => {
    const trace = collector();
    const error = await runStage(
      spec({ name: 'embed', timeoutMs: 20 }),
      new AbortController().signal,
      () => new Promise<number>((resolve) => setTimeout(() => resolve(1), 300)),
      trace,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ stage: 'embed', reason: 'timeout' });
    expect(trace.stages()[0]).toMatchObject({ status: 'timeout', reason: 'timeout' });
  });

  test('aborting the parent mid-stage raises aborted and the stage signal is aborted', async () => {
    const trace = collector();
    const controller = new AbortController();
    let stageSignal: AbortSignal | undefined;
    const pending = runStage(
      spec({ name: 'search', onFail: 'skip' }),
      controller.signal,
      (signal) => {
        stageSignal = signal;
        return new Promise<number>(() => undefined);
      },
      trace,
    ).catch((caught: unknown) => caught);
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ stage: 'search', reason: 'aborted' });
    expect(stageSignal?.aborted).toBe(true);
    expect(trace.stages()[0]).toMatchObject({ status: 'aborted', reason: 'aborted' });
  });

  test('an already aborted parent raises before the stage runs and records nothing', async () => {
    const trace = collector();
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 1);
    const error = await runStage(spec({ onFail: 'skip' }), controller.signal, fn, trace).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'aborted' });
    expect(fn).not.toHaveBeenCalled();
    expect(trace.stages()).toEqual([]);
  });

  test('a stage that resolves after the signal aborted is treated as aborted', async () => {
    const trace = collector();
    const controller = new AbortController();
    const error = await runStage(spec(), controller.signal, async () => {
      controller.abort();
      return 'late';
    }, trace).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'aborted' });
  });
});

function install(options: {
  rpc?: FakeRpcOptions;
  embedder?: Parameters<typeof fakeEmbedder>[0];
  env?: RagEnvInput;
}) {
  const rpc = fakeRpcClient(options.rpc ?? { rows: rows(3) });
  const embed = fakeEmbedder(options.embedder);
  installDeps({
    anonClient: () => rpc.client,
    embedder: embed.embedder,
    ragEnv: () => options.env ?? {},
  });
  return { rpc, embed };
}

function run(profile: Profile = 'eval', extra: Partial<Parameters<typeof runRetrieval>[0]> = {}, signal = new AbortController().signal) {
  return runRetrieval({ scope, query: SEMANTIC_QUERY, profile, signal, ...extra });
}

describe('runRetrieval failure semantics', () => {
  test('a clean run is ok with every stage recorded in order', async () => {
    install({});
    const result = await run();
    expect(result.status).toBe('ok');
    expect(result.candidates).toHaveLength(3);
    expect(result.stages.map((s) => [s.name, s.status])).toEqual([
      ['analyze', 'ok'],
      ['embed', 'ok'],
      ['search', 'ok'],
      ['legacy_rank', 'ok'],
      ['post_filter', 'ok'],
      ['assemble', 'ok'],
    ]);
    const search = result.stages.find((s) => s.name === 'search');
    expect(search).toMatchObject({ candidates_out: 3 });
    expect(result.stages.find((s) => s.name === 'legacy_rank')).toMatchObject({ candidates_in: 3, candidates_out: 3 });
  });

  test('an embedder that throws is error/embed_failed', async () => {
    install({ embedder: { fail: new Error('provider down') } });
    const result = await run();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('embed_failed');
    expect(result.candidates).toEqual([]);
    expect(result.stages.map((s) => s.name)).toEqual(['analyze', 'embed']);
  });

  test('an RPC error is error, never empty', async () => {
    install({ rpc: { error: { message: 'boom', code: 'XX000' } } });
    const result = await run();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('backend_error');
    expect(result.stages.find((s) => s.name === 'search')).toMatchObject({ status: 'error' });
    expect(result.stages.some((s) => s.name === 'legacy_rank')).toBe(false);
  });

  test('a search that throws for another reason is error/search_failed', async () => {
    install({ rpc: { throwOnCall: new Error('client exploded') } });
    const result = await run();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('search_failed');
  });

  test('an embedder slower than its timeout is error/embed_timeout', async () => {
    install({ embedder: { delayMs: 300 }, env: { RAG_STAGE_TIMEOUTS: 'embed=25' } });
    const result = await run();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('embed_timeout');
    expect(result.stages.find((s) => s.name === 'embed')).toMatchObject({ status: 'timeout' });
  });

  test('a search slower than its timeout is error/search_timeout', async () => {
    install({ rpc: { rows: rows(2), delayMs: 300 }, env: { RAG_STAGE_TIMEOUTS: 'search=25' } });
    const result = await run();
    expect(result.status).toBe('error');
    expect(result.reason).toBe('search_timeout');
  });

  test('a slow optional stage is skipped and the result is degraded with its candidates', async () => {
    install({ env: { RAG_STAGE_TIMEOUTS: 'legacy_rank=20' } });
    vi.mocked(legacyRank).mockImplementationOnce((() => new Promise((resolve) => setTimeout(() => resolve([]), 300))) as never);
    const result = await run();
    expect(result.status).toBe('degraded');
    expect(result.reason).toBe('legacy_rank_timeout');
    expect(result.candidates).toHaveLength(3);
    expect(result.stages.find((s) => s.name === 'legacy_rank')).toMatchObject({ status: 'skipped', reason: 'timeout' });
  });

  test('a failing optional stage keeps search order and is degraded', async () => {
    install({});
    vi.mocked(legacyRank).mockImplementationOnce((() => {
      throw new Error('rank failed');
    }) as never);
    const result = await run();
    expect(result.status).toBe('degraded');
    expect(result.reason).toBe('legacy_rank_failed');
    expect(result.candidates.map((c) => c.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });

  test('a skipped analyze falls back to the legacy default query context and is degraded', async () => {
    install({});
    vi.mocked(legacyAnalyze).mockImplementationOnce((() => {
      throw new Error('analyze failed');
    }) as never);
    const result = await run();
    expect(result.status).toBe('degraded');
    expect(result.queryContext).toMatchObject({ searchStrategy: 'semantic_only', requiredPrecision: 'low' });
    expect(result.candidates).toHaveLength(3);
  });

  test('a zero-candidate run with a skipped optional stage is degraded, not empty', async () => {
    install({ rpc: { rows: [] } });
    vi.mocked(legacyAnalyze).mockImplementationOnce((() => {
      throw new Error('analyze failed');
    }) as never);
    const result = await run();
    expect(result.status).toBe('degraded');
    expect(result.candidates).toEqual([]);
  });

  test('legacy_rank disabled by config is recorded as disabled and a zero-candidate result is still empty', async () => {
    install({ rpc: { rows: [] }, env: { RAG_DISABLED_STAGES: 'legacy_rank' } });
    const result = await run();
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('no_candidates');
    expect(result.stages.find((s) => s.name === 'legacy_rank')).toMatchObject({ status: 'disabled' });
    expect(vi.mocked(legacyRank)).not.toHaveBeenCalled();
  });

  test('legacy_rank disabled by config with candidates is ok and keeps search order', async () => {
    install({ env: { RAG_DISABLED_STAGES: 'legacy_rank' } });
    const result = await run();
    expect(result.status).toBe('ok');
    expect(result.candidates.map((c) => c.chunk_id)).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);
  });

  test('a core stage named in RAG_DISABLED_STAGES still runs', async () => {
    const { embed } = install({ env: { RAG_DISABLED_STAGES: 'embed,search' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await run();
    warn.mockRestore();
    expect(result.status).toBe('ok');
    expect(embed.signals).toHaveLength(1);
  });

  test('zero rows on a clean run is empty', async () => {
    install({ rpc: { rows: [] } });
    const result = await run();
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('no_candidates');
  });
});

describe('runRetrieval abort propagation', () => {
  test('aborting mid-search aborts the embedder and RPC signals and runs no later stage', async () => {
    const { rpc, embed } = install({ rpc: { rows: rows(2), delayMs: 500 } });
    const controller = new AbortController();
    const pending = run('eval', {}, controller.signal);
    await vi.waitFor(() => expect(rpc.calls.length).toBeGreaterThan(0));
    controller.abort();
    const result = await pending;
    expect(result.status).toBe('error');
    expect(result.reason).toBe('aborted');
    expect(rpc.calls[0].signal?.aborted).toBe(true);
    expect(embed.signals).toHaveLength(1);
    expect(embed.signals[0].aborted).toBe(true);
    expect(result.stages.some((s) => s.name === 'legacy_rank')).toBe(false);
    expect(vi.mocked(legacyRank)).not.toHaveBeenCalled();
  });

  test('aborting mid-embed is error/aborted and the search never starts', async () => {
    const { rpc, embed } = install({ embedder: { delayMs: 500 } });
    const controller = new AbortController();
    const pending = run('eval', {}, controller.signal);
    await vi.waitFor(() => expect(embed.signals).toHaveLength(1));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: 'error', reason: 'aborted' });
    expect(rpc.calls).toEqual([]);
  });

  test('a signal aborted before the call runs no stage', async () => {
    const { rpc, embed } = install({});
    const controller = new AbortController();
    controller.abort();
    const result = await run('eval', {}, controller.signal);
    expect(result).toMatchObject({ status: 'error', reason: 'aborted' });
    expect(embed.signals).toEqual([]);
    expect(rpc.calls).toEqual([]);
  });
});

describe('per-request stage overrides', () => {
  test('are honoured for profile eval', async () => {
    install({});
    const result = await run('eval', { stageOverrides: { disabledStages: ['legacy_rank'] } });
    expect(result.stages.find((s) => s.name === 'legacy_rank')).toMatchObject({ status: 'disabled' });
  });

  test('are ignored for every other profile', async () => {
    for (const profile of ['chat', 'embed', 'media'] as const) {
      install({});
      const result = await run(profile, { stageOverrides: { disabledStages: ['legacy_rank'], timeouts: { embed: 1 } } });
      expect(result.status).toBe('ok');
      expect(result.stages.find((s) => s.name === 'legacy_rank')).toMatchObject({ status: 'ok' });
    }
  });

  test('timeout overrides apply to eval only', async () => {
    install({ embedder: { delayMs: 150 } });
    const evalResult = await run('eval', { stageOverrides: { timeouts: { embed: 20 } } });
    expect(evalResult).toMatchObject({ status: 'error', reason: 'embed_timeout' });
    uninstallDeps();
    install({ embedder: { delayMs: 150 } });
    const chatResult = await run('chat', { stageOverrides: { timeouts: { embed: 20 } } });
    expect(chatResult.status).toBe('ok');
  });

  test('a core stage in the disabled override is ignored', async () => {
    install({});
    const result = await run('eval', { stageOverrides: { disabledStages: ['embed', 'search'] } });
    expect(result.status).toBe('ok');
  });
});
