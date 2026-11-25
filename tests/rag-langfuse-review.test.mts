import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
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
let readLangfuseConfig: typeof import('../src/lib/rag/trace/config.ts').readLangfuseConfig;
let hasLangfuseProcessor: typeof import('../src/lib/rag/trace/langfuse.ts').hasLangfuseProcessor;
let resetLangfuseForTests: typeof import('../src/lib/rag/trace/langfuse.ts').resetLangfuseForTests;
let exportReviewCandidate: typeof import('../src/lib/rag/trace/review-export.ts').exportReviewCandidate;

const PLACEHOLDER_PUBLIC_KEY = 'pk-lf-placeholder-0000';
const PLACEHOLDER_SECRET_KEY = 'sk-lf-placeholder-0000';
const TENANT_KEY = 'u:00000000-0000-4000-8000-000000000001';
const STAGE_NAMES = ['analyze', 'embed', 'search', 'legacy_rank', 'post_filter', 'assemble'];
const MARKER_EMAIL = 'marker.person@example.com';
const QUERY_TEXT = `what is the refund window, write to ${MARKER_EMAIL}`;
const ANSWER_TEXT = 'The refund window is 30 days, see the handbook or call +44 20 7946 0958.';
const CONTEXT_TEXT = 'Handbook: refunds within 30 days. Escalations to second.marker@example.org.';
const MODEL_ID = 'vendor/generator-placeholder';
const ATTR = 'langfuse.observation.';

let fake: FakeLangfuse;

before(async () => {
  ({ createTraceCollector } = await import('../src/lib/rag/trace/collector.ts'));
  ({ finishTrace } = await import('../src/lib/rag/trace/finish.ts'));
  ({ readLangfuseConfig } = await import('../src/lib/rag/trace/config.ts'));
  ({ hasLangfuseProcessor, resetLangfuseForTests } = await import('../src/lib/rag/trace/langfuse.ts'));
  ({ exportReviewCandidate } = await import('../src/lib/rag/trace/review-export.ts'));
  fake = await startFakeLangfuse();
});

after(async () => {
  await fake?.close();
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
    sampleRate: 0,
    reviewSampleRate: 0,
    captureContent: false,
    ...overrides,
  };
}

function buildCollector(): TraceCollector {
  const collector = createTraceCollector({ profile: 'chat', tenantKey: TENANT_KEY });
  let cursor = collector.startedAt;
  STAGE_NAMES.forEach((name, index) => {
    collector.record({ name, status: 'ok', startedAt: cursor, endedAt: cursor + 5 + index, candidatesIn: 10 - index, candidatesOut: 9 - index });
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
    kept: [{ chunk_id: 'c1', document_id: 'd1', document_name: 'handbook.md', content: 'chunk body kestrel-9042', similarity: 0.9, rank: 1, kept_by: 'similarity' }],
    queryTerms: [],
    refusalCandidate: false,
    stages: [],
    traceId: '',
    queryContext: null,
  };
}

function setReview(collector: TraceCollector): void {
  collector.setReviewContent({ query: QUERY_TEXT, answer: ANSWER_TEXT, context: CONTEXT_TEXT, model: MODEL_ID });
}

async function waitForCompleted(count: number, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (fake.completedTraceRequests() < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fake.completedTraceRequests(), count);
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tagsOf(span: FakeSpan): string[] {
  const raw = span.attributes['langfuse.trace.tags'];
  return Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
}

function attributeText(spans: FakeSpan[]): string {
  return JSON.stringify(spans.map((span) => span.attributes));
}

function rootOf(spans: FakeSpan[]): FakeSpan {
  const root = spans.find((span) => span.name === 'rag-request');
  assert.ok(root, 'root observation present');
  return root;
}

describe('review-candidate export', () => {
  test('a review candidate that is not trace-sampled is exported with masked query, answer and context, tagged on every span', async () => {
    const collector = buildCollector();
    setReview(collector);
    const lines: string[] = [];
    finishTrace(collector, buildResult(), { config: configFor({ sampleRate: 0, reviewSampleRate: 1 }), sink: (line) => lines.push(line) });
    await waitForCompleted(1);

    assert.deepEqual(fake.errors, []);
    assert.deepEqual(lines, []);
    assert.equal(fake.spans.length, 1 + STAGE_NAMES.length);
    for (const span of fake.spans) {
      assert.ok(tagsOf(span).includes('review_candidate'), `${span.name} carries review_candidate`);
      assert.ok(tagsOf(span).includes(`tenant:${TENANT_KEY}`), `${span.name} carries the tenant tag`);
      assert.equal(span.attributes['user.id'], TENANT_KEY, `${span.name} user.id`);
    }

    const root = rootOf(fake.spans);
    const input = String(root.attributes[`${ATTR}input`]);
    const output = String(root.attributes[`${ATTR}output`]);
    assert.ok(input.includes('refund window'));
    assert.ok(input.includes('[EMAIL]'));
    assert.ok(output.includes('30 days'));
    assert.ok(output.includes('[PHONE]'));
    assert.ok(String(root.attributes[`${ATTR}metadata.context`]).includes('Escalations'));
    assert.ok(String(root.attributes[`${ATTR}metadata.context`]).includes('[EMAIL]'));
    assert.equal(JSON.parse(String(root.attributes[`${ATTR}metadata.model`])), MODEL_ID);

    const everything = attributeText(fake.spans);
    assert.ok(!everything.includes(MARKER_EMAIL), 'query e-mail is masked');
    assert.ok(!everything.includes('second.marker@example.org'), 'context e-mail is masked');
    assert.ok(!everything.includes('7946 0958'), 'answer phone number is masked');
  });

  test('content set after finishTrace scheduled the export is still included', async () => {
    const collector = buildCollector();
    finishTrace(collector, buildResult(), { config: configFor({ reviewSampleRate: 1 }) });
    setReview(collector);
    await waitForCompleted(1);

    const root = rootOf(fake.spans);
    assert.ok(String(root.attributes[`${ATTR}output`]).includes('30 days'));
    assert.ok(String(root.attributes[`${ATTR}input`]).includes('refund window'));
  });

  test('without a review candidate or content capture no content attribute is exported, even when the collector holds content', async () => {
    const collector = buildCollector();
    setReview(collector);
    finishTrace(collector, buildResult(), { config: configFor({ sampleRate: 1, reviewSampleRate: 0, captureContent: false }), query: QUERY_TEXT });
    await waitForCompleted(1);

    const everything = attributeText(fake.spans);
    assert.ok(!everything.includes('refund window'));
    assert.ok(!everything.includes('30 days'));
    assert.ok(!everything.includes('Escalations'));
    assert.ok(!everything.includes(MARKER_EMAIL));
    assert.ok(!everything.includes(MODEL_ID));
    for (const span of fake.spans) assert.ok(!tagsOf(span).includes('review_candidate'), `${span.name} is not a review candidate`);
    const root = rootOf(fake.spans);
    assert.ok(!(`${ATTR}input` in root.attributes));
    assert.ok(!(`${ATTR}output` in root.attributes));
  });

  test('neither trace-sampled nor a review candidate: no request, one [RAG Trace] line', async () => {
    const collector = buildCollector();
    setReview(collector);
    const lines: string[] = [];
    finishTrace(collector, buildResult(), { config: configFor({ sampleRate: 0, reviewSampleRate: 0 }), sink: (line) => lines.push(line) });
    await settle();

    assert.equal(fake.requests.length, 0);
    assert.equal(hasLangfuseProcessor(), false);
    assert.equal(lines.filter((line) => line.includes('[RAG Trace]')).length, 1);
  });

  test('a review candidate with Langfuse disabled sends nothing and logs one line', async () => {
    const collector = buildCollector();
    setReview(collector);
    const lines: string[] = [];
    finishTrace(collector, buildResult(), { config: configFor({ enabled: false, reviewSampleRate: 1 }), sink: (line) => lines.push(line) });
    await settle();

    assert.equal(fake.requests.length, 0);
    assert.equal(lines.filter((line) => line.includes('[RAG Trace]')).length, 1);
  });

  test('a trace-sampled review candidate exports the review content once, not the chunk capture', async () => {
    const collector = buildCollector();
    setReview(collector);
    finishTrace(collector, buildResult(), { config: configFor({ sampleRate: 1, reviewSampleRate: 1, captureContent: true }), query: QUERY_TEXT });
    await waitForCompleted(1);

    assert.equal(fake.spans.length, 1 + STAGE_NAMES.length);
    const root = rootOf(fake.spans);
    assert.ok(String(root.attributes[`${ATTR}output`]).includes('30 days'));
    assert.ok(!attributeText(fake.spans).includes('kestrel-9042'));
  });

  test('LANGFUSE_REVIEW_SAMPLE_RATE defaults to 0 and is clamped to [0, 1]', () => {
    assert.equal(readLangfuseConfig({}).reviewSampleRate, 0);
    assert.equal(readLangfuseConfig({ LANGFUSE_REVIEW_SAMPLE_RATE: '0.25' }).reviewSampleRate, 0.25);
    assert.equal(readLangfuseConfig({ LANGFUSE_REVIEW_SAMPLE_RATE: '7' }).reviewSampleRate, 1);
    assert.equal(readLangfuseConfig({ LANGFUSE_REVIEW_SAMPLE_RATE: 'nope' }).reviewSampleRate, 0);
  });
});

describe('review export for feedback_negative and groundedness_flagged (D-19)', () => {
  const TRACE_ID = '0123456789abcdef0123456789abcdef';

  for (const reason of ['feedback_negative', 'groundedness_flagged'] as const) {
    test(`${reason}: one masked observation on the same trace, tagged review_candidate and review:${reason}, with both sample rates at 0`, async () => {
      const status = await exportReviewCandidate(
        { traceId: TRACE_ID, tenantKey: TENANT_KEY, reason, query: QUERY_TEXT, answer: ANSWER_TEXT, citedQuotes: [CONTEXT_TEXT, 'Second quote, call +44 20 7946 0958.'], model: MODEL_ID },
        { config: configFor({ sampleRate: 0, reviewSampleRate: 0 }) },
      );
      assert.equal(status, 'exported');
      await waitForCompleted(1);
      assert.deepEqual(fake.errors, []);
      assert.ok(fake.spans.length >= 1);
      for (const span of fake.spans) {
        assert.equal(span.traceId, TRACE_ID);
        assert.ok(tagsOf(span).includes('review_candidate'), `${span.name} carries review_candidate`);
        assert.ok(tagsOf(span).includes(`review:${reason}`), `${span.name} carries review:${reason}`);
        assert.ok(tagsOf(span).includes(`tenant:${TENANT_KEY}`));
      }
      const root = rootOf(fake.spans);
      assert.ok(String(root.attributes[`${ATTR}input`]).includes('refund window'));
      assert.ok(String(root.attributes[`${ATTR}output`]).includes('30 days'));
      const context = String(root.attributes[`${ATTR}metadata.context`]);
      assert.ok(context.includes('Escalations') && context.includes('Second quote'));
      const everything = attributeText(fake.spans);
      assert.ok(!everything.includes(MARKER_EMAIL));
      assert.ok(!everything.includes('second.marker@example.org'));
      assert.ok(!everything.includes('7946 0958'));
    });
  }

  test('with Langfuse off nothing is sent and nothing throws', async () => {
    const status = await exportReviewCandidate(
      { traceId: TRACE_ID, tenantKey: TENANT_KEY, reason: 'feedback_negative', query: QUERY_TEXT, answer: ANSWER_TEXT, citedQuotes: [], model: MODEL_ID },
      { config: configFor({ enabled: false }) },
    );
    assert.equal(status, 'skipped');
    await settle();
    assert.equal(fake.requests.length, 0);
    assert.equal(hasLangfuseProcessor(), false);
  });

  test('a trace id that is not a 32-hex OTel id is skipped', async () => {
    const status = await exportReviewCandidate(
      { traceId: 'not-an-otel-id', tenantKey: TENANT_KEY, reason: 'feedback_negative', query: QUERY_TEXT, answer: ANSWER_TEXT, citedQuotes: [], model: MODEL_ID },
      { config: configFor() },
    );
    assert.equal(status, 'skipped');
    await settle();
    assert.equal(fake.requests.length, 0);
  });
});
