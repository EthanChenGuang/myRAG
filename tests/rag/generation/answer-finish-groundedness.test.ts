import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsertAnswerRecordInput } from '@/lib/answers/store';
import { AnswerRecordSchema, type GroundednessRequest, type GroundednessResult } from '@/lib/rag-eval/contracts.generated';
import {
  createGroundednessStep,
  mintAnswerId,
  scheduleAnswerFinish,
  type AnswerFinishDeps,
  type AnswerFinishInput,
  type GroundednessStepDeps,
} from '@/lib/rag/generation/answer-finish';
import { scoreAnswerGroundedness, type AnswerGroundedness, type ScoreAnswerGroundednessInput } from '@/lib/rag/generation/groundedness';
import { requestGroundedness } from '@/lib/rag/generation/groundedness-client';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import { resetLangfuseForTests } from '@/lib/rag/trace/langfuse';
import { isSampled } from '@/lib/rag/trace/sample';
import { scoreId } from '@/lib/rag/trace/scores';
import { mintScope } from '@/lib/rag/tenant/scope';
import { startFakeLangfuse, type FakeLangfuse } from '../../helpers/fake-langfuse.mts';

afterEach(() => {
  vi.restoreAllMocks();
});

const ANSWER_ID = '00000000-0000-4000-8000-0000000018a1';
const NOW = new Date('2026-11-25T10:00:00.000Z');
const BLOCK_ONE = 'Refunds are accepted within 30 days of purchase for annual plans.';
const BLOCK_TWO = 'Monthly plans can be cancelled at any time without a refund.';
const WEB_TEXT = 'A web page says annual plans have a thirty day window.';
const ANSWER = 'Annual plans can be refunded within 30 days [S1].';
const CONFIG = { vectaraOptIn: false, vectaraMultiTenantAck: false, maxPremiseTokens: 2000, groundednessTimeoutMs: 20000 };
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function scoreInput(overrides: Partial<ScoreAnswerGroundednessInput> = {}): ScoreAnswerGroundednessInput {
  return {
    answerId: ANSWER_ID,
    answerText: ANSWER,
    blocks: [
      { alias: 'S1', text: BLOCK_ONE },
      { alias: 'S2', text: BLOCK_TWO },
    ],
    citedAliases: ['S1'],
    webSearchTexts: [WEB_TEXT],
    eligibility: { eligible: true },
    multiTenant: false,
    config: CONFIG,
    ...overrides,
  };
}

function fakeRequest(result: Partial<GroundednessResult> = {}) {
  const calls: Array<{ request: GroundednessRequest; options: unknown }> = [];
  const request = vi.fn(async (body: GroundednessRequest, options?: unknown) => {
    calls.push({ request: body, options });
    return {
      status: 'scored',
      scorer: 'hhem_2_1_open',
      score: 0.71,
      reason: null,
      truncated: false,
      latency_ms: 42,
      ...result,
    } as GroundednessResult;
  });
  return { request, calls };
}

const recordSchema = AnswerRecordSchema.shape.groundedness;

describe('scoreAnswerGroundedness', () => {
  it('sends one request with the premise, the stripped hypothesis, the language and allow_vectara, and labels the score', async () => {
    const fake = fakeRequest();
    const result = await scoreAnswerGroundedness(scoreInput(), { request: fake.request, now: () => NOW });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].request).toEqual({
      request_id: ANSWER_ID,
      premise_texts: [BLOCK_ONE, BLOCK_TWO, WEB_TEXT],
      hypothesis: 'Annual plans can be refunded within 30 days.',
      language: 'en',
      allow_vectara: false,
    });
    expect(fake.calls[0].options).toMatchObject({ timeoutMs: 20000 });
    expect(result).toEqual({
      status: 'scored',
      label: 'verified',
      scorer: 'hhem_2_1_open',
      score: 0.71,
      threshold: 0.5,
      thresholdSource: 'default',
      reason: null,
      truncated: false,
      latencyMs: 42,
      checkedAt: NOW.toISOString(),
    });
    expect(recordSchema.parse(result)).toEqual(result);
  });

  it('labels a score under the threshold possibly_unreliable', async () => {
    const fake = fakeRequest({ score: 0.2 });
    const result = await scoreAnswerGroundedness(scoreInput(), { request: fake.request, now: () => NOW });
    expect(result.label).toBe('possibly_unreliable');
    expect(result.status).toBe('scored');
  });

  it('keeps the sidecar not_checked result with its reason and label not_checked', async () => {
    const fake = fakeRequest({ status: 'not_checked', scorer: 'none', score: null, reason: 'timeout', latency_ms: 50 });
    const result = await scoreAnswerGroundedness(scoreInput(), { request: fake.request, now: () => NOW });
    expect(fake.calls).toHaveLength(1);
    expect(result).toMatchObject({ status: 'not_checked', label: 'not_checked', scorer: 'none', score: null, reason: 'timeout', latencyMs: 50, threshold: null });
    expect(recordSchema.parse(result)).toEqual(result);
  });

  it('gives the eligibility reason and sends no request when the answer is not eligible', async () => {
    for (const reason of ['not_eligible', 'tool_output'] as const) {
      const fake = fakeRequest();
      const result = await scoreAnswerGroundedness(scoreInput({ eligibility: { eligible: false, reason } }), { request: fake.request, now: () => NOW });
      expect(fake.request).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'not_checked', label: 'not_checked', reason, scorer: 'none', score: null });
      expect(recordSchema.parse(result)).toEqual(result);
    }
  });

  it('gives too_long and sends no request when the cited blocks alone exceed the cap', async () => {
    const fake = fakeRequest();
    const result = await scoreAnswerGroundedness(scoreInput({ config: { ...CONFIG, maxPremiseTokens: 5 } }), {
      request: fake.request,
      countTokens: words,
      now: () => NOW,
    });
    expect(fake.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'not_checked', label: 'not_checked', reason: 'too_long' });
  });

  it('gives unsupported_language and sends no request for Traditional Chinese', async () => {
    const fake = fakeRequest();
    const result = await scoreAnswerGroundedness(scoreInput({ answerText: '年度方案可在購買後三十天內退款，這個說明來自後台資料 [S1]。' }), {
      request: fake.request,
      now: () => NOW,
    });
    expect(fake.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'not_checked', label: 'not_checked', reason: 'unsupported_language' });
  });

  it('sends zh-Hans as the language for Simplified Chinese', async () => {
    const fake = fakeRequest({ scorer: 'hhem_2_3_vectara' });
    await scoreAnswerGroundedness(scoreInput({ answerText: '年度方案可在购买后三十天内退款，这个说明来自后台资料 [S1]。' }), {
      request: fake.request,
      now: () => NOW,
    });
    expect(fake.calls[0].request.language).toBe('zh-Hans');
  });

  it('gives empty_answer and sends no request when only markers remain', async () => {
    const fake = fakeRequest();
    const result = await scoreAnswerGroundedness(scoreInput({ answerText: ' [S1] [S2] ' }), { request: fake.request, now: () => NOW });
    expect(fake.request).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'not_checked', reason: 'empty_answer' });
  });

  it('takes allow_vectara from allowVectaraFor, including the multi-tenant acknowledgement', async () => {
    const cases: Array<[Partial<typeof CONFIG>, boolean, boolean]> = [
      [{ vectaraOptIn: true }, false, true],
      [{ vectaraOptIn: true }, true, false],
      [{ vectaraOptIn: true, vectaraMultiTenantAck: true }, true, true],
      [{ vectaraOptIn: false, vectaraMultiTenantAck: true }, true, false],
    ];
    for (const [config, multiTenant, expected] of cases) {
      const fake = fakeRequest();
      await scoreAnswerGroundedness(scoreInput({ config: { ...CONFIG, ...config }, multiTenant }), { request: fake.request, now: () => NOW });
      expect(fake.calls[0].request.allow_vectara).toBe(expected);
    }
  });

  it('keeps truncated from the premise builder even when the sidecar reports false', async () => {
    const fake = fakeRequest({ truncated: false });
    const cap = words(BLOCK_ONE) + 2;
    const result = await scoreAnswerGroundedness(scoreInput({ config: { ...CONFIG, maxPremiseTokens: cap } }), {
      request: fake.request,
      countTokens: words,
      now: () => NOW,
    });
    expect(fake.calls[0].request.premise_texts).toEqual([BLOCK_ONE]);
    expect(result.truncated).toBe(true);
  });

  it('never throws when the request function throws', async () => {
    const request = vi.fn(async () => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await scoreAnswerGroundedness(scoreInput(), { request, now: () => NOW });
    expect(result).toMatchObject({ status: 'not_checked', label: 'not_checked', reason: 'error' });
  });
});

const USER = '00000000-0000-4000-8000-0000000018b1';
const QUERY = 'What is the refund window for annual plans?';
const LF_PUBLIC = 'pk-lf-test-placeholder';
const LF_SECRET = 'sk-lf-test-placeholder';
const ATTR = 'langfuse.observation.metadata.';

function traceIdWhere(sampled: boolean, rate: number): string {
  for (let i = 0; i < 10_000; i += 1) {
    const candidate = i.toString(16).padStart(32, 'a');
    if (isSampled(candidate, rate, 'trace') === sampled) return candidate;
  }
  throw new Error('no trace id found');
}

function finishInput(overrides: Partial<AnswerFinishInput> = {}): AnswerFinishInput {
  return {
    answerId: mintAnswerId(),
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: 'f'.repeat(32),
    modelId: 'test/model',
    ragMode: 'strict',
    queryText: QUERY,
    citations: [
      {
        n: 1,
        alias: 'S1',
        chunkIds: ['c1'],
        documentId: 'd1',
        documentName: 'Refunds.pdf',
        documentVersion: 1,
        page: null,
        sectionPath: null,
        quote: BLOCK_ONE,
        quoteHash: 'a'.repeat(64),
        strategy: 'chunk-alias',
      },
    ],
    citationStrategy: 'chunk-alias',
    invalidCitations: 0,
    answerText: ANSWER,
    aborted: false,
    groundednessEligible: true,
    toolOutputUsed: false,
    premise: {
      blocks: [
        { alias: 'S1', text: BLOCK_ONE },
        { alias: 'S2', text: BLOCK_TWO },
      ],
      webSearchTexts: [WEB_TEXT],
    },
    requestLanguage: 'en',
    ...overrides,
  };
}

function langfuseConfig(baseUrl: string, overrides: Partial<LangfuseConfig> = {}): LangfuseConfig {
  return {
    enabled: true,
    publicKey: LF_PUBLIC,
    secretKey: LF_SECRET,
    baseUrl,
    sampleRate: 1,
    reviewSampleRate: 0,
    captureContent: false,
    ...overrides,
  };
}

interface StepHarness {
  inserts: InsertAnswerRecordInput[];
  updates: Array<{ id: string; groundedness: AnswerGroundedness }>;
  tasks: Array<() => Promise<void>>;
  deps: Partial<AnswerFinishDeps>;
  run(): Promise<void>;
}

function stepHarness(step: Partial<GroundednessStepDeps> = {}, options: { inserted?: boolean; updateError?: boolean } = {}): StepHarness {
  const inserts: InsertAnswerRecordInput[] = [];
  const updates: Array<{ id: string; groundedness: AnswerGroundedness }> = [];
  const tasks: Array<() => Promise<void>> = [];
  const deps: Partial<AnswerFinishDeps> = {
    admin: () => ({}) as SupabaseClient,
    insert: async (_admin, input) => {
      inserts.push(input);
      return { inserted: options.inserted !== false };
    },
    schedule: (task) => {
      tasks.push(task);
    },
    readConfig: () => ({ groundedness: true }),
    onPending: createGroundednessStep({
      readConfig: () => CONFIG,
      multiTenant: () => false,
      langfuse: () => langfuseConfig('http://127.0.0.1:1', { enabled: false }),
      update: async (_admin, input) => {
        if (options.updateError) throw new Error('update failed (PGRST301)');
        updates.push(input);
        return true;
      },
      ...step,
    }),
  };
  return {
    inserts,
    updates,
    tasks,
    deps,
    async run() {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

function scoredRequest(score: number) {
  return vi.fn(async (body: GroundednessRequest) => {
    void body;
    return { status: 'scored', scorer: 'hhem_2_1_open', score, reason: null, truncated: false, latency_ms: 37 } as GroundednessResult;
  });
}

async function startHangingSidecar(): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let count = 0;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((_req, res) => {
    count += 1;
    held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => count,
    async close() {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function captureConsole() {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(capture);
  return lines;
}

const TEXTS = [ANSWER, 'Annual plans can be refunded within 30 days', BLOCK_ONE, BLOCK_TWO, WEB_TEXT, QUERY];

describe('the groundedness step after the pending insert', () => {
  it('inserts, scores and updates the row once, and the stored groundedness parses with the record schema', async () => {
    const lines = captureConsole();
    const request = scoredRequest(0.71);
    const h = stepHarness({ request, now: () => NOW });
    const input = finishInput();
    scheduleAnswerFinish(input, h.deps);
    expect(request).not.toHaveBeenCalled();
    await h.run();
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].groundedness).toEqual({ status: 'pending' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toMatchObject({ request_id: input.answerId, language: 'en', allow_vectara: false });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].id).toBe(input.answerId);
    const stored = recordSchema.parse(h.updates[0].groundedness);
    expect(stored).toEqual({
      status: 'scored',
      label: 'verified',
      scorer: 'hhem_2_1_open',
      score: 0.71,
      threshold: 0.5,
      thresholdSource: 'default',
      reason: null,
      truncated: false,
      latencyMs: 37,
      checkedAt: NOW.toISOString(),
    });
    expect(lines.filter((line) => line.startsWith('[Groundedness]'))).toHaveLength(1);
  });

  it('stores not_checked timeout when the sidecar never answers within the limit', async () => {
    captureConsole();
    const sidecar = await startHangingSidecar();
    try {
      const h = stepHarness({
        readConfig: () => ({ ...CONFIG, groundednessTimeoutMs: 50 }),
        request: (body, options) => requestGroundedness(body, { ...options, url: sidecar.url, secret: 'sidecar-secret-placeholder' }),
      });
      scheduleAnswerFinish(finishInput(), h.deps);
      expect(sidecar.requests()).toBe(0);
      await h.run();
      expect(sidecar.requests()).toBe(1);
      expect(h.updates).toHaveLength(1);
      expect(recordSchema.parse(h.updates[0].groundedness)).toMatchObject({ status: 'not_checked', label: 'not_checked', reason: 'timeout', scorer: 'none' });
    } finally {
      await sidecar.close();
    }
  });

  it('writes one [Groundedness] line with codes and numbers only, never answer, block, premise or query text', async () => {
    const lines = captureConsole();
    const input = finishInput();
    const h = stepHarness({ request: scoredRequest(0.2) });
    scheduleAnswerFinish(input, h.deps);
    await h.run();
    const groundednessLines = lines.filter((line) => line.startsWith('[Groundedness]'));
    expect(groundednessLines).toHaveLength(1);
    const payload = JSON.parse(groundednessLines[0].slice(groundednessLines[0].indexOf('{'))) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['answerId', 'label', 'language', 'latencyMs', 'scorer', 'status', 'truncated']);
    expect(payload).toMatchObject({ answerId: input.answerId, status: 'scored', scorer: 'hhem_2_1_open', label: 'possibly_unreliable', language: 'en', truncated: false, latencyMs: 37 });
    const all = lines.join('\n');
    for (const text of TEXTS) expect(all).not.toContain(text);
  });

  it('runs nothing after an insert that did not create the row', async () => {
    const request = scoredRequest(0.9);
    const h = stepHarness({ request }, { inserted: false });
    scheduleAnswerFinish(finishInput(), h.deps);
    await h.run();
    expect(request).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(0);
  });

  it('still logs the result when the update fails, and never throws', async () => {
    const lines = captureConsole();
    const h = stepHarness({ request: scoredRequest(0.9) }, { updateError: true });
    scheduleAnswerFinish(finishInput(), h.deps);
    await expect(h.run()).resolves.toBeUndefined();
    expect(lines.filter((line) => line.startsWith('[Groundedness]'))).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('[Answer Record]') && line.includes('PGRST301'))).toBe(true);
  });

  it('stores not_checked error when scoring itself throws', async () => {
    captureConsole();
    const h = stepHarness({
      request: async () => {
        throw new Error('boom');
      },
    });
    scheduleAnswerFinish(finishInput(), h.deps);
    await h.run();
    expect(h.updates[0].groundedness).toMatchObject({ status: 'not_checked', reason: 'error' });
  });

  describe('Langfuse span and scores', () => {
    let fake: FakeLangfuse;

    beforeAll(async () => {
      fake = await startFakeLangfuse();
    });

    afterAll(async () => {
      await resetLangfuseForTests();
      await fake.close();
    });

    beforeEach(() => {
      fake.reset();
    });

    afterEach(async () => {
      await resetLangfuseForTests();
    });

    function groundednessSpans(traceId: string) {
      return fake.spans.filter((span) => span.traceId === traceId && span.name === 'groundedness');
    }

    it('exports one groundedness span and posts the numeric and categorical scores when the trace was sampled', async () => {
      const lines = captureConsole();
      const traceId = traceIdWhere(true, 0.5);
      const h = stepHarness({ request: scoredRequest(0.71), langfuse: () => langfuseConfig(fake.url, { sampleRate: 0.5 }) });
      scheduleAnswerFinish(finishInput({ traceId }), h.deps);
      await h.run();

      const spans = groundednessSpans(traceId);
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes[`${ATTR}status`]).toBe('ok');
      expect(spans[0].attributes[`${ATTR}scorer`]).toBe('hhem_2_1_open');
      expect(spans[0].attributes[`${ATTR}label`]).toBe('verified');
      expect(spans[0].attributes[`${ATTR}latency_ms`]).toBe(37);
      expect(fake.scores).toEqual([
        expect.objectContaining({ id: scoreId(traceId, 'groundedness'), traceId, name: 'groundedness', value: 0.71, dataType: 'NUMERIC' }),
        expect.objectContaining({ id: scoreId(traceId, 'groundedness_label'), traceId, name: 'groundedness_label', value: 'verified', dataType: 'CATEGORICAL' }),
      ]);
      const exported = JSON.stringify(fake.spans) + JSON.stringify(fake.scores) + lines.join('\n');
      for (const text of TEXTS) expect(exported).not.toContain(text);
      expect(exported).not.toContain(LF_SECRET);
    });

    it('sends neither span nor scores for an unsampled trace labelled verified', async () => {
      captureConsole();
      const traceId = traceIdWhere(false, 0.5);
      const h = stepHarness({ request: scoredRequest(0.71), langfuse: () => langfuseConfig(fake.url, { sampleRate: 0.5 }) });
      scheduleAnswerFinish(finishInput({ traceId }), h.deps);
      await h.run();
      expect(h.updates).toHaveLength(1);
      expect(fake.requests).toHaveLength(0);
    });

    it('posts the scores for possibly_unreliable whatever the sampling', async () => {
      captureConsole();
      const traceId = traceIdWhere(false, 0.5);
      const h = stepHarness({ request: scoredRequest(0.2), langfuse: () => langfuseConfig(fake.url, { sampleRate: 0.5 }) });
      scheduleAnswerFinish(finishInput({ traceId }), h.deps);
      await h.run();
      expect(fake.scores).toEqual([
        expect.objectContaining({ traceId, name: 'groundedness', value: 0.2 }),
        expect.objectContaining({ traceId, name: 'groundedness_label', value: 'possibly_unreliable' }),
      ]);
      expect(groundednessSpans(traceId)).toHaveLength(1);
    });

    it('posts only the label score when there is no numeric score', async () => {
      captureConsole();
      const traceId = traceIdWhere(true, 1);
      const h = stepHarness({
        request: async () => ({ status: 'not_checked', scorer: 'none', score: null, reason: 'scorer_unavailable', truncated: false, latency_ms: 0 }),
        langfuse: () => langfuseConfig(fake.url),
      });
      scheduleAnswerFinish(finishInput({ traceId }), h.deps);
      await h.run();
      expect(fake.scores).toEqual([expect.objectContaining({ traceId, name: 'groundedness_label', value: 'not_checked' })]);
    });

    it('keeps the row and the log line when Langfuse fails', async () => {
      const lines = captureConsole();
      fake.setTraceMode('error500');
      const traceId = traceIdWhere(true, 1);
      const h = stepHarness({
        request: scoredRequest(0.2),
        langfuse: () => langfuseConfig(fake.url),
        postScores: async () => {
          throw new Error('scores down');
        },
        langfuseTimeoutMs: 200,
      });
      scheduleAnswerFinish(finishInput({ traceId }), h.deps);
      await expect(h.run()).resolves.toBeUndefined();
      expect(h.updates).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith('[Groundedness]'))).toHaveLength(1);
    });

    it('time-boxes a hanging Langfuse export', async () => {
      captureConsole();
      fake.setTraceMode('hang');
      const traceId = traceIdWhere(true, 1);
      const h = stepHarness({ request: scoredRequest(0.9), langfuse: () => langfuseConfig(fake.url), langfuseTimeoutMs: 100 });
      scheduleAnswerFinish(finishInput({ traceId }), h.deps);
      const started = Date.now();
      await h.run();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(h.updates).toHaveLength(1);
      fake.release();
    });
  });
});
