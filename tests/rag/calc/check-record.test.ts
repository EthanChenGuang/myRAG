import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsertAnswerRecordInput, ReviewReason } from '@/lib/answers/store';
import { AnswerChecksSchema, type CalcCheck } from '@/lib/rag-eval/contracts.generated';
import {
  mintAnswerId,
  scheduleAnswerFinish,
  scheduleCalcReviewEnqueue,
  type AnswerFinishDeps,
  type AnswerFinishInput,
} from '@/lib/rag/generation/answer-finish';
import { mintScope } from '@/lib/rag/tenant/scope';

const USER = '00000000-0000-4000-8000-00000000ca1c';

const CORRECTED: CalcCheck = {
  status: 'corrected',
  stated: '40',
  recomputed: '36',
  unit: 'units',
  trace_hash: 'a'.repeat(64),
  origin: 'trailing_block',
  reason: null,
  stated_span: { start: 13, end: 15 },
};
const VERIFIED: CalcCheck = { ...CORRECTED, status: 'verified', stated: '36', stated_span: { start: 40, end: 42 } };

function finishInput(overrides: Partial<AnswerFinishInput> = {}): AnswerFinishInput {
  return {
    answerId: mintAnswerId(),
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: 'trace-calc-1',
    modelId: 'test/model',
    ragMode: 'strict',
    queryText: 'What is 3 times the value of item one?',
    citations: [],
    citationStrategy: null,
    invalidCitations: 0,
    answerText: 'The total is 40 units.',
    aborted: false,
    groundednessEligible: false,
    toolOutputUsed: false,
    premise: { blocks: [{ alias: 'S1', text: 'Item one has value 12 units.' }], webSearchTexts: [] },
    requestLanguage: 'en',
    ...overrides,
  };
}

function harness() {
  const inserts: InsertAnswerRecordInput[] = [];
  const appended: Array<{ id: string; reason: ReviewReason }> = [];
  const tasks: Array<() => Promise<void>> = [];
  const deps: Partial<AnswerFinishDeps> = {
    admin: () => ({}) as SupabaseClient,
    insert: async (_client, input) => {
      inserts.push(input);
      return { inserted: true };
    },
    schedule: (task) => {
      tasks.push(task);
    },
    readConfig: () => ({ groundedness: false }),
    onPending: async () => undefined,
    appendReviewReason: async (_client, input) => {
      appended.push(input);
      return true;
    },
  };
  return {
    inserts,
    appended,
    deps,
    async run() {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('answer record: calculation checks and reasons (D-23, D-55, D-75)', () => {
  it('stores checks.calc (the primary) and checks.calc_items, then appends calc_mismatch', async () => {
    const h = harness();
    const input = finishInput({
      checks: { truncated: false, finish_reason: 'stop' },
      calc: { primary: CORRECTED, items: [VERIFIED, CORRECTED], reviewReasons: ['calc_mismatch'] },
    });
    scheduleAnswerFinish(input, h.deps);
    await h.run();
    expect(h.inserts).toHaveLength(1);
    const checks = h.inserts[0]!.checks;
    expect(checks?.calc).toEqual(CORRECTED);
    expect(checks?.calc_items).toEqual([VERIFIED, CORRECTED]);
    expect(checks?.finish_reason).toBe('stop');
    expect(AnswerChecksSchema.safeParse(checks).success).toBe(true);
    expect(h.appended).toEqual([{ id: input.answerId, reason: 'calc_mismatch' }]);
  });

  it('without calc the record and the reasons are as before', async () => {
    const h = harness();
    scheduleAnswerFinish(finishInput({ checks: { truncated: false, finish_reason: 'stop' } }), h.deps);
    await h.run();
    expect(h.inserts[0]!.checks).not.toHaveProperty('calc');
    expect(h.inserts[0]!.checks).not.toHaveProperty('calc_items');
    expect(h.appended).toEqual([]);
  });

  it('a failing append is logged with ids only and the record stays written', async () => {
    const h = harness();
    h.deps.appendReviewReason = async () => {
      throw new Error('down (db_down)');
    };
    scheduleAnswerFinish(
      finishInput({ checks: { truncated: false, finish_reason: 'stop' }, calc: { primary: CORRECTED, items: [CORRECTED], reviewReasons: ['calc_mismatch'] } }),
      h.deps,
    );
    await h.run();
    expect(h.inserts).toHaveLength(1);
    const warn = vi.mocked(console.warn).mock.calls.find((call) => String(call[0]).includes('Review reason append failed'));
    expect(warn?.[1]).toMatchObject({ reason: 'calc_mismatch', code: 'db_down' });
    expect(JSON.stringify(warn)).not.toContain('item one');
  });
});

describe('scheduleCalcReviewEnqueue (D-55 direct route)', () => {
  const base = { tenantKey: 's:default', sourceChunkIds: ['c1'], documentIds: ['d1'], traceId: 'trace-calc-1' };

  it('enqueues each reason with ids only after the response', async () => {
    const enqueue = vi.fn(async () => null);
    const tasks: Array<() => Promise<void>> = [];
    const scheduled = scheduleCalcReviewEnqueue(
      { ...base, reasons: ['calc_mismatch', 'calc_unverified'], ghost: false },
      { enqueue, schedule: (task) => tasks.push(task) },
    );
    expect(scheduled).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    for (const task of tasks) await task();
    expect(enqueue.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      { tenantKey: 's:default', reason: 'calc_mismatch', sourceChunkIds: ['c1'], documentIds: ['d1'], detector: 'calc_check', traceId: 'trace-calc-1' },
      { tenantKey: 's:default', reason: 'calc_unverified', sourceChunkIds: ['c1'], documentIds: ['d1'], detector: 'calc_check', traceId: 'trace-calc-1' },
    ]);
  });

  it('a ghost chat or a turn without reasons enqueues nothing', () => {
    const enqueue = vi.fn(async () => null);
    const schedule = vi.fn();
    expect(scheduleCalcReviewEnqueue({ ...base, reasons: ['calc_unverified'], ghost: true }, { enqueue, schedule })).toBe(false);
    expect(scheduleCalcReviewEnqueue({ ...base, reasons: [], ghost: false }, { enqueue, schedule })).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
