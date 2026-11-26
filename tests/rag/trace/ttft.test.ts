import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rag from '@/lib/rag';
import {
  awaitPreGenerationDelay,
  createTraceCollector,
  resetPreGenerationDelayForTests,
  setPreGenerationDelayForTests,
  withFirstTextDelta,
} from '@/lib/rag';
import { buildTraceLogPayload } from '@/lib/rag/trace/log';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import type { TraceCacheState } from '@/lib/rag/trace/collector';
import type { RetrievalResult } from '@/lib/rag/types';

const DISTINCT_QUERY = 'zebra-quartz-7731 synthetic question';
const DISTINCT_CHUNK = 'chunk body marker kestrel-9042';

let clock = 0;

beforeEach(() => {
  clock = 1000;
  setRagDepsForTests({ now: () => clock });
});

afterEach(() => {
  resetRagDepsForTests();
});

function collector() {
  return createTraceCollector({ profile: 'chat', tenantKey: 'u:00000000-0000-4000-8000-000000000001' });
}

function result(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: [],
    context: DISTINCT_CHUNK,
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [{ chunk_id: 'c1', document_id: 'd1', document_name: 'notes.md', content: DISTINCT_CHUNK, similarity: 0.9, rank: 1, kept_by: 'similarity' }],
    queryTerms: [DISTINCT_QUERY],
    refusalCandidate: false,
    stages: [],
    traceId: 'unused',
    queryContext: null,
    ...overrides,
  };
}

describe('collector timing', () => {
  test('derives pre_generation_ms and ttft_ms from the injected clock', () => {
    const trace = collector();
    trace.markRequestStart(1000);
    clock = 1180;
    trace.markGenerationStart();
    clock = 1420;
    trace.markFirstTextDelta();
    expect(trace.timing()).toEqual({ pre_generation_ms: 180, ttft_ms: 420, cache: 'bypass' });
  });

  test('request start defaults to the clock when no receipt time is passed', () => {
    clock = 900;
    const trace = collector();
    trace.markRequestStart();
    clock = 1000;
    trace.markFirstTextDelta();
    expect(trace.timing()?.ttft_ms).toBe(100);
  });

  test('a second first-delta mark and a second generation mark are ignored', () => {
    const trace = collector();
    trace.markRequestStart(1000);
    clock = 1100;
    trace.markGenerationStart();
    clock = 1200;
    trace.markFirstTextDelta();
    clock = 1900;
    trace.markGenerationStart();
    trace.markFirstTextDelta();
    expect(trace.timing()).toEqual({ pre_generation_ms: 100, ttft_ms: 200, cache: 'bypass' });
  });

  test('marks without a request start record nothing', () => {
    const trace = collector();
    clock = 1200;
    trace.markGenerationStart();
    trace.markFirstTextDelta();
    trace.setCacheState('hit');
    expect(trace.timing()).toBeNull();
  });

  test('a mark before the request start is not undone by a later start', () => {
    const trace = collector();
    clock = 1200;
    trace.markFirstTextDelta();
    trace.markRequestStart(1000);
    clock = 1500;
    trace.markFirstTextDelta();
    expect(trace.timing()?.ttft_ms).toBe(500);
  });

  test('cache state defaults to bypass and reports hit or miss', () => {
    const states: TraceCacheState[] = ['hit', 'miss', 'bypass'];
    for (const state of states) {
      const trace = collector();
      trace.markRequestStart(1000);
      expect(trace.timing()).toEqual({ cache: 'bypass' });
      trace.setCacheState(state);
      expect(trace.timing()).toEqual({ cache: state });
    }
  });

  test('an unknown cache state is rejected at runtime as well as by the type', () => {
    const trace = collector();
    trace.markRequestStart(1000);
    trace.setCacheState('miss');
    // @ts-expect-error only hit, miss and bypass are cache states
    trace.setCacheState('warm');
    expect(trace.timing()).toEqual({ cache: 'miss' });
  });

  test('a turn without a text delta reports pre_generation_ms and no ttft_ms', () => {
    const trace = collector();
    trace.markRequestStart(1000);
    clock = 1250;
    trace.markGenerationStart();
    const timing = trace.timing();
    expect(timing).toEqual({ pre_generation_ms: 250, cache: 'bypass' });
    expect(timing && 'ttft_ms' in timing).toBe(false);
  });

  test('a clock that runs backwards never reports a negative interval', () => {
    const trace = collector();
    trace.markRequestStart(1000);
    clock = 990;
    trace.markGenerationStart();
    trace.markFirstTextDelta();
    expect(trace.timing()).toEqual({ pre_generation_ms: 0, ttft_ms: 0, cache: 'bypass' });
  });

  test('a non-finite receipt time records nothing', () => {
    const trace = collector();
    trace.markRequestStart(Number.NaN);
    clock = 1100;
    trace.markFirstTextDelta();
    expect(trace.timing()).toBeNull();
  });
});

describe('[RAG Trace] log payload timing', () => {
  test('carries ttft_ms, pre_generation_ms and cache as fixed keys when timing was recorded', () => {
    const trace = collector();
    trace.markRequestStart(1000);
    clock = 1180;
    trace.markGenerationStart();
    clock = 1420;
    trace.markFirstTextDelta();
    trace.setCacheState('miss');
    const payload = buildTraceLogPayload(trace, result()) as Record<string, unknown>;
    expect(payload.ttft_ms).toBe(420);
    expect(payload.pre_generation_ms).toBe(180);
    expect(payload.cache).toBe('miss');
    const text = JSON.stringify(payload);
    expect(text).not.toContain(DISTINCT_QUERY);
    expect(text).not.toContain(DISTINCT_CHUNK);
  });

  test('keeps the three keys with null numbers when only part of the timing exists', () => {
    const trace = collector();
    trace.markRequestStart(1000);
    const payload = buildTraceLogPayload(trace, result()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ttft_ms: null, pre_generation_ms: null, cache: 'bypass' });
  });

  test('a trace without timing logs exactly the keys it logs today', () => {
    const trace = collector();
    const payload = buildTraceLogPayload(trace, result()) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['traceId', 'tenantKey', 'profile', 'status', 'reason', 'stages']);
  });
});

type Chunk = { type: string; id?: string; delta?: string };

function streamOf(chunks: Chunk[]): ReadableStream<Chunk> {
  return new ReadableStream<Chunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe('withFirstTextDelta', () => {
  test('passes every chunk through in order and calls back once, on the first text-delta', async () => {
    const chunks: Chunk[] = [
      { type: 'start' },
      { type: 'text-delta', id: 't1', delta: 'alpha' },
      { type: 'text-delta', id: 't1', delta: 'beta' },
      { type: 'finish' },
    ];
    const seenAt: number[] = [];
    let passed = 0;
    const source = streamOf(chunks).pipeThrough(
      new TransformStream<Chunk, Chunk>({
        transform(chunk, controller) {
          passed += 1;
          controller.enqueue(chunk);
        },
      }),
    );
    const out = await drain(withFirstTextDelta(source, () => seenAt.push(passed)));
    expect(out).toEqual(chunks);
    expect(out[1]).toBe(chunks[1]);
    expect(seenAt).toHaveLength(1);
    expect(seenAt[0]).toBeGreaterThanOrEqual(2);
  });

  test('never calls back when no text-delta passes', async () => {
    let calls = 0;
    const chunks: Chunk[] = [{ type: 'start' }, { type: 'error' }, { type: 'finish' }];
    const out = await drain(withFirstTextDelta(streamOf(chunks), () => (calls += 1)));
    expect(out).toEqual(chunks);
    expect(calls).toBe(0);
  });

  test('a throwing callback does not break the stream', async () => {
    let calls = 0;
    const chunks: Chunk[] = [{ type: 'text-delta', id: 't', delta: 'x' }, { type: 'text-delta', id: 't', delta: 'y' }, { type: 'finish' }];
    const out = await drain(
      withFirstTextDelta(streamOf(chunks), () => {
        calls += 1;
        throw new Error('callback failure');
      }),
    );
    expect(out).toEqual(chunks);
    expect(calls).toBe(1);
  });

  test('marks the collector first delta when wired to it', async () => {
    const trace = collector();
    trace.markRequestStart(1000);
    clock = 1300;
    await drain(withFirstTextDelta(streamOf([{ type: 'start' }, { type: 'text-delta', id: 't', delta: 'x' }]), () => trace.markFirstTextDelta()));
    expect(trace.timing()?.ttft_ms).toBe(300);
  });
});

describe('pre-generation delay (test-only, D-26)', () => {
  afterEach(() => {
    resetPreGenerationDelayForTests();
  });

  test('resolves immediately when no delay was set', async () => {
    const started = performance.now();
    await awaitPreGenerationDelay();
    expect(performance.now() - started).toBeLessThan(25);
  });

  test('waits at least the injected delay, and nothing after a reset', async () => {
    setPreGenerationDelayForTests(50);
    let started = performance.now();
    await awaitPreGenerationDelay();
    expect(performance.now() - started).toBeGreaterThanOrEqual(49);

    resetPreGenerationDelayForTests();
    started = performance.now();
    await awaitPreGenerationDelay();
    expect(performance.now() - started).toBeLessThan(25);
  });

  test('no environment variable sets the delay', async () => {
    const saved = { ...process.env };
    try {
      for (const name of ['RAG_PRE_GENERATION_DELAY_MS', 'PRE_GENERATION_DELAY_MS', 'RAG_TTFT_DELAY_MS']) process.env[name] = '200';
      const started = performance.now();
      await awaitPreGenerationDelay();
      expect(performance.now() - started).toBeLessThan(25);
    } finally {
      process.env = saved;
    }
    const source = readFileSync(fileURLToPath(new URL('../../../src/lib/rag/trace/ttft.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/process\.env|import\.meta\.env/);
  });

  test('a negative or non-finite delay is treated as none', async () => {
    for (const value of [-10, Number.NaN, Number.POSITIVE_INFINITY]) {
      setPreGenerationDelayForTests(value);
      const started = performance.now();
      await awaitPreGenerationDelay();
      expect(performance.now() - started).toBeLessThan(25);
    }
  });
});

describe('public exports', () => {
  test('@/lib/rag exports the timing helpers the routes import', () => {
    expect(typeof rag.withFirstTextDelta).toBe('function');
    expect(typeof rag.awaitPreGenerationDelay).toBe('function');
    expect(typeof rag.setPreGenerationDelayForTests).toBe('function');
    expect(typeof rag.resetPreGenerationDelayForTests).toBe('function');
    expect(typeof rag.postLangfuseScores).toBe('function');
    expect(rag.isTraceId('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(rag.isTraceId('0123456789ABCDEF0123456789abcdef')).toBe(false);
    expect(rag.isTraceId('not-a-trace')).toBe(false);
    expect(rag.isTraceId(42)).toBe(false);
    expect(rag.isTraceId(collector().traceId)).toBe(true);
  });
});

describe('traceCacheState (D-25)', () => {
  test('hit when the cache answered, miss when it handed out a ticket, bypass otherwise', () => {
    expect(rag.traceCacheState({ cacheHit: { answer: {} } })).toBe('hit');
    expect(rag.traceCacheState({ cacheHit: { answer: {} }, cacheTicket: { key: 'k' } })).toBe('hit');
    expect(rag.traceCacheState({ cacheTicket: { key: 'k' } })).toBe('miss');
    expect(rag.traceCacheState({})).toBe('bypass');
  });
});
