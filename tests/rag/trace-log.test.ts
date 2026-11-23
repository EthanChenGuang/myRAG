import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { createTraceCollector, finishTrace, runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import { setRagDepsForTests } from '@/lib/rag/deps';
import {
  fakeEmbedder,
  fakeRpcClient,
  installDeps,
  rows,
  uninstallDeps,
} from './helpers/pipeline-fakes';
import type { RetrievalResult } from '@/lib/rag/types';

const DISTINCT_QUERY = 'zebra-quartz-7731 handbook question';
const DISTINCT_CHUNK = 'chunk body marker kestrel-9042';

let log: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  uninstallDeps();
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  log.mockRestore();
  uninstallDeps();
});

function traceLines(): string[] {
  return log.mock.calls.map((call) => call.map(String).join(' ')).filter((line) => line.includes('[RAG Trace]'));
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>;
}

function emptyResult(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: false,
    stages: [],
    traceId: 'unused',
    queryContext: null,
    ...overrides,
  };
}

describe('createTraceCollector', () => {
  test('traceId is 32 lowercase hex characters from deps.randomId', () => {
    setRagDepsForTests({ randomId: () => '0123456789ABCDEF0123456789abcdef' });
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    expect(collector.traceId).toBe('0123456789abcdef0123456789abcdef');
  });

  test('a default uuid id has its dashes stripped', () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    expect(collector.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('an id that is not 32 hex characters is replaced by a random one', () => {
    setRagDepsForTests({ randomId: () => 'not-a-trace-id' });
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    expect(collector.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('record stores name, status, timings, counts and rules', () => {
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 'o:acme' });
    const record = collector.record({
      name: 'search',
      status: 'ok',
      startedAt: 100,
      endedAt: 142,
      candidatesIn: 0,
      candidatesOut: 7,
    });
    expect(record).toEqual({
      name: 'search',
      status: 'ok',
      startedAt: 100,
      endedAt: 142,
      latency_ms: 42,
      candidates_in: 0,
      candidates_out: 7,
      rules: [],
    });
    expect(collector.stages()).toEqual([record]);
  });

  test('toStageLatency and toStageStatus are keyed by stage name', () => {
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    collector.record({ name: 'analyze', status: 'ok', startedAt: 0, endedAt: 3 });
    collector.record({ name: 'embed', status: 'ok', startedAt: 3, endedAt: 20 });
    collector.record({ name: 'legacy_rank', status: 'disabled', reason: 'disabled', startedAt: 30, endedAt: 30 });
    expect(collector.toStageLatency()).toEqual({ analyze: 3, embed: 17, legacy_rank: 0 });
    expect(collector.toStageStatus()).toEqual({ analyze: 'ok', embed: 'ok', legacy_rank: 'disabled' });
  });

  test('a negative duration is clamped to zero', () => {
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    expect(collector.record({ name: 'embed', status: 'ok', startedAt: 10, endedAt: 4 }).latency_ms).toBe(0);
  });
});

describe('finishTrace', () => {
  test('logs exactly one [RAG Trace] line with the fixed fields', () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 'o:acme' });
    collector.record({ name: 'embed', status: 'ok', startedAt: 0, endedAt: 5 });
    collector.record({ name: 'search', status: 'timeout', reason: 'timeout', startedAt: 5, endedAt: 15, candidatesOut: 0 });
    finishTrace(collector, emptyResult({ status: 'error', reason: 'search_timeout', traceId: collector.traceId }));

    const lines = traceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('[RAG Trace]')).toBe(true);
    const payload = parseLine(lines[0]);
    expect(Object.keys(payload).sort()).toEqual(['profile', 'reason', 'stages', 'status', 'tenantKey', 'traceId']);
    expect(payload).toMatchObject({
      traceId: collector.traceId,
      tenantKey: 'o:acme',
      profile: 'chat',
      status: 'error',
      reason: 'search_timeout',
    });
    expect(payload.stages).toEqual([
      { name: 'embed', status: 'ok', latency_ms: 5, candidates_in: null, candidates_out: null, rules: [] },
      { name: 'search', status: 'timeout', reason: 'timeout', latency_ms: 10, candidates_in: null, candidates_out: 0, rules: [] },
    ]);
  });

  test('never throws on an empty collector or a failing sink', () => {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    expect(() => finishTrace(collector, emptyResult())).not.toThrow();
    expect(() =>
      finishTrace(collector, emptyResult(), {
        sink: () => {
          throw new Error('sink down');
        },
      }),
    ).not.toThrow();
    expect(() => finishTrace(undefined as never, undefined as never)).not.toThrow();
  });
});

describe('runRetrieval trace wiring', () => {
  function setup() {
    const rpc = fakeRpcClient({
      rows: rows(2).map((row) => ({ ...row, content: `${DISTINCT_CHUNK} ${row.content}` })),
    });
    installDeps({ anonClient: () => rpc.client, embedder: fakeEmbedder().embedder, ragEnv: () => ({}) });
  }

  test('a run that owns its collector logs one content-free line and carries the traceId', async () => {
    setup();
    const result = await runRetrieval({
      scope: mintScope('single', null, null),
      query: DISTINCT_QUERY,
      profile: 'chat',
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(result.candidates[0].content).toContain(DISTINCT_CHUNK);

    const lines = traceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('zebra-quartz-7731');
    expect(lines[0]).not.toContain('kestrel-9042');
    expect(lines[0]).not.toContain('handbook');
    const payload = parseLine(lines[0]);
    expect(payload.traceId).toBe(result.traceId);
    expect(payload).toMatchObject({ tenantKey: 's:default', profile: 'chat', status: 'ok' });
    expect((payload.stages as Array<{ name: string }>).map((stage) => stage.name)).toEqual([
      'analyze',
      'embed',
      'search',
      'legacy_rank',
    ]);
  });

  test('a caller-supplied collector is used and left for the caller to finish', async () => {
    setup();
    const trace = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const result = await runRetrieval({
      scope: mintScope('single', null, null),
      query: DISTINCT_QUERY,
      profile: 'eval',
      signal: new AbortController().signal,
      trace,
    });
    expect(result.traceId).toBe(trace.traceId);
    expect(trace.stages().map((stage) => stage.name)).toEqual(['analyze', 'embed', 'search', 'legacy_rank']);
    expect(traceLines()).toHaveLength(0);
    finishTrace(trace, result);
    expect(traceLines()).toHaveLength(1);
  });

  test('a failed run still logs one line with the error status and reason', async () => {
    const rpc = fakeRpcClient({ rows: [] });
    installDeps({ anonClient: () => rpc.client, embedder: fakeEmbedder({ fail: new Error(DISTINCT_QUERY) }).embedder, ragEnv: () => ({}) });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runRetrieval({
      scope: mintScope('single', null, null),
      query: DISTINCT_QUERY,
      profile: 'chat',
      signal: new AbortController().signal,
    });
    errorSpy.mockRestore();
    expect(result).toMatchObject({ status: 'error', reason: 'embed_failed' });
    const lines = traceLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('zebra-quartz-7731');
    expect(parseLine(lines[0])).toMatchObject({ status: 'error', reason: 'embed_failed' });
  });
});
