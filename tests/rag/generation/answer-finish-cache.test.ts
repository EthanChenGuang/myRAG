import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InsertAnswerRecordInput } from '@/lib/answers/store';
import {
  createGroundednessStep,
  mintAnswerId,
  scheduleAnswerFinish,
  type AnswerFinishDeps,
  type AnswerFinishInput,
} from '@/lib/rag/generation/answer-finish';
import type { AnswerGroundedness } from '@/lib/rag/generation/groundedness';
import { mintScope } from '@/lib/rag/tenant/scope';

const USER = '00000000-0000-4000-8000-0000000036a1';

const SCORED: AnswerGroundedness = {
  status: 'scored',
  label: 'verified',
  scorer: 'hhem_2_1_open',
  score: 0.93,
  threshold: 0.5,
  thresholdSource: 'default',
  reason: null,
  truncated: false,
  latencyMs: 30,
  checkedAt: '2026-11-25T00:00:01.000Z',
};

function fakeAdmin(): SupabaseClient {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return { from: () => builder } as unknown as SupabaseClient;
}

function harness(options: { groundedness?: boolean; insertError?: boolean; onPending?: AnswerFinishDeps['onPending'] } = {}) {
  const inserts: InsertAnswerRecordInput[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const pending = vi.fn(options.onPending ?? (async () => SCORED));
  const deps: Partial<AnswerFinishDeps> = {
    admin: () => fakeAdmin(),
    insert: async (_admin, row) => {
      if (options.insertError) throw new Error('insert failed (23503)');
      inserts.push(row);
      return { inserted: true };
    },
    schedule: (task) => {
      tasks.push(task);
    },
    readConfig: () => ({ groundedness: options.groundedness === true }),
    onPending: pending,
  };
  return {
    deps,
    inserts,
    pending,
    async run() {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

function input(overrides: Partial<AnswerFinishInput> = {}): AnswerFinishInput {
  return {
    answerId: mintAnswerId(),
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: 'trace-36',
    modelId: 'test/model',
    ragMode: 'strict',
    queryText: 'What does the placeholder section describe?',
    citations: [],
    citationStrategy: null,
    invalidCitations: 0,
    answerText: 'A neutral placeholder answer.',
    aborted: false,
    groundednessEligible: true,
    toolOutputUsed: false,
    premise: { blocks: [{ alias: 'S1', text: 'A neutral placeholder sentence.' }], webSearchTexts: [] },
    requestLanguage: 'en',
    ...overrides,
  };
}

describe('scheduleAnswerFinish groundedness handle (06-36, D-33)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('settles with the scored groundedness once the scoring step has run', async () => {
    const h = harness({ groundedness: true });
    const handle = scheduleAnswerFinish(input(), h.deps);
    await h.run();
    await expect(handle).resolves.toEqual(SCORED);
  });

  it('settles with the inserted not_checked value when no scoring runs', async () => {
    const h = harness({ groundedness: false });
    const handle = scheduleAnswerFinish(input(), h.deps);
    await h.run();
    await expect(handle).resolves.toMatchObject({ status: 'not_checked', label: 'not_checked', reason: 'disabled' });
    expect(h.pending).not.toHaveBeenCalled();
  });

  it('settles with null on an insert failure or a second call for the same answerId, and never rejects', async () => {
    const failed = harness({ groundedness: true, insertError: true });
    const handle = scheduleAnswerFinish(input(), failed.deps);
    await failed.run();
    await expect(handle).resolves.toBeNull();

    const twice = harness({ groundedness: true });
    const answer = input();
    scheduleAnswerFinish(answer, twice.deps);
    const second = scheduleAnswerFinish(answer, twice.deps);
    await twice.run();
    await expect(second).resolves.toBeNull();
  });

  it('a cache hit inserts the cached groundedness object unchanged and runs no scoring', async () => {
    const h = harness({ groundedness: true });
    const handle = scheduleAnswerFinish(input({ groundedness: SCORED, groundednessEligible: false }), h.deps);
    await h.run();
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].groundedness).toEqual(SCORED);
    expect(h.pending).not.toHaveBeenCalled();
    await expect(handle).resolves.toEqual(SCORED);
  });

  it('createGroundednessStep returns the label it scored', async () => {
    const step = createGroundednessStep({
      readConfig: () => ({ vectaraOptIn: false, vectaraMultiTenantAck: false, maxPremiseTokens: 2000, groundednessTimeoutMs: 1000 }),
      multiTenant: () => false,
      request: vi.fn(async () => {
        throw new Error('sidecar down');
      }),
      update: async () => true,
      langfuse: () => ({ enabled: false }) as never,
      now: () => new Date('2026-11-25T00:00:00.000Z'),
    });
    const result = await step({ answerId: mintAnswerId(), input: input(), admin: fakeAdmin() });
    expect(result).toMatchObject({ status: 'not_checked' });
  });
});
