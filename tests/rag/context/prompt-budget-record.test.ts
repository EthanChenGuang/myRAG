import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsertAnswerRecordInput } from '@/lib/answers/store';
import { AnswerChecksSchema } from '@/lib/rag-eval/contracts.generated';
import { mintAnswerId, scheduleAnswerFinish, type AnswerFinishDeps, type AnswerFinishInput } from '@/lib/rag/generation/answer-finish';
import { mintScope } from '@/lib/rag/tenant/scope';

const SUMMARY = {
  parts: { system: 900, rules: 40, tools: 120, history: 300, question: 12, documents: 2000, reserve: 4096 },
  window: 20000,
  dropped_documents: 1,
  dropped_history_turns: 2,
  near_limit: false,
  status: 'ok' as const,
};

function finishInput(overrides: Partial<AnswerFinishInput> = {}): AnswerFinishInput {
  return {
    answerId: mintAnswerId(),
    scope: mintScope('single', null, null),
    userId: '00000000-0000-4000-8000-0000000000b2',
    chatId: null,
    traceId: 'trace-pb-1',
    modelId: 'test/model',
    ragMode: 'strict',
    queryText: 'A neutral question.',
    citations: [],
    citationStrategy: null,
    invalidCitations: 0,
    answerText: 'A neutral answer.',
    aborted: false,
    groundednessEligible: false,
    toolOutputUsed: false,
    premise: { blocks: [], webSearchTexts: [] },
    requestLanguage: 'en',
    ...overrides,
  };
}

function harness() {
  const inserts: InsertAnswerRecordInput[] = [];
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
  };
  return {
    inserts,
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

describe('answer record: prompt budget summary (D-86)', () => {
  it('stores the summary as checks.prompt_budget next to the other checks', async () => {
    const h = harness();
    scheduleAnswerFinish(finishInput({ checks: { truncated: false, finish_reason: 'stop' }, promptBudget: SUMMARY }), h.deps);
    await h.run();
    const checks = h.inserts[0]!.checks;
    expect(checks?.prompt_budget).toEqual(SUMMARY);
    expect(checks?.finish_reason).toBe('stop');
    expect(AnswerChecksSchema.safeParse(checks).success).toBe(true);
  });

  it('a summary alone still writes checks', async () => {
    const h = harness();
    scheduleAnswerFinish(finishInput({ promptBudget: SUMMARY }), h.deps);
    await h.run();
    expect(h.inserts[0]!.checks?.prompt_budget).toEqual(SUMMARY);
  });

  it('without a summary the checks are as before', async () => {
    const h = harness();
    scheduleAnswerFinish(finishInput({ checks: { truncated: false, finish_reason: 'stop' } }), h.deps);
    await h.run();
    expect(h.inserts[0]!.checks).not.toHaveProperty('prompt_budget');
    scheduleAnswerFinish(finishInput(), h.deps);
    await h.run();
    expect(h.inserts[1]!.checks ?? null).toBeNull();
  });
});
