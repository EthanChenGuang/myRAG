import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordSourceOpened, setRefusalVote, SOURCE_OPENED_CAP } from '@/lib/rag/feedback-loop/votes';
import { RefusalFeedbackRequestSchema } from '@/lib/rag-eval/contracts.generated';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TRACE_REFUSED = 'a'.repeat(32);
const TRACE_UNAVAILABLE = 'b'.repeat(32);
const TRACE_ANSWERED = 'c'.repeat(32);
const TRACE_FOREIGN = 'd'.repeat(32);
const NOW = new Date('2026-11-25T10:00:00.000Z');

interface Row {
  trace_id: string;
  user_id: string;
  outcome: string;
  feedback_vote: number | null;
  feedback_kind: string | null;
  feedback_reasons: string[];
  feedback_at: string | null;
  source_opened_count: number;
}

type Filter = { op: 'eq' | 'in'; column: string; value: unknown };

interface FakeDb {
  client: SupabaseClient;
  rows: Row[];
  updates: Array<{ table: string; values: Record<string, unknown>; filters: Filter[] }>;
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
  fail: boolean;
}

function row(trace: string, user: string, outcome: string): Row {
  return { trace_id: trace, user_id: user, outcome, feedback_vote: null, feedback_kind: null, feedback_reasons: [], feedback_at: null, source_opened_count: 0 };
}

/** An in-memory rag_retrieval_log that applies the recorded filters, and an rpc that mirrors rag_record_source_opened. */
function fakeDb(): FakeDb {
  const db: FakeDb = {
    client: null as unknown as SupabaseClient,
    rows: [
      row(TRACE_REFUSED, OWNER, 'refused_no_context'),
      row(TRACE_UNAVAILABLE, OWNER, 'kb_unavailable'),
      row(TRACE_ANSWERED, OWNER, 'answered'),
      row(TRACE_FOREIGN, OTHER, 'refused_no_context'),
    ],
    updates: [],
    rpcs: [],
    fail: false,
  };
  const matches = (target: Row, filters: Filter[]) =>
    filters.every((filter) => {
      const value = (target as unknown as Record<string, unknown>)[filter.column];
      return filter.op === 'eq' ? value === filter.value : (filter.value as unknown[]).includes(value);
    });
  db.client = {
    from(table: string) {
      const filters: Filter[] = [];
      let values: Record<string, unknown> = {};
      const run = () => {
        db.updates.push({ table, values, filters });
        if (db.fail) return { data: null, error: { code: 'XX000', message: 'boom' } };
        const hit = db.rows.filter((target) => matches(target, filters));
        for (const target of hit) Object.assign(target, values);
        return { data: hit.map((target) => ({ trace_id: target.trace_id })), error: null };
      };
      const builder: Record<string, unknown> = {
        update(next: Record<string, unknown>) {
          values = next;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ op: 'eq', column, value });
          return builder;
        },
        in(column: string, value: unknown[]) {
          filters.push({ op: 'in', column, value });
          return builder;
        },
        select() {
          return builder;
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve().then(run).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      db.rpcs.push({ name, args });
      if (db.fail) return Promise.resolve({ data: null, error: { code: 'XX000', message: 'boom' } });
      const target = db.rows.find((candidate) => candidate.trace_id === args.p_trace_id && candidate.user_id === args.p_user_id);
      if (!target) return Promise.resolve({ data: null, error: null });
      if (target.source_opened_count < 20) target.source_opened_count += 1;
      return Promise.resolve({ data: target.source_opened_count, error: null });
    },
  } as unknown as SupabaseClient;
  return db;
}

let db: FakeDb;
const deps = () => ({ admin: () => db.client, now: () => NOW });

beforeEach(() => {
  db = fakeDb();
});

describe('setRefusalVote (D-08)', () => {
  it('stores -1, kind refusal, the reasons and the time on the caller refusal row with trace, user and outcome filters', async () => {
    const result = await setRefusalVote({
      traceId: TRACE_REFUSED,
      userId: OWNER,
      request: { vote: 'expected_answer', reasons: ['answer_exists', 'wrong_language'] },
      deps: deps(),
    });

    expect(result).toEqual({ found: true, vote: 'expected_answer', reasons: ['answer_exists', 'wrong_language'], at: NOW.toISOString() });
    expect(db.updates).toHaveLength(1);
    const [update] = db.updates;
    expect(update!.table).toBe('rag_retrieval_log');
    expect(update!.values).toEqual({
      feedback_vote: -1,
      feedback_kind: 'refusal',
      feedback_reasons: ['answer_exists', 'wrong_language'],
      feedback_at: NOW.toISOString(),
    });
    expect(update!.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'trace_id', value: TRACE_REFUSED },
        { op: 'eq', column: 'user_id', value: OWNER },
        { op: 'in', column: 'outcome', value: ['refused_no_context', 'kb_unavailable'] },
      ]),
    );
    expect(db.rows[0]).toMatchObject({ feedback_vote: -1, feedback_kind: 'refusal' });
  });

  it('stores +1 for correct_refusal and keeps no reason chips', async () => {
    const result = await setRefusalVote({
      traceId: TRACE_UNAVAILABLE,
      userId: OWNER,
      request: { vote: 'correct_refusal', reasons: ['other'] },
      deps: deps(),
    });
    expect(result).toEqual({ found: true, vote: 'correct_refusal', reasons: [], at: NOW.toISOString() });
    expect(db.rows[1]).toMatchObject({ feedback_vote: 1, feedback_kind: 'refusal', feedback_reasons: [] });
  });

  it('a second vote replaces the first (latest wins)', async () => {
    await setRefusalVote({ traceId: TRACE_REFUSED, userId: OWNER, request: { vote: 'expected_answer', reasons: ['other'] }, deps: deps() });
    const second = await setRefusalVote({ traceId: TRACE_REFUSED, userId: OWNER, request: { vote: 'correct_refusal' }, deps: deps() });
    expect(second.found).toBe(true);
    expect(db.rows[0]).toMatchObject({ feedback_vote: 1, feedback_reasons: [] });
    expect(db.updates).toHaveLength(2);
  });

  it.each([
    { name: 'another user row', traceId: TRACE_FOREIGN },
    { name: 'an answered row', traceId: TRACE_ANSWERED },
    { name: 'an unknown trace', traceId: 'e'.repeat(32) },
  ])('returns found false for $name and changes nothing', async ({ traceId }) => {
    const result = await setRefusalVote({ traceId, userId: OWNER, request: { vote: 'expected_answer' }, deps: deps() });
    expect(result).toEqual({ found: false });
    expect(db.rows.every((target) => target.feedback_vote === null)).toBe(true);
  });

  it.each(['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), '11111111-1111-4111-8111-111111111111', '', 'g'.repeat(32), `${'a'.repeat(32)}\n`])(
    'an invalid trace id %j never reaches the database',
    async (traceId) => {
      const result = await setRefusalVote({ traceId, userId: OWNER, request: { vote: 'expected_answer' }, deps: deps() });
      expect(result).toEqual({ found: false });
      expect(db.updates).toHaveLength(0);
    },
  );

  it('an invalid user id never reaches the database', async () => {
    const result = await setRefusalVote({ traceId: TRACE_REFUSED, userId: 'not-a-uuid', request: { vote: 'expected_answer' }, deps: deps() });
    expect(result).toEqual({ found: false });
    expect(db.updates).toHaveLength(0);
  });

  it('a database error is unavailable, not found', async () => {
    db.fail = true;
    const result = await setRefusalVote({ traceId: TRACE_REFUSED, userId: OWNER, request: { vote: 'expected_answer' }, deps: deps() });
    expect(result).toEqual({ found: false, unavailable: true });
  });

  it('no admin client is unavailable', async () => {
    const result = await setRefusalVote({
      traceId: TRACE_REFUSED,
      userId: OWNER,
      request: { vote: 'expected_answer' },
      deps: { admin: () => null, now: () => NOW },
    });
    expect(result).toEqual({ found: false, unavailable: true });
  });

  it('the schema rejects reasons outside the chip set and any extra field before the call', () => {
    expect(RefusalFeedbackRequestSchema.safeParse({ vote: 'expected_answer', reasons: ['wrong'] }).success).toBe(false);
    expect(RefusalFeedbackRequestSchema.safeParse({ vote: 'expected_answer', query: 'synthetic question' }).success).toBe(false);
    expect(RefusalFeedbackRequestSchema.safeParse({ vote: 'expected_answer', comment: 'free text' }).success).toBe(false);
    expect(RefusalFeedbackRequestSchema.safeParse({ vote: 'expected_answer', reasons: ['other'] }).success).toBe(true);
  });
});

describe('recordSourceOpened (D-12)', () => {
  it('increments the caller row through one rpc call with the trace and user', async () => {
    const result = await recordSourceOpened({ traceId: TRACE_ANSWERED, userId: OWNER, deps: deps() });
    expect(result).toEqual({ found: true, count: 1 });
    expect(db.rpcs).toEqual([{ name: 'rag_record_source_opened', args: { p_trace_id: TRACE_ANSWERED, p_user_id: OWNER } }]);
    expect(db.updates).toHaveLength(0);
  });

  it(`never exceeds ${SOURCE_OPENED_CAP} and still reports the owner row as found at the cap`, async () => {
    for (let i = 0; i < SOURCE_OPENED_CAP + 5; i += 1) {
      const result = await recordSourceOpened({ traceId: TRACE_ANSWERED, userId: OWNER, deps: deps() });
      expect(result.found).toBe(true);
    }
    expect(db.rows[2]!.source_opened_count).toBe(SOURCE_OPENED_CAP);
  });

  it('returns found false for another user row', async () => {
    const result = await recordSourceOpened({ traceId: TRACE_FOREIGN, userId: OWNER, deps: deps() });
    expect(result).toEqual({ found: false });
    expect(db.rows[3]!.source_opened_count).toBe(0);
  });

  it.each(['A'.repeat(32), 'a'.repeat(31), '', 'z'.repeat(32)])('an invalid trace id %j never reaches the database', async (traceId) => {
    expect(await recordSourceOpened({ traceId, userId: OWNER, deps: deps() })).toEqual({ found: false });
    expect(db.rpcs).toHaveLength(0);
  });

  it('a database error is unavailable', async () => {
    db.fail = true;
    expect(await recordSourceOpened({ traceId: TRACE_ANSWERED, userId: OWNER, deps: deps() })).toEqual({ found: false, unavailable: true });
  });
});
