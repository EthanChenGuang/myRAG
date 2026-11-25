import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerRecordSchema } from '@/lib/rag-eval/contracts.generated';
import { submitAnswerFeedback, type SubmitAnswerFeedbackDeps } from '@/lib/rag/generation/feedback';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { GroundednessResult } from '@/lib/rag-eval/contracts.generated';
import { createGroundednessStep, mintAnswerId, scheduleAnswerFinish, type AnswerFinishInput, type GroundednessStepDeps } from '@/lib/rag/generation/answer-finish';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import type { CollectedTrace } from '@/lib/rag/trace/langfuse';
import { exportReviewCandidate, type ReviewCandidateInput } from '@/lib/rag/trace/review-export';
import { postLangfuseScores, scoreId, type LangfuseScoreInput } from '@/lib/rag/trace/scores';
import { adminClient, newAnswerDb, sessionClient, type AnswerDbState, type Row } from '../../helpers/answer-db-fake';

const USER_A = '00000000-0000-4000-8000-0000000021a1';
const USER_B = '00000000-0000-4000-8000-0000000021b1';
const ORG = '00000000-0000-4000-8000-0000000021d1';
const TRACE = 'a'.repeat(32);
const NOW = new Date('2026-11-25T12:00:00.000Z');
const QUESTION = 'How many leave days do new employees get?';
const ANSWER = 'New employees get twenty days of leave [S1].';
const QUOTE = 'Employees receive twenty days of annual leave.';
const COMMENT = 'Wrong number, write to jane.doe@example.com';

function langfuse(overrides: Partial<LangfuseConfig> = {}): LangfuseConfig {
  return {
    enabled: true,
    publicKey: 'pk-lf-placeholder',
    secretKey: 'sk-lf-placeholder',
    baseUrl: 'http://127.0.0.1:1',
    sampleRate: 0,
    reviewSampleRate: 0,
    captureContent: false,
    ...overrides,
  };
}

function record(over: Row = {}): Row {
  const now = new Date(NOW.getTime() - 60_000).toISOString();
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
    citations: [
      {
        n: 1,
        alias: 'S1',
        chunkIds: ['c1'],
        documentId: 'd1',
        documentName: 'handbook.md',
        documentVersion: 1,
        page: 2,
        sectionPath: null,
        quote: QUOTE,
        quoteHash: 'b'.repeat(64),
        strategy: 'chunk-alias',
      },
    ],
    groundedness: { status: 'scored', label: 'verified', truncated: false },
    feedback: null,
    review_reasons: [],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function chat(answerId: string, over: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    user_id: USER_A,
    organization_id: null,
    messages: [
      { role: 'user', content: 'An earlier question' },
      { role: 'assistant', content: 'An earlier answer', metadata: { answerId: crypto.randomUUID() } },
      { role: 'user', content: QUESTION },
      { role: 'assistant', parts: [{ type: 'text', text: ANSWER }], metadata: { answerId } },
    ],
    ...over,
  };
}

interface Harness {
  db: AnswerDbState;
  tasks: Array<() => Promise<void>>;
  scores: LangfuseScoreInput[][];
  reviews: ReviewCandidateInput[];
  deps: Partial<SubmitAnswerFeedbackDeps>;
  run(): Promise<void>;
}

function harness(overrides: Partial<SubmitAnswerFeedbackDeps> = {}): Harness {
  const db = newAnswerDb();
  db.session = { id: USER_A };
  const tasks: Array<() => Promise<void>> = [];
  const scores: LangfuseScoreInput[][] = [];
  const reviews: ReviewCandidateInput[] = [];
  const deps: Partial<SubmitAnswerFeedbackDeps> = {
    admin: () => adminClient(db),
    schedule: (task) => {
      tasks.push(task);
    },
    now: () => NOW,
    langfuse: () => langfuse(),
    multiTenant: () => false,
    postScores: async (batch) => {
      scores.push([...batch]);
      return { status: 'accepted', httpStatus: 202 };
    },
    exportReview: async (input) => {
      reviews.push(input);
      return 'exported';
    },
    langfuseTimeoutMs: 100,
    ...overrides,
  };
  return {
    db,
    tasks,
    scores,
    reviews,
    deps,
    async run() {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

function captureConsole(): string[] {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(capture);
  return lines;
}

function submit(h: Harness, answerId: string, request: Record<string, unknown>) {
  return submitAnswerFeedback({
    answerId,
    userId: USER_A,
    request: { chatId: null, comment: null, reasons: [], ...request } as never,
    session: sessionClient(h.db),
    deps: h.deps,
  });
}

const FeedbackSchema = AnswerRecordSchema.shape.feedback;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('submitAnswerFeedback', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('stores a helpful vote with no reasons and no comment, then lets a later not_helpful vote replace it', async () => {
    const row = record();
    h.db.tables.rag_answer_records.push(row);
    const first = await submit(h, String(row.id), { vote: 'helpful', reasons: ['wrong'], comment: 'ignored' });
    expect(first).toEqual({ ok: true, feedback: { vote: 'helpful', reasons: [], comment: null, updatedAt: NOW.toISOString() } });
    expect(row.feedback).toEqual({ vote: 'helpful', reasons: [], comment: null, updatedAt: NOW.toISOString() });
    expect(FeedbackSchema.parse(row.feedback)).toEqual(row.feedback);

    const second = await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong', 'bad_citation'], comment: COMMENT });
    expect(second.ok).toBe(true);
    expect(row.feedback).toEqual({ vote: 'not_helpful', reasons: ['wrong', 'bad_citation'], comment: COMMENT, updatedAt: NOW.toISOString() });
  });

  it("answers not_found for another user's record and a missing one, and writes nothing", async () => {
    const foreign = record({ user_id: USER_B });
    h.db.tables.rag_answer_records.push(foreign);
    expect(await submit(h, String(foreign.id), { vote: 'not_helpful' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await submit(h, crypto.randomUUID(), { vote: 'helpful' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await submit(h, 'not-a-uuid', { vote: 'helpful' })).toEqual({ ok: false, reason: 'not_found' });
    expect(foreign.feedback).toBe(null);
    expect(foreign.review_reasons).toEqual([]);
    expect(h.db.queries.filter((q) => q.op === 'update')).toHaveLength(0);
    expect(h.tasks).toHaveLength(0);
  });

  it('writes the vote before any Langfuse call; Langfuse runs only in the scheduled task', async () => {
    const row = record();
    h.db.tables.rag_answer_records.push(row);
    await submit(h, String(row.id), { vote: 'helpful' });
    expect(row.feedback).not.toBe(null);
    expect(h.scores).toHaveLength(0);
    expect(h.tasks).toHaveLength(1);
    await h.run();
    expect(h.scores).toHaveLength(1);
  });

  it('posts user_feedback 1 or 0 on the traceId with the deterministic id and a masked comment carrying the chips', async () => {
    const bodies: unknown[] = [];
    const fetchFake = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });
    h = harness({ postScores: (batch, options) => postLangfuseScores(batch, { ...options, fetch: fetchFake as unknown as typeof fetch }) });
    const row = record();
    h.db.tables.rag_answer_records.push(row);
    await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong', 'bad_citation'], comment: COMMENT });
    await h.run();
    await submit(h, String(row.id), { vote: 'helpful' });
    await h.run();
    expect(bodies).toHaveLength(2);
    const [negative] = bodies[0] as Array<Record<string, unknown>>;
    const [positive] = bodies[1] as Array<Record<string, unknown>>;
    expect(negative).toMatchObject({ id: scoreId(TRACE, 'user_feedback'), traceId: TRACE, name: 'user_feedback', value: 0 });
    expect(positive).toMatchObject({ id: scoreId(TRACE, 'user_feedback'), traceId: TRACE, name: 'user_feedback', value: 1 });
    expect(String(negative.comment)).toContain('wrong, bad_citation');
    expect(String(negative.comment)).toContain('[EMAIL]');
    expect(JSON.stringify(bodies)).not.toContain('jane.doe@example.com');
    expect(positive.comment).toBeUndefined();
  });

  it('with Langfuse off logs one [RAG Feedback] line with the answerId, the vote and the reason count, and no comment text', async () => {
    const lines = captureConsole();
    h = harness({ langfuse: () => langfuse({ enabled: false }), postScores: postLangfuseScores });
    const row = record();
    h.db.tables.rag_answer_records.push(row);
    await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong', 'incomplete'], comment: COMMENT });
    await h.run();
    const feedbackLines = lines.filter((line) => line.startsWith('[RAG Feedback]'));
    expect(feedbackLines).toHaveLength(1);
    const payload = JSON.parse(feedbackLines[0].slice(feedbackLines[0].indexOf('{'))) as Record<string, unknown>;
    expect(payload).toMatchObject({ answerId: row.id, vote: 'not_helpful', reasons: 2 });
    const all = lines.join('\n');
    expect(all).not.toContain('Wrong number');
    expect(all).not.toContain('jane.doe');
    expect(all).not.toContain(QUESTION);
    expect(all).not.toContain(ANSWER);
  });

  it('keeps the vote and logs the fallback when the Langfuse call hangs past the time box', async () => {
    const lines = captureConsole();
    h = harness({ postScores: () => new Promise(() => undefined), exportReview: () => new Promise(() => undefined), langfuseTimeoutMs: 30 });
    const row = record();
    h.db.tables.rag_answer_records.push(row);
    const result = await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong'] });
    expect(result.ok).toBe(true);
    expect((row.feedback as Row).vote).toBe('not_helpful');
    const started = Date.now();
    await h.run();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(lines.filter((line) => line.startsWith('[RAG Feedback]'))).toHaveLength(1);
  });

  it('appends feedback_negative once and exports the review copy with the query and answer of the caller chat row', async () => {
    const row = record({ organization_id: ORG });
    const owned = chat(String(row.id), { organization_id: ORG });
    row.chat_id = owned.id;
    h = harness({ multiTenant: () => true });
    h.db.tables.rag_answer_records.push(row);
    h.db.tables.chats.push(owned);
    await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['wrong'] });
    await h.run();
    await submit(h, String(row.id), { vote: 'not_helpful', reasons: ['incomplete'] });
    await h.run();
    expect(row.review_reasons).toEqual(['feedback_negative']);
    expect(h.reviews).toHaveLength(2);
    expect(h.reviews[0]).toEqual({
      traceId: TRACE,
      tenantKey: `o:${ORG}`,
      reason: 'feedback_negative',
      query: QUESTION,
      answer: ANSWER,
      citedQuotes: [QUOTE],
      model: 'placeholder/model',
    });
  });

  it('a helpful vote appends no review reason and exports no review copy', async () => {
    const row = record();
    h.db.tables.rag_answer_records.push(row);
    await submit(h, String(row.id), { vote: 'helpful' });
    await h.run();
    expect(row.review_reasons).toEqual([]);
    expect(h.reviews).toHaveLength(0);
  });

  it("never takes review text from a chat row of another user, and gives empty texts when the record has no chat", async () => {
    const row = record();
    const foreignChat = chat(String(row.id), { user_id: USER_B });
    row.chat_id = foreignChat.id;
    h.db.tables.rag_answer_records.push(row);
    h.db.tables.chats.push(foreignChat);
    await submit(h, String(row.id), { vote: 'not_helpful' });
    await h.run();
    expect(h.reviews[0]).toMatchObject({ query: '', answer: '', tenantKey: 's:default' });
  });

  it('attaches an unlinked record to an owned chat that lists the answerId before the vote; a foreign chatId is ignored', async () => {
    const linked = record();
    const owned = chat(String(linked.id));
    h.db.tables.rag_answer_records.push(linked);
    h.db.tables.chats.push(owned);
    await submit(h, String(linked.id), { vote: 'not_helpful', chatId: owned.id });
    expect(linked.chat_id).toBe(owned.id);
    await h.run();
    expect(h.reviews[0]).toMatchObject({ query: QUESTION, answer: ANSWER });

    const other = record();
    const foreign = chat(String(other.id), { user_id: USER_B });
    h.db.tables.rag_answer_records.push(other);
    h.db.tables.chats.push(foreign);
    const result = await submit(h, String(other.id), { vote: 'helpful', chatId: foreign.id });
    expect(result.ok).toBe(true);
    expect(other.chat_id).toBe(null);

    const unlisted = record();
    const ownedWithout = chat(crypto.randomUUID());
    h.db.tables.rag_answer_records.push(unlisted);
    h.db.tables.chats.push(ownedWithout);
    await submit(h, String(unlisted.id), { vote: 'helpful', chatId: ownedWithout.id });
    expect(unlisted.chat_id).toBe(null);
  });

  it('answers unavailable when the store write fails, and schedules nothing', async () => {
    const row = record();
    h.db.tables.rag_answer_records.push(row);
    h.db.failUpdates = true;
    captureConsole();
    expect(await submit(h, String(row.id), { vote: 'helpful' })).toEqual({ ok: false, reason: 'unavailable' });
    expect(h.tasks).toHaveLength(0);
  });
});

describe('exportReviewCandidate', () => {
  const input: ReviewCandidateInput = {
    traceId: TRACE,
    tenantKey: 'u:00000000-0000-4000-8000-0000000021a1',
    reason: 'groundedness_flagged',
    query: `${QUESTION} mail jane.doe@example.com`,
    answer: ANSWER,
    citedQuotes: [QUOTE, 'Call +39 333 123 4567 for details.'],
    model: 'placeholder/model',
  };

  it('exports one trace on the same traceId tagged review:<reason> with masked review content, whatever the sample rates', async () => {
    const traces: CollectedTrace[] = [];
    const status = await exportReviewCandidate(input, {
      config: langfuse({ sampleRate: 0, reviewSampleRate: 0 }),
      exportTrace: async (trace) => {
        traces.push(trace);
      },
    });
    expect(status).toBe('exported');
    expect(traces).toHaveLength(1);
    const [trace] = traces;
    expect(trace.traceId).toBe(TRACE);
    expect(trace.tenantKey).toBe(input.tenantKey);
    expect(trace.tags).toEqual(expect.arrayContaining(['rag-pipeline', `tenant:${input.tenantKey}`, 'review:groundedness_flagged']));
    expect(trace.review).toBeDefined();
    expect(trace.review?.query).toContain('[EMAIL]');
    expect(trace.review?.answer).toBe(ANSWER);
    expect(trace.review?.context).toContain(QUOTE);
    expect(trace.review?.context).toContain('[PHONE]');
    expect(trace.review?.model).toBe('placeholder/model');
    expect(JSON.stringify(trace)).not.toContain('jane.doe');
  });

  it('with Langfuse off exports nothing and raises nothing; an export failure gives failed', async () => {
    const exportTrace = vi.fn(async () => undefined);
    expect(await exportReviewCandidate(input, { config: langfuse({ enabled: false }), exportTrace })).toBe('skipped');
    expect(exportTrace).not.toHaveBeenCalled();
    const failing = vi.fn(async () => {
      throw new Error('down');
    });
    await expect(exportReviewCandidate(input, { config: langfuse(), exportTrace: failing })).resolves.toBe('failed');
    const hanging = vi.fn(() => new Promise<void>(() => undefined));
    await expect(exportReviewCandidate(input, { config: langfuse(), exportTrace: hanging, timeoutMs: 20 })).resolves.toBe('failed');
  });
});

describe('groundedness_flagged after scoring (D-19)', () => {
  const USER = '00000000-0000-4000-8000-0000000021c1';
  const BLOCK = 'Refunds are accepted within 30 days of purchase for annual plans.';
  const FINISH_ANSWER = 'Annual plans can be refunded within 30 days [S1].';
  const FINISH_QUERY = 'Can I get a refund on an annual plan?';

  function finishInput(): AnswerFinishInput {
    return {
      answerId: mintAnswerId(),
      scope: mintScope('single', null, null),
      userId: USER,
      chatId: null,
      traceId: 'e'.repeat(32),
      modelId: 'test/model',
      ragMode: 'strict',
      queryText: FINISH_QUERY,
      citations: [
        { n: 1, alias: 'S1', chunkIds: ['c1'], documentId: 'd1', documentName: 'Refunds.pdf', documentVersion: 1, page: null, sectionPath: null, quote: BLOCK, quoteHash: 'a'.repeat(64), strategy: 'chunk-alias' },
      ],
      citationStrategy: 'chunk-alias',
      invalidCitations: 0,
      answerText: FINISH_ANSWER,
      aborted: false,
      groundednessEligible: true,
      toolOutputUsed: false,
      premise: { blocks: [{ alias: 'S1', text: BLOCK }], webSearchTexts: [] },
      requestLanguage: 'en',
    };
  }

  async function runStep(result: Partial<GroundednessResult>, step: Partial<GroundednessStepDeps> = {}) {
    const appended: Array<{ id: string; reason: string }> = [];
    const exported: ReviewCandidateInput[] = [];
    const tasks: Array<() => Promise<void>> = [];
    const input = finishInput();
    scheduleAnswerFinish(input, {
      admin: () => ({}) as SupabaseClient,
      insert: async () => ({ inserted: true }),
      schedule: (task) => {
        tasks.push(task);
      },
      readConfig: () => ({ groundedness: true }),
      onPending: createGroundednessStep({
        readConfig: () => ({ vectaraOptIn: false, vectaraMultiTenantAck: false, maxPremiseTokens: 2000, groundednessTimeoutMs: 20000 }),
        multiTenant: () => false,
        langfuse: () => langfuse({ enabled: false }),
        update: async () => true,
        request: async () => ({ status: 'scored', scorer: 'hhem_2_1_open', score: 0.9, reason: null, truncated: false, latency_ms: 5, ...result }) as GroundednessResult,
        appendReviewReason: async (_admin, entry) => {
          appended.push(entry);
          return true;
        },
        exportReview: async (entry) => {
          exported.push(entry);
          return 'exported';
        },
        ...step,
      }),
    });
    for (const task of tasks.splice(0)) await task();
    return { input, appended, exported };
  }

  it('a possibly_unreliable label appends groundedness_flagged once and exports the in-memory query and answer', async () => {
    captureConsole();
    const { input, appended, exported } = await runStep({ score: 0.1 });
    expect(appended).toEqual([{ id: input.answerId, reason: 'groundedness_flagged' }]);
    expect(exported).toEqual([
      { traceId: input.traceId, tenantKey: 's:default', reason: 'groundedness_flagged', query: FINISH_QUERY, answer: FINISH_ANSWER, citedQuotes: [BLOCK], model: 'test/model' },
    ]);
  });

  it('verified and not_checked labels add no reason and export nothing', async () => {
    captureConsole();
    for (const result of [{ score: 0.9 }, { status: 'not_checked', scorer: 'none', score: null, reason: 'timeout' }] as Array<Partial<GroundednessResult>>) {
      const { appended, exported } = await runStep(result);
      expect(appended).toEqual([]);
      expect(exported).toEqual([]);
    }
  });

  it('a failing reason append or export is logged with a code and never throws', async () => {
    const lines = captureConsole();
    const { exported } = await runStep(
      { score: 0.1 },
      {
        appendReviewReason: async () => {
          throw new Error('review reason update failed (contention)');
        },
      },
    );
    expect(exported).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('[Answer Record]') && line.includes('contention'))).toBe(true);
    expect(lines.join('\n')).not.toContain(FINISH_QUERY);
  });
});
