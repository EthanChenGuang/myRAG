import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimCheckRequest, GroundednessResult } from '@/lib/rag-eval/contracts.generated';
import { createGroundednessStep, type AnswerFinishInput, type AnswerPendingContext } from '@/lib/rag/generation/answer-finish';
import { createClaimStep, type ClaimStepConfig } from '@/lib/rag/generation/claims';
import { submitAnswerFeedback } from '@/lib/rag/generation/feedback';
import { buildSentenceRecords } from '@/lib/rag/generation/sentences-record';
import { cachedSourceDocumentIds } from '@/lib/rag/cache/sources';
import { createTraceCollector, finishTrace } from '@/lib/rag';
import { resultDocumentIds } from '@/lib/rag/pipeline';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import type { CollectedTrace } from '@/lib/rag/trace/langfuse';
import { exportReviewCandidate, type ReviewCandidateInput } from '@/lib/rag/trace/review-export';
import type { RetrievalResult } from '@/lib/rag/types';
import { adminClient, newAnswerDb, sessionClient, type Row } from '../../helpers/answer-db-fake';

const langfuseCalls = vi.hoisted(() => [] as CollectedTrace[]);
vi.mock('@/lib/rag/trace/langfuse', () => ({
  exportTrace: async (trace: CollectedTrace) => {
    langfuseCalls.push(trace);
  },
}));

const USER = '00000000-0000-4000-8000-0000000043a1';
const TRACE = 'c'.repeat(32);
const GROUP = 'g:00000000-0000-4000-8000-0000000043f1';
const SET_HASH = '0123456789abcdef'.repeat(4);
const QUERY = 'Which synthetic module stores the sample records?';
const HIDDEN = 'Synthetic restricted sentence marker 5521 stores the sample records.';
const ANSWER = `${HIDDEN} [S1].`;

const LANGFUSE: LangfuseConfig = {
  enabled: true,
  publicKey: 'pk-placeholder',
  secretKey: 'sk-placeholder',
  baseUrl: 'http://127.0.0.1:1',
  sampleRate: 0,
  reviewSampleRate: 0,
  captureContent: false,
};

type Exported = { input: ReviewCandidateInput; trace: CollectedTrace | null };

/** The caller's exportReview dependency, running the real exportReviewCandidate with a captured Langfuse export. */
function realExport(accessOn: boolean, sink: Exported[]) {
  return async (input: ReviewCandidateInput) => {
    const entry: Exported = { input, trace: null };
    sink.push(entry);
    return exportReviewCandidate(input, {
      config: LANGFUSE,
      accessOn: () => accessOn,
      exportTrace: async (trace) => {
        entry.trace = trace;
      },
    });
  };
}

function citation(documentId: string) {
  return {
    n: 1,
    alias: 'S1',
    chunkIds: ['c1'],
    documentId,
    documentName: 'sample.txt',
    documentVersion: 1,
    page: null,
    sectionPath: null,
    quote: HIDDEN,
    quoteHash: 'a'.repeat(64),
    strategy: 'chunk-alias' as const,
  };
}

function finishInput(overrides: Partial<AnswerFinishInput> = {}): AnswerFinishInput {
  return {
    answerId: crypto.randomUUID(),
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: TRACE,
    modelId: 'test/model',
    ragMode: 'strict',
    queryText: QUERY,
    citations: [citation('d1')],
    citationStrategy: 'chunk-alias',
    invalidCitations: 0,
    answerText: ANSWER,
    aborted: false,
    groundednessEligible: true,
    toolOutputUsed: false,
    premise: { blocks: [{ alias: 'S1', text: HIDDEN }], webSearchTexts: [] },
    requestLanguage: 'en',
    ...overrides,
  };
}

function context(input: AnswerFinishInput): AnswerPendingContext {
  return { answerId: input.answerId, input, admin: {} as SupabaseClient };
}

function expectStripped(entry: Exported | undefined): void {
  expect(entry?.trace).not.toBeNull();
  const text = JSON.stringify(entry?.trace);
  expect(text).not.toContain('5521');
  expect(text).not.toContain(QUERY);
  expect(entry?.trace?.review).toEqual({ model: expect.any(String), citedCount: expect.any(Number) });
}

function expectFull(entry: Exported | undefined): void {
  expect(entry?.trace?.review?.query).toBe(QUERY);
  expect(entry?.trace?.review?.context).toContain('5521');
}

beforeEach(() => {
  langfuseCalls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exportReviewCandidate with access groups (T-04.3-143)', () => {
  const base: ReviewCandidateInput = { traceId: TRACE, tenantKey: 's:default', reason: 'groundedness_flagged', query: QUERY, answer: ANSWER, citedQuotes: [HIDDEN], model: 'test/model' };

  it('keeps the text only when every cited document is labelled exactly all', async () => {
    const sink: Exported[] = [];
    await realExport(true, sink)({ ...base, accessSets: [['all'], ['all']] });
    expectFull(sink[0]);
  });

  it('drops query, answer and quotes when one cited document is restricted, keeping ids and counts', async () => {
    const sink: Exported[] = [];
    await realExport(true, sink)({ ...base, accessSets: [['all'], [GROUP]] });
    expectStripped(sink[0]);
    expect(sink[0]?.trace?.traceId).toBe(TRACE);
    expect(sink[0]?.trace?.review?.citedCount).toBe(1);
  });

  it('treats unknown sets as restricted while access is on', async () => {
    const sink: Exported[] = [];
    await realExport(true, sink)({ ...base });
    expectStripped(sink[0]);
  });

  it('exports as today while access is off, whatever the sets', async () => {
    const sink: Exported[] = [];
    await realExport(false, sink)({ ...base, accessSets: [[GROUP]] });
    expectFull(sink[0]);
  });
});

describe('groundedness_flagged review export', () => {
  const unreliable = async (): Promise<GroundednessResult> => ({ status: 'scored', scorer: 'hhem_2_1_open', score: 0.01, reason: null, truncated: false, latency_ms: 5 });

  function step(accessOn: boolean, sink: Exported[]) {
    return createGroundednessStep({
      readConfig: () => ({ vectaraOptIn: false, vectaraMultiTenantAck: false, maxPremiseTokens: 2000, groundednessTimeoutMs: 20000 }),
      multiTenant: () => false,
      request: unreliable as never,
      update: async () => true,
      appendReviewReason: async () => true,
      langfuse: () => ({ ...LANGFUSE, enabled: false }),
      exportReview: realExport(accessOn, sink),
    });
  }

  it('strips a restricted cited document while access is on', async () => {
    const sink: Exported[] = [];
    await step(true, sink)(context(finishInput({ accessSets: [[GROUP]] })));
    expect(sink).toHaveLength(1);
    expectStripped(sink[0]);
  });

  it('keeps the text for open documents while access is on', async () => {
    const sink: Exported[] = [];
    await step(true, sink)(context(finishInput({ accessSets: [['all']] })));
    expectFull(sink[0]);
  });

  it('exports unchanged while access is off', async () => {
    const sink: Exported[] = [];
    await step(false, sink)(context(finishInput()));
    expectFull(sink[0]);
  });
});

describe('claim_unsupported review export', () => {
  const CONFIG: ClaimStepConfig = {
    claimCheck: true,
    llmJudge: false,
    judgeModel: '',
    vectaraOptIn: false,
    vectaraMultiTenantAck: false,
    maxPremiseTokens: 2000,
    groundednessTimeoutMs: 20000,
  };

  function step(accessOn: boolean, sink: Exported[]) {
    return createClaimStep({
      readConfig: () => CONFIG,
      multiTenant: () => false,
      request: async (request: ClaimCheckRequest) => ({
        claims: request.claims.map((claim) => ({ index: claim.index, status: 'scored' as const, scorer: 'hhem_2_1_open' as const, score: 0.01, reason: null })),
        latency_ms: 5,
      }),
      updateChecks: async () => true,
      updateGroundedness: async () => true,
      appendReviewReason: async () => true,
      langfuse: () => ({ ...LANGFUSE, enabled: false }),
      exportTrace: async () => undefined,
      postScores: async () => ({ status: 'accepted' as const, httpStatus: 200 }),
      exportReview: realExport(accessOn, sink),
    } as never);
  }

  function claimInput(overrides: Partial<AnswerFinishInput> = {}): AnswerFinishInput {
    const sentences = buildSentenceRecords({ text: ANSWER, part: 0, language: 'en', aliases: new Set(['S1']) });
    return finishInput({ checks: { sentences, truncated: false, finish_reason: 'stop' }, answerLanguage: 'en', refusedByModel: false, ...overrides });
  }

  it('strips a restricted cited document while access is on', async () => {
    const sink: Exported[] = [];
    await step(true, sink)(context(claimInput({ accessSets: [[GROUP]] })));
    expect(sink).toHaveLength(1);
    expectStripped(sink[0]);
  });

  it('exports unchanged while access is off', async () => {
    const sink: Exported[] = [];
    await step(false, sink)(context(claimInput()));
    expectFull(sink[0]);
  });
});

describe('feedback_negative review export', () => {
  const NOW = new Date('2026-11-27T12:00:00.000Z');

  function setup(accessOn: boolean, row: Row) {
    const db = newAnswerDb();
    db.session = { id: USER };
    db.tables.rag_answer_records.push(row);
    db.tables.chats.push({
      id: 'chat-1',
      user_id: USER,
      organization_id: null,
      messages: [
        { role: 'user', content: QUERY },
        { role: 'assistant', parts: [{ type: 'text', text: ANSWER }], metadata: { answerId: row.id } },
      ],
    });
    const tasks: Array<() => Promise<void>> = [];
    const sink: Exported[] = [];
    const run = async () => {
      await submitAnswerFeedback({
        answerId: String(row.id),
        userId: USER,
        request: { vote: 'not_helpful', chatId: null, comment: null, reasons: [] } as never,
        session: sessionClient(db),
        deps: {
          admin: () => adminClient(db),
          schedule: (task) => {
            tasks.push(task);
          },
          now: () => NOW,
          langfuse: () => LANGFUSE,
          multiTenant: () => false,
          accessOn: () => accessOn,
          postScores: async () => ({ status: 'accepted', httpStatus: 202 }),
          exportReview: realExport(accessOn, sink),
          langfuseTimeoutMs: 200,
        } as never,
      });
      for (const task of tasks.splice(0)) await task();
    };
    return { run, sink };
  }

  function row(over: Row = {}): Row {
    const at = new Date(NOW.getTime() - 60_000).toISOString();
    return {
      id: crypto.randomUUID(),
      user_id: USER,
      organization_id: null,
      chat_id: 'chat-1',
      trace_id: TRACE,
      model_id: 'test/model',
      citation_strategy: 'chunk-alias',
      rag_mode: 'strict',
      answer_language: 'en',
      invalid_citations: 0,
      citations: [citation('d1')],
      groundedness: { status: 'scored', label: 'verified', truncated: false },
      feedback: null,
      review_reasons: [],
      created_at: at,
      updated_at: at,
      ...over,
    };
  }

  it('strips a row whose stored access sets name a restricted document while access is on', async () => {
    const h = setup(true, row({ access_sets: [[GROUP]] }));
    await h.run();
    expect(h.sink).toHaveLength(1);
    expectStripped(h.sink[0]);
  });

  it('strips a row with no stored access sets while access is on (unknown is restricted)', async () => {
    const h = setup(true, row());
    await h.run();
    expectStripped(h.sink[0]);
  });

  it('keeps the text for a row whose cited documents are all open', async () => {
    const h = setup(true, row({ access_sets: [['all']] }));
    await h.run();
    expectFull(h.sink[0]);
  });

  it('exports unchanged while access is off', async () => {
    const h = setup(false, row({ access_sets: [[GROUP]] }));
    await h.run();
    expectFull(h.sink[0]);
  });
});

describe('semantic-cache hit review content (cached sources count as kept)', () => {
  const cacheHit = {
    entryId: 'entry-1',
    distance: 0.01,
    answer: {
      answer_text: ANSWER,
      answer_language: 'en',
      citations: [],
      created_at: NOW_ISO(),
      groundedness: { status: 'scored', label: 'verified', truncated: false },
      is_refusal: false,
      rag_mode: 'strict',
      source_versions: [{ document_id: 'doc-cached', version: 1 }],
      sources: [{ document_id: 'doc-cached', name: 'cached.txt', version: 1 }],
      trace_id: TRACE,
    },
  };

  function NOW_ISO(): string {
    return '2026-11-27T12:00:00.000Z';
  }

  function hitResult(labels?: Map<string, readonly string[]>): RetrievalResult {
    const value = {
      status: 'ok',
      reason: 'cache_hit',
      candidates: [],
      context: '',
      usedDocuments: [],
      sourceImages: [],
      links: [],
      relevantChunks: [],
      kept: [],
      queryTerms: [],
      refusalCandidate: false,
      stages: [],
      traceId: 'unused',
      queryContext: null,
      cacheHit,
    } as unknown as RetrievalResult;
    if (labels) Object.defineProperty(value, 'accessLabels', { value: labels, enumerable: false });
    return value;
  }

  async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function finish(result: RetrievalResult, accessOn: boolean): void {
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    if (accessOn) collector.setAccess({ mode: 'keys', setHash: SET_HASH });
    collector.setReviewContent({ answer: cacheHit.answer.answer_text });
    finishTrace(collector, result, { config: { ...LANGFUSE, reviewSampleRate: 1 }, query: QUERY });
  }

  it('lists the cached sources among the documents whose labels are read', () => {
    expect(cachedSourceDocumentIds(cacheHit as never)).toEqual(['doc-cached']);
    expect(resultDocumentIds(hitResult())).toContain('doc-cached');
  });

  it('drops the cached answer and the query from the review export when a cached source is restricted', async () => {
    finish(hitResult(new Map([['doc-cached', [GROUP]]])), true);
    await settle();
    expect(langfuseCalls).toHaveLength(1);
    expect(JSON.stringify(langfuseCalls[0])).not.toContain('5521');
    expect(JSON.stringify(langfuseCalls[0])).not.toContain(QUERY);
  });

  it('drops the cached answer when the cached source has no known label set', async () => {
    finish(hitResult(new Map()), true);
    await settle();
    expect(JSON.stringify(langfuseCalls[0])).not.toContain('5521');
  });

  it('keeps the cached answer for open cached sources and while access is off', async () => {
    finish(hitResult(new Map([['doc-cached', ['all']]])), true);
    finish(hitResult(), false);
    await settle();
    expect(langfuseCalls).toHaveLength(2);
    for (const trace of langfuseCalls) expect(trace.review?.answer).toContain('5521');
  });
});
