import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../eval/harness/run-eval.mts';
import { startFakeLangfuse, type FakeLangfuse, type FakeSpan } from './helpers/fake-langfuse.mts';
import type { TraceCollector } from '../src/lib/rag/trace/collector.ts';
import type { LangfuseConfig } from '../src/lib/rag/trace/config.ts';
import type { RetrievalResult } from '../src/lib/rag/types.ts';

const ENV_PLACEHOLDERS: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key-placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-placeholder',
  OPENAI_API_KEY: 'test-openai-key-placeholder',
  OPENROUTER_API_KEY: 'sk-or-abcdefghijklmnopqrstuvwxyzabcdef',
};
for (const [name, value] of Object.entries(ENV_PLACEHOLDERS)) process.env[name] ??= value;

let createTraceCollector: typeof import('../src/lib/rag/trace/collector.ts').createTraceCollector;
let finishTrace: typeof import('../src/lib/rag/trace/finish.ts').finishTrace;
let hasLangfuseProcessor: typeof import('../src/lib/rag/trace/langfuse.ts').hasLangfuseProcessor;
let resetLangfuseForTests: typeof import('../src/lib/rag/trace/langfuse.ts').resetLangfuseForTests;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const PLACEHOLDER_PUBLIC_KEY = 'pk-lf-placeholder-0000';
const PLACEHOLDER_SECRET_KEY = 'sk-lf-placeholder-0000';
const STAGE_NAMES = ['analyze', 'embed', 'search', 'legacy_rank', 'post_filter', 'assemble'];
const MARKER_EMAIL = 'marker.person@example.com';
const QUERY_TEXT = `what is the refund window, contact ${MARKER_EMAIL}`;
const CHUNK_TEXT = 'chunk body marker kestrel-9042 reach +44 20 7946 0958';
const ATTR = 'langfuse.observation.metadata.';

let fake: FakeLangfuse;

let prepared: InProcessEval;

before(async () => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    prepared = await prepareInProcessEval({ corpusDir: CORPUS_DIR, deploymentMode: 'single-tenant' });
  } finally {
    Object.assign(console, original);
  }
  ({ createTraceCollector } = await import('../src/lib/rag/trace/collector.ts'));
  ({ finishTrace } = await import('../src/lib/rag/trace/finish.ts'));
  ({ hasLangfuseProcessor, resetLangfuseForTests } = await import('../src/lib/rag/trace/langfuse.ts'));
  fake = await startFakeLangfuse();
});

after(async () => {
  await fake?.close();
  await prepared?.close();
});

beforeEach(async () => {
  fake.reset();
  await resetLangfuseForTests();
});

afterEach(async () => {
  fake.release();
  await resetLangfuseForTests();
});

function configFor(overrides: Partial<LangfuseConfig> = {}): LangfuseConfig {
  return {
    enabled: true,
    publicKey: PLACEHOLDER_PUBLIC_KEY,
    secretKey: PLACEHOLDER_SECRET_KEY,
    baseUrl: fake.url,
    sampleRate: 1,
    reviewSampleRate: 0,
    captureContent: false,
    ...overrides,
  };
}

function buildCollector(): TraceCollector {
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 'u:00000000-0000-4000-8000-000000000001' });
  let cursor = collector.startedAt;
  STAGE_NAMES.forEach((name, index) => {
    collector.record({
      name,
      status: 'ok',
      startedAt: cursor,
      endedAt: cursor + 5 + index,
      candidatesIn: index === 0 ? null : 10 - index,
      candidatesOut: 9 - index,
      rules: index === 3 ? ['similarity>=0.3'] : [],
    });
    cursor += 5 + index;
  });
  return collector;
}

function buildResult(): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [{ chunk_id: 'c1', document_id: 'd1', document_name: 'handbook.md', content: CHUNK_TEXT, similarity: 0.9, rank: 1, kept_by: 'similarity' }],
    queryTerms: [],
    refusalCandidate: false,
    stages: [],
    traceId: '',
    queryContext: null,
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function traceLines(lines: string[]): string[] {
  return lines.filter((line) => line.includes('[RAG Trace]'));
}

function attributeText(spans: FakeSpan[]): string {
  return JSON.stringify(spans.map((span) => span.attributes));
}

describe('langfuse span replay', () => {
  test('a sampled request becomes one trace with a root and one span per stage', async () => {
    const collector = buildCollector();
    const lines: string[] = [];
    finishTrace(collector, buildResult(), { config: configFor(), sink: (line) => lines.push(line) });
    await waitFor(() => fake.completedTraceRequests() === 1);

    assert.equal(fake.requests[0].path, '/api/public/otel/v1/traces');
    assert.equal(fake.requests[0].authorization, `Basic ${Buffer.from(`${PLACEHOLDER_PUBLIC_KEY}:${PLACEHOLDER_SECRET_KEY}`).toString('base64')}`);
    assert.deepEqual(fake.errors, []);
    assert.deepEqual(lines, []);

    const traceIds = new Set(fake.spans.map((span) => span.traceId));
    assert.equal(traceIds.size, 1);
    assert.equal([...traceIds][0], collector.traceId);
    assert.equal(fake.spans.length, 1 + STAGE_NAMES.length);

    const root = fake.spans.find((span) => span.name === 'rag-request');
    assert.ok(root);
    const stageSpans = fake.spans.filter((span) => span.name !== 'rag-request');
    assert.deepEqual(stageSpans.map((span) => span.name).sort(), [...STAGE_NAMES].sort());
    assert.deepEqual(stageSpans.map((span) => span.name).sort(), Object.keys(collector.toStageLatency()).sort());
    for (const span of stageSpans) assert.equal(span.parentSpanId, root.spanId);
  });

  test('every stage span carries latency, candidate counts, status and rules, and every span the tenant key', async () => {
    const collector = buildCollector();
    finishTrace(collector, buildResult(), { config: configFor() });
    await waitFor(() => fake.completedTraceRequests() === 1);

    const latency = collector.toStageLatency();
    for (const span of fake.spans.filter((candidate) => candidate.name !== 'rag-request')) {
      const attributes = span.attributes;
      assert.equal(Number(attributes[`${ATTR}latency_ms`]), latency[span.name], `${span.name} latency_ms`);
      assert.ok(`${ATTR}candidates_in` in attributes, `${span.name} candidates_in`);
      assert.ok(`${ATTR}candidates_out` in attributes, `${span.name} candidates_out`);
      assert.ok(`${ATTR}status` in attributes, `${span.name} status`);
      assert.ok(`${ATTR}rules` in attributes, `${span.name} rules`);
    }
    for (const stage of collector.stages()) {
      const span = fake.spans.find((candidate) => candidate.name === stage.name);
      assert.ok(span);
      assert.equal(Math.round(Number(span.startTimeUnixNano) / 1e6), stage.startedAt, `${stage.name} start time`);
      assert.equal(Math.round(Number(span.endTimeUnixNano) / 1e6), stage.endedAt, `${stage.name} end time`);
    }
    const legacyRank = fake.spans.find((span) => span.name === 'legacy_rank');
    assert.ok(legacyRank);
    assert.match(String(legacyRank.attributes[`${ATTR}rules`]), /similarity>=0\.3/);

    for (const span of fake.spans) {
      assert.equal(span.attributes['user.id'], collector.tenantKey, `${span.name} user.id`);
      assert.ok(String(span.attributes['langfuse.trace.tags'] ?? '').includes(`tenant:${collector.tenantKey}`), `${span.name} tags`);
    }
  });

  test('query and chunk text are absent unless capture is on, and masked when it is', async () => {
    finishTrace(buildCollector(), buildResult(), { config: configFor({ captureContent: false }), query: QUERY_TEXT });
    await waitFor(() => fake.completedTraceRequests() === 1);
    const without = attributeText(fake.spans);
    assert.ok(!without.includes('refund window'));
    assert.ok(!without.includes('kestrel-9042'));
    assert.ok(!without.includes(MARKER_EMAIL));

    fake.reset();
    await resetLangfuseForTests();
    finishTrace(buildCollector(), buildResult(), { config: configFor({ captureContent: true }), query: QUERY_TEXT });
    await waitFor(() => fake.completedTraceRequests() === 1);
    const withContent = attributeText(fake.spans);
    assert.ok(withContent.includes('refund window'));
    assert.ok(withContent.includes('kestrel-9042'));
    assert.ok(withContent.includes('[EMAIL]'));
    assert.ok(withContent.includes('[PHONE]'));
    assert.ok(!withContent.includes(MARKER_EMAIL));
    assert.ok(!withContent.includes('7946 0958'));
  });
});

describe('request timing on the root (D-25)', () => {
  const TIMING_KEYS = ['ttft_ms', 'pre_generation_ms', 'cache'];

  test('timing recorded after finishTrace, before the export runs, lands on the root metadata only', async () => {
    const collector = buildCollector();
    const start = collector.startedAt - 20;
    collector.markRequestStart(start);
    collector.markGenerationStart();
    finishTrace(collector, buildResult(), { config: configFor(), query: QUERY_TEXT });
    collector.markFirstTextDelta();
    collector.setCacheState('miss');
    const timing = collector.timing();
    assert.ok(timing && typeof timing.ttft_ms === 'number' && typeof timing.pre_generation_ms === 'number');
    await waitFor(() => fake.completedTraceRequests() === 1);

    const root = fake.spans.find((span) => span.name === 'rag-request');
    assert.ok(root);
    assert.equal(Number(root.attributes[`${ATTR}ttft_ms`]), timing.ttft_ms);
    assert.equal(Number(root.attributes[`${ATTR}pre_generation_ms`]), timing.pre_generation_ms);
    assert.equal(root.attributes[`${ATTR}cache`], 'miss');
    for (const span of fake.spans.filter((candidate) => candidate.name !== 'rag-request')) {
      for (const key of TIMING_KEYS) assert.ok(!(`${ATTR}${key}` in span.attributes), `${span.name} ${key}`);
    }
    const text = attributeText(fake.spans);
    assert.ok(!text.includes('refund window'));
    assert.ok(!text.includes('kestrel-9042'));
  });

  test('a trace that records no timing exports no timing key', async () => {
    finishTrace(buildCollector(), buildResult(), { config: configFor() });
    await waitFor(() => fake.completedTraceRequests() === 1);
    for (const span of fake.spans) {
      for (const key of TIMING_KEYS) assert.ok(!(`${ATTR}${key}` in span.attributes), `${span.name} ${key}`);
    }
  });
});

describe('fallback to the [RAG Trace] log line', () => {
  test('LANGFUSE_ENABLED=false with keys present sends nothing and builds no processor', async () => {
    const lines: string[] = [];
    finishTrace(buildCollector(), buildResult(), { config: configFor({ enabled: false }), sink: (line) => lines.push(line) });
    await settle();
    assert.equal(fake.requests.length, 0);
    assert.equal(hasLangfuseProcessor(), false);
    assert.equal(traceLines(lines).length, 1);
  });

  test('an unsampled request sends nothing and logs one line', async () => {
    const lines: string[] = [];
    finishTrace(buildCollector(), buildResult(), { config: configFor({ sampleRate: 0 }), sink: (line) => lines.push(line) });
    await settle();
    assert.equal(fake.requests.length, 0);
    assert.equal(hasLangfuseProcessor(), false);
    assert.equal(traceLines(lines).length, 1);
  });

  test('an endpoint that hangs past the time box logs one line and never throws', async () => {
    fake.setTraceMode('hang');
    const lines: string[] = [];
    assert.doesNotThrow(() =>
      finishTrace(buildCollector(), buildResult(), { config: configFor(), sink: (line) => lines.push(line), flushTimeoutMs: 300 }),
    );
    await waitFor(() => traceLines(lines).length >= 1);
    await settle(400);
    assert.equal(traceLines(lines).length, 1);
    assert.equal(fake.completedTraceRequests(), 0);
  });

  test('an endpoint answering 500 logs one line and never throws', async () => {
    fake.setTraceMode('error500');
    const lines: string[] = [];
    assert.doesNotThrow(() => finishTrace(buildCollector(), buildResult(), { config: configFor(), sink: (line) => lines.push(line) }));
    await waitFor(() => traceLines(lines).length >= 1);
    await settle(400);
    assert.equal(traceLines(lines).length, 1);
    assert.ok(fake.traceRequestCount() >= 1);
  });
});

describe('export after the response (eval route, in process)', () => {
  const saved: Record<string, string | undefined> = {};
  const LANGFUSE_VARS = ['LANGFUSE_ENABLED', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL', 'LANGFUSE_SAMPLE_RATE', 'LANGFUSE_CAPTURE_CONTENT'];

  beforeEach(() => {
    for (const name of LANGFUSE_VARS) saved[name] = process.env[name];
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = PLACEHOLDER_PUBLIC_KEY;
    process.env.LANGFUSE_SECRET_KEY = PLACEHOLDER_SECRET_KEY;
    process.env.LANGFUSE_BASE_URL = fake.url;
    process.env.LANGFUSE_SAMPLE_RATE = '1';
    process.env.LANGFUSE_CAPTURE_CONTENT = 'false';
  });

  afterEach(() => {
    for (const name of LANGFUSE_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test('the response is complete while the export is still held open, and the export finishes once released', async () => {
    fake.setTraceMode('hang');
    const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
      body: JSON.stringify({ schema_version: 1, query: 'What is the refund window for annual plans?', rag_mode: 'strict', web_search: false, options: {} }),
    });
    const res = await prepared.POST(req);
    const body = (await res.json()) as { stage_latency_ms: Record<string, number> };
    assert.equal(res.status, 200);
    const stageNames = Object.keys(body.stage_latency_ms);
    assert.ok(stageNames.length > 0);

    await waitFor(() => fake.traceRequestCount() === 1);
    assert.equal(fake.completedTraceRequests(), 0, 'the export is still pending after the body was fully read');

    fake.release();
    // Under heavy load the exporter's own request timeout can end the held request before release; either way the export settles.
    await waitFor(() => fake.completedTraceRequests() + fake.abandonedTraceRequests() >= 1);
    assert.equal(fake.spans.length, 1 + stageNames.length);
    assert.deepEqual(
      fake.spans.filter((span) => span.name !== 'rag-request').map((span) => span.name).sort(),
      [...stageNames].sort(),
    );
  });
});
