import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnswerRecordSchema, type GroundednessRequest, type GroundednessResult } from '@/lib/rag-eval/contracts.generated';
import { scoreAnswerGroundedness, type ScoreAnswerGroundednessInput } from '@/lib/rag/generation/groundedness';

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
