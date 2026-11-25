import { describe, expect, it, vi } from 'vitest';
import {
  POLL_SCHEDULE_MS,
  createAnswerRecordsController,
  loadChatAnswerRecords,
  pollAnswerRecord,
  reconcileAnswerRecords,
} from '@/lib/chat/use-answer-records';
import { AnswerRecordSchema, type AnswerRecord } from '@/lib/rag-eval/contracts.generated';
import type { ExtendedMessage } from '@/types/chat';

const ANSWER_ID = '7d3f0a52-4c1e-4b7a-9d55-2f1c8e6b9a01';
const OTHER_ID = '0b9e2c4a-1f3d-4e5b-8a6c-7d8e9f0a1b2c';
const CHAT_ID = '5a4b3c2d-1e0f-4a1b-9c2d-3e4f5a6b7c8d';

function record(status: 'pending' | 'scored' | 'not_checked', overrides: Record<string, unknown> = {}): AnswerRecord {
  return AnswerRecordSchema.parse({
    answerId: ANSWER_ID,
    createdAt: '2026-11-25T10:00:00.000Z',
    updatedAt: '2026-11-25T10:00:05.000Z',
    modelId: 'openai/gpt-4o-mini',
    ragMode: 'strict',
    traceId: 'f'.repeat(32),
    groundedness: status === 'scored' ? { status, label: 'verified', score: 0.9 } : { status },
    ...overrides,
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function scripted(responses: Array<() => Response>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string) => {
    calls.push(input);
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  });
  return { fetch, calls };
}

function recordingSleep() {
  const waits: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    waits.push(ms);
  });
  return { sleep, waits };
}

describe('pollAnswerRecord', () => {
  it('waits about 1, 2, 4 and 8 s, treats 404 as not yet and stops once groundedness is no longer pending', async () => {
    const { fetch, calls } = scripted([
      () => json(404, { error: 'Answer not found' }),
      () => json(404, { error: 'Answer not found' }),
      () => json(200, record('pending')),
      () => json(200, record('scored')),
    ]);
    const { sleep, waits } = recordingSleep();
    const seen: AnswerRecord[] = [];
    const outcome = await pollAnswerRecord(ANSWER_ID, { fetch, sleep, onRecord: (r) => seen.push(r) });
    expect(POLL_SCHEDULE_MS).toEqual([1000, 2000, 4000, 8000]);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
    expect(calls).toEqual(Array(4).fill(`/api/rag/answers/${ANSWER_ID}`));
    expect(outcome).toEqual({ status: 'settled', record: record('scored') });
    expect(seen.map((r) => r.groundedness.status)).toEqual(['pending', 'scored']);
  });

  it('gives up once the summed waits pass 30 s of 404s', async () => {
    const fetch = vi.fn(async () => json(404, { error: 'Answer not found' }));
    const { sleep, waits } = recordingSleep();
    const outcome = await pollAnswerRecord(ANSWER_ID, { fetch, sleep });
    expect(outcome).toEqual({ status: 'gave_up', record: null });
    const total = waits.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(30000);
    expect(total - waits[waits.length - 1]).toBeLessThan(30000);
    expect(waits.slice(4).every((ms) => ms === 8000)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(waits.length);
  });

  it('stops at once on 401 or 500 and on a network failure, without throwing', async () => {
    for (const status of [401, 500]) {
      const fetch = vi.fn(async () => json(status, { error: 'x' }));
      const { sleep } = recordingSleep();
      await expect(pollAnswerRecord(ANSWER_ID, { fetch, sleep })).resolves.toEqual({ status: 'stopped', httpStatus: status });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const failing = vi.fn(async () => {
      throw new TypeError('network');
    });
    await expect(pollAnswerRecord(ANSWER_ID, { fetch: failing, sleep: recordingSleep().sleep })).resolves.toEqual({
      status: 'stopped',
      httpStatus: null,
    });
  });

  it('stops on a body that fails the contract', async () => {
    const fetch = vi.fn(async () => json(200, { answerId: ANSWER_ID }));
    await expect(pollAnswerRecord(ANSWER_ID, { fetch, sleep: recordingSleep().sleep })).resolves.toEqual({
      status: 'stopped',
      httpStatus: 200,
    });
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async () => json(404, {}));
    const sleep = vi.fn(async (ms: number) => {
      if (ms === 2000) controller.abort();
    });
    const outcome = await pollAnswerRecord(ANSWER_ID, { fetch, sleep, signal: controller.signal });
    expect(outcome).toEqual({ status: 'aborted' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('makes no request for an id that is not a UUID', async () => {
    const fetch = vi.fn(async () => json(200, record('scored')));
    const outcome = await pollAnswerRecord('../etc', { fetch, sleep: recordingSleep().sleep });
    expect(outcome).toEqual({ status: 'stopped', httpStatus: null });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('loadChatAnswerRecords', () => {
  it('calls GET /api/rag/answers?chatId= once and returns the records', async () => {
    const records = [record('scored'), record('pending', { answerId: OTHER_ID })];
    const { fetch, calls } = scripted([() => json(200, { records })]);
    await expect(loadChatAnswerRecords(CHAT_ID, { fetch })).resolves.toEqual(records);
    expect(calls).toEqual([`/api/rag/answers?chatId=${CHAT_ID}`]);
  });

  it('makes no request for ghost or missing chat ids and returns [] on errors', async () => {
    const fetch = vi.fn(async () => json(200, { records: [record('scored')] }));
    await expect(loadChatAnswerRecords(`ghost-${CHAT_ID}`, { fetch })).resolves.toEqual([]);
    await expect(loadChatAnswerRecords('ghost-1700000000000', { fetch })).resolves.toEqual([]);
    await expect(loadChatAnswerRecords(null, { fetch })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();

    const notFound = vi.fn(async () => json(404, { error: 'Chat not found' }));
    await expect(loadChatAnswerRecords(CHAT_ID, { fetch: notFound })).resolves.toEqual([]);
    const broken = vi.fn(async () => json(200, { records: [{ answerId: ANSWER_ID }, record('scored', { answerId: OTHER_ID })] }));
    await expect(loadChatAnswerRecords(CHAT_ID, { fetch: broken })).resolves.toEqual([record('scored', { answerId: OTHER_ID })]);
  });
});

function assistant(id: string, metadata?: Record<string, unknown>): ExtendedMessage {
  return { id, role: 'assistant', content: 'answer', ...(metadata ? { metadata } : {}) };
}

describe('reconcileAnswerRecords', () => {
  it('merges records of this chat or of no chat yet, and leaves other chats alone', () => {
    const messages = [assistant('a-1', { answerId: ANSWER_ID }), assistant('a-2', { answerId: OTHER_ID })];
    const mine = record('scored', { chatId: CHAT_ID });
    const foreign = record('scored', { answerId: OTHER_ID, chatId: '9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c' });
    const merged = reconcileAnswerRecords(messages, { [ANSWER_ID]: mine, [OTHER_ID]: foreign }, CHAT_ID);
    expect(merged[0].metadata?.groundedness).toEqual(mine.groundedness);
    expect(merged[1]).toBe(messages[1]);
    const unlinked = record('scored', { answerId: OTHER_ID, chatId: null });
    expect(reconcileAnswerRecords(messages, { [OTHER_ID]: unlinked }, null)[1].metadata?.groundedness).toEqual(unlinked.groundedness);
    expect(reconcileAnswerRecords(messages, {}, CHAT_ID)).toBe(messages);
  });
});

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('createAnswerRecordsController', () => {
  it('loads a chat once, then polls only newly finished answers that are not settled', async () => {
    const fetch = vi.fn(async (input: string) => {
      if (input.startsWith('/api/rag/answers?chatId=')) return json(200, { records: [record('scored')] });
      return json(200, record('scored', { answerId: OTHER_ID }));
    });
    const upsert = vi.fn();
    const upsertMany = vi.fn();
    const controller = createAnswerRecordsController({ fetch, sleep: async () => {}, upsert, upsertMany });
    const loaded = [assistant('a-1', { answerId: ANSWER_ID })];
    controller.update({ chatId: CHAT_ID, messages: loaded, enabled: true });
    controller.update({ chatId: CHAT_ID, messages: loaded, enabled: true });
    await flush();
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([`/api/rag/answers?chatId=${CHAT_ID}`]);
    expect(upsertMany).toHaveBeenCalledWith([record('scored')]);

    const streaming = [...loaded, assistant('streaming', { answerId: OTHER_ID })];
    controller.update({ chatId: CHAT_ID, messages: streaming, enabled: true });
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);

    const finished = [...loaded, assistant('a-2', { answerId: OTHER_ID })];
    controller.update({ chatId: CHAT_ID, messages: finished, enabled: true });
    controller.update({ chatId: CHAT_ID, messages: finished, enabled: true });
    await flush();
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([`/api/rag/answers?chatId=${CHAT_ID}`, `/api/rag/answers/${OTHER_ID}`]);
    expect(upsert).toHaveBeenCalledWith(record('scored', { answerId: OTHER_ID }));
    controller.dispose();
  });

  it('does nothing for ghost chats or when disabled', async () => {
    const fetch = vi.fn(async () => json(200, record('scored')));
    const controller = createAnswerRecordsController({ fetch, sleep: async () => {}, upsert: vi.fn(), upsertMany: vi.fn() });
    const messages = [assistant('a-1', { answerId: ANSWER_ID })];
    controller.update({ chatId: 'ghost-1700000000000', messages, enabled: true });
    controller.update({ chatId: CHAT_ID, messages, enabled: false });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('polls a finished answer in a chat that has no id yet and skips answers already scored', async () => {
    const fetch = vi.fn(async () => json(200, record('scored')));
    const controller = createAnswerRecordsController({ fetch, sleep: async () => {}, upsert: vi.fn(), upsertMany: vi.fn() });
    controller.update({
      chatId: null,
      messages: [assistant('a-1', { answerId: ANSWER_ID }), assistant('a-0', { answerId: OTHER_ID, groundedness: { status: 'scored' } })],
      enabled: true,
    });
    await flush();
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([`/api/rag/answers/${ANSWER_ID}`]);
  });

  it('aborts running polls on dispose', async () => {
    let release: () => void = () => {};
    const sleep = vi.fn((_ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
      release = resolve;
      signal?.addEventListener('abort', () => resolve());
    }));
    const fetch = vi.fn(async () => json(404, {}));
    const controller = createAnswerRecordsController({ fetch, sleep, upsert: vi.fn(), upsertMany: vi.fn() });
    controller.update({ chatId: null, messages: [assistant('a-1', { answerId: ANSWER_ID })], enabled: true });
    await flush();
    controller.dispose();
    release();
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });
});
