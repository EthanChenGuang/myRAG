import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { mirrorVoteToRetrievalLog, submitAnswerFeedback, type SubmitAnswerFeedbackDeps } from '@/lib/rag/generation/feedback';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import type { LangfuseScoreInput } from '@/lib/rag/trace/scores';
import { adminClient, newAnswerDb, sessionClient, type AnswerDbState, type Row } from '../../helpers/answer-db-fake';

const USER_A = '00000000-0000-4000-8000-0000000025a1';
const USER_B = '00000000-0000-4000-8000-0000000025b1';
const ORG = '00000000-0000-4000-8000-0000000025d1';
const TRACE = 'c'.repeat(32);
const NOW = new Date('2026-11-25T12:00:00.000Z');

function langfuse(): LangfuseConfig {
  return {
    enabled: true,
    publicKey: 'pk-lf-placeholder',
    secretKey: 'sk-lf-placeholder',
    baseUrl: 'http://127.0.0.1:1',
    sampleRate: 0,
    reviewSampleRate: 0,
    captureContent: false,
  };
}

function record(over: Row = {}): Row {
  const at = new Date(NOW.getTime() - 60_000).toISOString();
  return {
    id: crypto.randomUUID(),
    user_id: USER_A,
    organization_id: null,
    chat_id: null,
    trace_id: TRACE,
    model_id: 'placeholder/model',
    citation_strategy: 'chunk-alias',
    rag_mode: 'strict',
    answer_language: 'en',
    invalid_citations: 0,
    citations: [],
    groundedness: null,
    feedback: null,
    review_reasons: [],
    created_at: at,
    updated_at: at,
    ...over,
  };
}

function logRow(over: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    trace_id: TRACE,
    tenant_key: 's:default',
    feedback_vote: null,
    feedback_kind: null,
    feedback_reasons: [],
    feedback_at: null,
    ...over,
  };
}

interface Harness {
  db: AnswerDbState;
  tasks: Array<() => Promise<void>>;
  scores: LangfuseScoreInput[][];
  deps: Partial<SubmitAnswerFeedbackDeps>;
  run(): Promise<void>;
}

function harness(overrides: Partial<SubmitAnswerFeedbackDeps> = {}, admin?: (db: AnswerDbState) => SupabaseClient): Harness {
  const db = newAnswerDb();
  db.session = { id: USER_A };
  db.tables.rag_retrieval_log = [];
  const tasks: Array<() => Promise<void>> = [];
  const scores: LangfuseScoreInput[][] = [];
  const deps: Partial<SubmitAnswerFeedbackDeps> = {
    admin: () => (admin ? admin(db) : adminClient(db)),
    schedule: (task) => {
      tasks.push(task);
    },
    now: () => NOW,
    langfuse: () => langfuse(),
    multiTenant: () => false,
    retrievalLogEnabled: () => true,
    postScores: async (batch) => {
      scores.push([...batch]);
      return { status: 'accepted', httpStatus: 202 };
    },
    exportReview: async () => 'exported',
    langfuseTimeoutMs: 100,
    ...overrides,
  } as Partial<SubmitAnswerFeedbackDeps>;
  return {
    db,
    tasks,
    scores,
    deps,
    async run() {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

function submit(h: Harness, answerId: string, request: Record<string, unknown>, userId = USER_A) {
  return submitAnswerFeedback({
    answerId,
    userId,
    request: { chatId: null, comment: null, reasons: [], ...request } as never,
    session: sessionClient(h.db),
    deps: h.deps,
  });
}

function captureConsole(): string[] {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(capture);
  return lines;
}

function logUpdates(db: AnswerDbState) {
  return db.queries.filter((q) => q.table === 'rag_retrieval_log' && q.op === 'update');
}

/** The answer-db fake, except that every rag_retrieval_log query fails in the given way. */
function failingLogAdmin(mode: 'error' | 'throw' | 'hang') {
  return (db: AnswerDbState): SupabaseClient => {
    const base = adminClient(db) as unknown as { from: (table: string) => unknown };
    return {
      ...base,
      from(table: string) {
        if (table !== 'rag_retrieval_log') return base.from(table);
        if (mode === 'throw') throw new Error('synthetic failure');
        const b: Record<string, unknown> = {};
        for (const name of ['update', 'eq', 'select', 'abortSignal']) b[name] = () => b;
        b.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          (mode === 'hang' ? new Promise(() => undefined) : Promise.resolve({ data: null, error: { code: '42P01' } })).then(onFulfilled, onRejected);
        return b;
      },
    } as unknown as SupabaseClient;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mirror of the Phase 5 answer vote onto rag_retrieval_log (D-10)', () => {
  it('copies a helpful vote as feedback_vote 1, kind answer, no reasons, after the record write', async () => {
    const h = harness();
    const row = record();
    const log = logRow();
    h.db.tables.rag_answer_records.push(row);
    h.db.tables.rag_retrieval_log.push(log);

    const result = await submit(h, String(row.id), { vote: 'helpful' });
    expect(result).toEqual({ ok: true, feedback: { vote: 'helpful', reasons: [], comment: null, updatedAt: NOW.toISOString() } });
    expect(log.feedback_vote).toBe(null);
    expect(logUpdates(h.db)).toHaveLength(0);

    await h.run();
    expect(log).toMatchObject({ feedback_vote: 1, feedback_kind: 'answer', feedback_reasons: [], feedback_at: NOW.toISOString() });
    expect(h.scores).toHaveLength(1);
  });

  it('copies a not_helpful vote as -1 with its reasons, and a later vote replaces it', async () => {
    const h = harness();
    const row = record();
    const log = logRow();
    h.db.tables.rag_answer_records.push(row);
    h.db.tables.rag_retrieval_log.push(log);

    await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong', 'incomplete'], comment: 'The sample text is off.' });
    await h.run();
    expect(log).toMatchObject({ feedback_vote: -1, feedback_kind: 'answer', feedback_reasons: ['wrong', 'incomplete'] });
    expect(JSON.stringify(log)).not.toContain('The sample text is off.');

    await submit(h, String(row.id), { vote: 'helpful' });
    await h.run();
    expect(log).toMatchObject({ feedback_vote: 1, feedback_kind: 'answer', feedback_reasons: [] });
  });

  it("filters by trace_id and the record's tenant_key: another tenant's row with the same trace_id is not touched", async () => {
    const h = harness({ multiTenant: () => true });
    const row = record({ organization_id: ORG });
    const own = logRow({ tenant_key: `o:${ORG}` });
    const personal = logRow({ tenant_key: `u:${USER_A}` });
    const foreign = logRow({ tenant_key: `u:${USER_B}` });
    h.db.tables.rag_answer_records.push(row);
    h.db.tables.rag_retrieval_log.push(own, personal, foreign);

    await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong'] });
    await h.run();

    expect(own).toMatchObject({ feedback_vote: -1, feedback_kind: 'answer', feedback_reasons: ['wrong'] });
    for (const untouched of [personal, foreign]) {
      expect(untouched).toMatchObject({ feedback_vote: null, feedback_kind: null, feedback_reasons: [], feedback_at: null });
    }
    const [update] = logUpdates(h.db);
    expect(update.client).toBe('admin');
    expect(update.filters).toEqual(
      expect.arrayContaining([
        ['eq', 'trace_id', TRACE],
        ['eq', 'tenant_key', `o:${ORG}`],
      ]),
    );
  });

  it('uses the personal tenant key u:<user_id> for a personal record in multi-tenant mode', async () => {
    const h = harness({ multiTenant: () => true });
    const row = record();
    const personal = logRow({ tenant_key: `u:${USER_A}` });
    const org = logRow({ tenant_key: `o:${ORG}` });
    h.db.tables.rag_answer_records.push(row);
    h.db.tables.rag_retrieval_log.push(personal, org);

    await submit(h, String(row.id), { vote: 'helpful' });
    await h.run();
    expect(personal.feedback_vote).toBe(1);
    expect(org.feedback_vote).toBe(null);
  });

  it('with no matching log row is a no-op: no error, no [Feedback Loop] line, response unchanged', async () => {
    const lines = captureConsole();
    const h = harness();
    const row = record();
    h.db.tables.rag_answer_records.push(row);

    const result = await submit(h, String(row.id), { vote: 'helpful' });
    await h.run();
    expect(result.ok).toBe(true);
    expect(logUpdates(h.db)).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith('[Feedback Loop]'))).toHaveLength(0);
    expect(h.scores).toHaveLength(1);
  });

  it('with no trace_id on the record does not touch the log', async () => {
    const h = harness();
    const row = record({ trace_id: null });
    const log = logRow();
    h.db.tables.rag_answer_records.push(row);
    h.db.tables.rag_retrieval_log.push(log);

    await submit(h, String(row.id), { vote: 'helpful' });
    await h.run();
    expect(logUpdates(h.db)).toHaveLength(0);
    expect(log.feedback_vote).toBe(null);
  });

  it('with the retrieval log off sends no log query (Phase 5 behaviour unchanged)', async () => {
    const h = harness({ retrievalLogEnabled: () => false } as Partial<SubmitAnswerFeedbackDeps>);
    const row = record();
    const log = logRow();
    h.db.tables.rag_answer_records.push(row);
    h.db.tables.rag_retrieval_log.push(log);

    await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong'] });
    await h.run();
    expect(h.db.queries.filter((q) => q.table === 'rag_retrieval_log')).toHaveLength(0);
    expect(log.feedback_vote).toBe(null);
    expect(h.scores).toHaveLength(1);
  });

  for (const mode of ['error', 'throw', 'hang'] as const) {
    it(`a mirror failure (${mode}) logs one codes-only [Feedback Loop] line and changes neither the vote nor Langfuse`, async () => {
      const lines = captureConsole();
      const h = harness({}, failingLogAdmin(mode));
      const row = record();
      h.db.tables.rag_answer_records.push(row);

      const result = await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong'], comment: 'Neutral sample comment.' });
      expect(result).toEqual({ ok: true, feedback: { vote: 'not_helpful', reasons: ['wrong'], comment: 'Neutral sample comment.', updatedAt: NOW.toISOString() } });
      expect((row.feedback as Row).vote).toBe('not_helpful');

      const started = Date.now();
      await h.run();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(h.scores).toHaveLength(1);
      expect(h.scores[0][0]).toMatchObject({ traceId: TRACE, name: 'user_feedback', value: 0 });
      const mirrorLines = lines.filter((line) => line.startsWith('[Feedback Loop]'));
      expect(mirrorLines).toHaveLength(1);
      expect(mirrorLines[0]).not.toContain(TRACE);
      expect(mirrorLines[0]).not.toContain('synthetic failure');
      expect(lines.join('\n')).not.toContain('Neutral sample comment.');
      expect(lines.filter((line) => line.startsWith('[RAG Feedback]'))).toHaveLength(0);
    });
  }
});

describe('mirrorVoteToRetrievalLog', () => {
  it('never throws and resolves for an invalid tenant key without a query', async () => {
    const db = newAnswerDb();
    db.tables.rag_retrieval_log = [logRow()];
    await expect(
      mirrorVoteToRetrievalLog(TRACE, 'helpful', [], { client: adminClient(db), tenantKey: 'none', at: NOW.toISOString() }),
    ).resolves.toBeUndefined();
    expect(db.queries).toHaveLength(0);
  });

  it('updates the row with that trace_id and tenant_key only', async () => {
    const db = newAnswerDb();
    const own = logRow();
    const other = logRow({ trace_id: 'd'.repeat(32) });
    db.tables.rag_retrieval_log = [own, other];
    await mirrorVoteToRetrievalLog(TRACE, 'not_helpful', ['incomplete'], { client: adminClient(db), tenantKey: 's:default', at: NOW.toISOString() });
    expect(own).toMatchObject({ feedback_vote: -1, feedback_kind: 'answer', feedback_reasons: ['incomplete'], feedback_at: NOW.toISOString() });
    expect(other.feedback_vote).toBe(null);
  });
});
