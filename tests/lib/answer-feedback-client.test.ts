import { beforeEach, describe, expect, test, vi } from 'vitest';
import { submitAnswerFeedback, FEEDBACK_COMMENT_MAX } from '@/lib/chat/answer-feedback-client';
import { useAnswerRecordsStore } from '@/lib/stores/answer-records-store';
import { answerQualityStrings } from '@/translations/answer-quality';
import type { AnswerRecord } from '@/lib/rag-eval/contracts.generated';

const ANSWER_ID = '11111111-1111-4111-8111-111111111111';
const CHAT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-25T10:00:00.000Z');

const previous = { vote: 'helpful' as const, reasons: [], comment: null, updatedAt: '2026-11-25T09:00:00.000Z' };

function record(feedback: AnswerRecord['feedback'] = previous): AnswerRecord {
  return {
    answerId: ANSWER_ID,
    answerLanguage: 'en',
    chatId: CHAT_ID,
    citationStrategy: null,
    createdAt: '2026-11-25T08:59:00.000Z',
    feedback,
    feedbackEnabled: true,
    groundedness: {
      checkedAt: null, label: 'verified', latencyMs: 10, reason: null, score: 0.9, scorer: 'hhem_2_1_open',
      status: 'scored', threshold: 0.5, thresholdSource: 'default', truncated: false,
    },
    invalidCitations: 0,
    modelId: 'test/model',
    ragMode: 'strict',
    traceId: 'trace-1',
    updatedAt: '2026-11-25T09:00:00.000Z',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const stored = () => useAnswerRecordsStore.getState().records[ANSWER_ID]?.feedback;

beforeEach(() => {
  useAnswerRecordsStore.setState({ records: {} });
  useAnswerRecordsStore.getState().upsert(record());
});

describe('submitAnswerFeedback', () => {
  test('posts JSON and stores the returned feedback on 200', async () => {
    const serverFeedback = { vote: 'not_helpful', reasons: ['wrong'], comment: 'Off by a year', updatedAt: '2026-11-25T10:00:01.000Z' };
    const fetch = vi.fn(async () => json(200, { feedback: serverFeedback }));
    const result = await submitAnswerFeedback(
      ANSWER_ID,
      { vote: 'not_helpful', reasons: ['wrong'], comment: 'Off by a year', chatId: CHAT_ID },
      { fetch, now: () => NOW },
    );
    expect(result).toEqual({ ok: true, feedback: serverFeedback });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/rag/answers/${ANSWER_ID}/feedback`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ vote: 'not_helpful', reasons: ['wrong'], comment: 'Off by a year', chatId: CHAT_ID });
    expect(stored()).toEqual(serverFeedback);
  });

  test('applies the vote optimistically before the response arrives', async () => {
    let release: (r: Response) => void = () => {};
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    const pending = submitAnswerFeedback(ANSWER_ID, { vote: 'not_helpful' }, { fetch, now: () => NOW });
    await Promise.resolve();
    expect(stored()?.vote).toBe('not_helpful');
    release(json(200, { feedback: { vote: 'not_helpful', reasons: [], comment: null, updatedAt: NOW.toISOString() } }));
    await pending;
  });

  test.each([
    [400, 'bad_request'],
    [401, 'unauthorized'],
    [404, 'not_found'],
    [503, 'unavailable'],
  ] as const)('restores the previous feedback on %s', async (status, error) => {
    const fetch = vi.fn(async () => json(status, { error: 'x' }));
    const result = await submitAnswerFeedback(ANSWER_ID, { vote: 'not_helpful' }, { fetch, now: () => NOW });
    expect(result).toEqual({ ok: false, error });
    expect(stored()).toEqual(previous);
  });

  test('restores the previous feedback on a network error and does not throw', async () => {
    const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    await expect(submitAnswerFeedback(ANSWER_ID, { vote: 'not_helpful' }, { fetch, now: () => NOW })).resolves.toEqual({ ok: false, error: 'network' });
    expect(stored()).toEqual(previous);
  });

  test('restores null feedback when there was no earlier vote', async () => {
    useAnswerRecordsStore.setState({ records: {} });
    useAnswerRecordsStore.getState().upsert(record(null));
    const fetch = vi.fn(async () => json(404, {}));
    await submitAnswerFeedback(ANSWER_ID, { vote: 'helpful' }, { fetch, now: () => NOW });
    expect(stored()).toBeNull();
  });

  test('restores the previous feedback when the 200 body is malformed', async () => {
    const fetch = vi.fn(async () => json(200, { feedback: { vote: 'maybe' } }));
    const result = await submitAnswerFeedback(ANSWER_ID, { vote: 'not_helpful' }, { fetch, now: () => NOW });
    expect(result).toEqual({ ok: false, error: 'invalid_response' });
    expect(stored()).toEqual(previous);
  });

  test('a failed earlier vote does not overwrite a later vote', async () => {
    let failFirst: (r: Response) => void = () => {};
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { failFirst = resolve; }))
      .mockImplementationOnce(async () => json(200, { feedback: { vote: 'helpful', reasons: [], comment: null, updatedAt: '2026-11-25T10:00:02.000Z' } }));
    const first = submitAnswerFeedback(ANSWER_ID, { vote: 'not_helpful' }, { fetch, now: () => NOW });
    await submitAnswerFeedback(ANSWER_ID, { vote: 'helpful' }, { fetch, now: () => NOW });
    failFirst(json(503, {}));
    await first;
    expect(stored()?.vote).toBe('helpful');
  });

  test('refuses a comment longer than 500 characters before any request', async () => {
    const fetch = vi.fn(async () => json(200, {}));
    const result = await submitAnswerFeedback(ANSWER_ID, { vote: 'not_helpful', comment: 'x'.repeat(FEEDBACK_COMMENT_MAX + 1) }, { fetch, now: () => NOW });
    expect(result).toEqual({ ok: false, error: 'comment_too_long' });
    expect(fetch).not.toHaveBeenCalled();
    expect(stored()).toEqual(previous);
  });

  test('accepts exactly 500 characters', async () => {
    const comment = 'y'.repeat(FEEDBACK_COMMENT_MAX);
    const fetch = vi.fn(async () => json(200, { feedback: { vote: 'not_helpful', reasons: [], comment, updatedAt: NOW.toISOString() } }));
    const result = await submitAnswerFeedback(ANSWER_ID, { vote: 'not_helpful', comment }, { fetch, now: () => NOW });
    expect(result.ok).toBe(true);
  });

  test('refuses a malformed answer id before any request', async () => {
    const fetch = vi.fn(async () => json(200, {}));
    expect(await submitAnswerFeedback('../../admin', { vote: 'helpful' }, { fetch })).toEqual({ ok: false, error: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('answerQualityStrings badge and feedback strings', () => {
  test.each(['en', 'zh', 'it'])('%s has every badge, tooltip, vote and reason string', (lang) => {
    const s = answerQualityStrings(lang);
    for (const key of ['verified', 'possibly_unreliable', 'not_checked'] as const) {
      expect(s.badgeLabels[key]).toBeTruthy();
      expect(s.badgeTooltips[key]).toBeTruthy();
      expect(s.badgeTooltips[key]).not.toMatch(/\d/);
    }
    expect(s.helpfulLabel).toBeTruthy();
    expect(s.notHelpfulLabel).toBeTruthy();
    for (const key of ['wrong', 'incomplete', 'not_from_documents', 'bad_citation'] as const) expect(s.feedbackReasons[key]).toBeTruthy();
    expect(s.feedbackSubmit).toBeTruthy();
    expect(s.feedbackFailed).toBeTruthy();
    expect(s.feedbackCharactersLeft(12)).toContain('12');
  });

  test('zh and it are translated, and other locales fall back to en', () => {
    expect(answerQualityStrings('zh').badgeLabels.verified).not.toBe(answerQualityStrings('en').badgeLabels.verified);
    expect(answerQualityStrings('it').notHelpfulLabel).not.toBe(answerQualityStrings('en').notHelpfulLabel);
    expect(answerQualityStrings('fr').badgeLabels).toEqual(answerQualityStrings('en').badgeLabels);
    expect(answerQualityStrings('__proto__').helpfulLabel).toBe(answerQualityStrings('en').helpfulLabel);
  });
});
