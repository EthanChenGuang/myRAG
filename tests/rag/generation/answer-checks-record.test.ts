import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintScope } from '@/lib/rag/tenant/scope';
import {
  ANSWER_RECORD_COLUMNS,
  answerChecksColumnsEnabled,
  answerRecordColumns,
  appendReviewReason,
  insertAnswerRecord,
  updateAnswerChecks,
  type InsertAnswerRecordInput,
  type ReviewReason,
} from '@/lib/answers/store';
import { AnswerChecksSchema, type AnswerSentence, type CitationRecord } from '@/lib/rag-eval/contracts.generated';
import { mintAnswerId, scheduleAnswerFinish, type AnswerFinishDeps, type AnswerFinishInput } from '@/lib/rag/generation/answer-finish';
import type { AnswerChecksInput } from '@/lib/rag/generation/answer-checks';

const USER = '00000000-0000-4000-8000-0000000000a1';
const PHASE5_COLUMNS =
  'id,user_id,organization_id,chat_id,trace_id,model_id,citation_strategy,rag_mode,answer_language,invalid_citations,citations,groundedness,feedback,review_reasons,created_at,updated_at';
const PHASE5_INSERT_KEYS = [
  'answerLanguage',
  'chatId',
  'citationStrategy',
  'citations',
  'groundedness',
  'id',
  'invalidCitations',
  'modelId',
  'ragMode',
  'scope',
  'traceId',
  'userId',
];
const PHASE5_ROW_KEYS = [
  'answer_language',
  'chat_id',
  'citation_strategy',
  'citations',
  'groundedness',
  'id',
  'invalid_citations',
  'model_id',
  'organization_id',
  'rag_mode',
  'trace_id',
  'user_id',
];
const SWITCHES = [
  'RAG_REGISTRY_TEXTS',
  'RAG_PARTIAL_ANSWER_RULE',
  'RAG_CONTEXT_RELEVANCE_RULE',
  'RAG_CITATION_PER_SENTENCE',
  'RAG_CITATIONS',
  'RAG_CLAUDE_CITATIONS',
  'RAG_CLAIM_CHECK',
  'RAG_GROUNDEDNESS',
  'RAG_GROUNDEDNESS_LLM_JUDGE',
  'RAG_MAX_OUTPUT_TOKENS',
  'RAG_OUTPUT_GUARD',
  'RAG_VERSION_LABELS',
  'RAG_SECURITY_EVENTS',
  'RAG_UPLOADER_ALERT_THRESHOLD',
  'RAG_UPLOADER_HOLD',
];

const ANSWER_TEXT = 'The blue widget has four sides [S1].';

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function quote(text: string): CitationRecord {
  return {
    n: 1,
    alias: 'S1',
    chunkIds: ['c1'],
    documentId: 'd1',
    documentName: 'Sample.pdf',
    documentVersion: 1,
    page: null,
    sectionPath: null,
    quote: text,
    quoteHash: hash(text),
    strategy: 'chunk-alias',
  };
}

function sentence(overrides: Partial<AnswerSentence> = {}): AnswerSentence {
  return {
    index: 0,
    part: 0,
    start: 0,
    end: ANSWER_TEXT.length,
    kind: 'sentence',
    cited: true,
    factual: true,
    support: 'not_checked',
    reason: null,
    scorer: null,
    text_hash: hash(ANSWER_TEXT),
    ...overrides,
  };
}

function finishInput(overrides: Partial<AnswerFinishInput> = {}): AnswerFinishInput {
  return {
    answerId: mintAnswerId(),
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: 'trace-1',
    modelId: 'test/model',
    ragMode: 'strict',
    queryText: 'How many sides does the blue widget have?',
    citations: [quote('The blue widget has four sides.')],
    citationStrategy: 'chunk-alias',
    invalidCitations: 0,
    answerText: ANSWER_TEXT,
    aborted: false,
    groundednessEligible: true,
    toolOutputUsed: false,
    premise: { blocks: [{ alias: 'S1', text: 'The blue widget has four sides.' }], webSearchTexts: [] },
    requestLanguage: 'en',
    ...overrides,
  };
}

function finishHarness() {
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

interface Recorded {
  table: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, string, unknown]>;
  select?: string;
}

function fakeAdmin(options: { reviewReasons?: string[] } = {}) {
  const calls: Recorded[] = [];
  const client = {
    from(table: string) {
      const call: Recorded = { table, op: 'select', filters: [] };
      calls.push(call);
      const builder = {
        upsert(payload: unknown) {
          call.op = 'upsert';
          call.payload = payload;
          return builder;
        },
        update(payload: unknown) {
          call.op = 'update';
          call.payload = payload;
          return builder;
        },
        select(columns: string) {
          call.select = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push(['eq', column, value]);
          return builder;
        },
        async maybeSingle() {
          return { data: { id: 'x', review_reasons: options.reviewReasons ?? [] }, error: null };
        },
        then(resolve: (value: unknown) => void) {
          resolve({ data: [{ id: 'x' }], error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

function storeInput(overrides: Partial<InsertAnswerRecordInput> = {}): InsertAnswerRecordInput {
  return {
    id: mintAnswerId(),
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: 'trace-1',
    modelId: 'test/model',
    citationStrategy: 'chunk-alias',
    ragMode: 'strict',
    answerLanguage: 'en',
    invalidCitations: 0,
    citations: [],
    groundedness: { status: 'not_checked', label: 'not_checked', reason: 'disabled' } as InsertAnswerRecordInput['groundedness'],
    ...overrides,
  };
}

describe('answer checks on the record (D-23, D-89)', () => {
  let saved: Record<string, string | undefined>;
  let warnings: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    saved = Object.fromEntries(SWITCHES.map((name) => [name, process.env[name]]));
    for (const name of SWITCHES) delete process.env[name];
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.restoreAllMocks();
  });

  describe('column list', () => {
    it('is the Phase 5 list with every switch off', () => {
      expect(ANSWER_RECORD_COLUMNS).toBe(PHASE5_COLUMNS);
      expect(answerChecksColumnsEnabled()).toBe(false);
      expect(answerRecordColumns()).toBe(PHASE5_COLUMNS);
    });

    it('adds checks and texts_source while a switch that writes them is on', () => {
      for (const [name, value] of [
        ['RAG_REGISTRY_TEXTS', 'true'],
        ['RAG_OUTPUT_GUARD', 'flag'],
        ['RAG_VERSION_LABELS', 'true'],
        ['RAG_MAX_OUTPUT_TOKENS', 'auto'],
      ] as const) {
        process.env[name] = value;
        expect(answerChecksColumnsEnabled()).toBe(true);
        expect(answerRecordColumns()).toBe(`${PHASE5_COLUMNS},checks,texts_source`);
        delete process.env[name];
      }
      process.env.RAG_CITATIONS = 'true';
      process.env.RAG_CITATION_PER_SENTENCE = 'true';
      expect(answerRecordColumns()).toBe(`${PHASE5_COLUMNS},checks,texts_source`);
    });

    it('stays the Phase 5 list for invalid values that fall back to off', () => {
      process.env.RAG_OUTPUT_GUARD = 'loud';
      process.env.RAG_MAX_OUTPUT_TOKENS = 'off';
      expect(answerRecordColumns()).toBe(PHASE5_COLUMNS);
    });
  });

  describe('finishAnswer insert', () => {
    it('with every switch off the insert input has only the Phase 5 fields and today\'s language', async () => {
      const h = finishHarness();
      scheduleAnswerFinish(finishInput(), h.deps);
      await h.run();
      expect(h.inserts).toHaveLength(1);
      expect(Object.keys(h.inserts[0]).sort()).toEqual(PHASE5_INSERT_KEYS);
      expect(h.inserts[0].answerLanguage).toBe('en');
    });

    it('per-sentence on: carries checks with sentences and text_language, texts_source and the question language', async () => {
      const h = finishHarness();
      const checks: AnswerChecksInput = { sentences: [sentence()], truncated: false, finish_reason: 'stop' };
      scheduleAnswerFinish(finishInput({ checks, answerLanguage: 'it', textsSource: 'registry' }), h.deps);
      await h.run();
      const row = h.inserts[0];
      expect(row.answerLanguage).toBe('it');
      expect(row.textsSource).toBe('registry');
      expect(row.checks?.sentences).toEqual([sentence()]);
      expect(row.checks?.text_language).toBe('en');
      expect(row.checks?.finish_reason).toBe('stop');
      expect(AnswerChecksSchema.safeParse(row.checks).success).toBe(true);
    });

    it('falls back to the detected language when the turn has no answer language', async () => {
      const h = finishHarness();
      scheduleAnswerFinish(finishInput({ checks: { truncated: true, finish_reason: 'length' }, answerLanguage: null, textsSource: 'legacy' }), h.deps);
      await h.run();
      expect(h.inserts[0].answerLanguage).toBe('en');
      expect(h.inserts[0].checks).toMatchObject({ truncated: true, finish_reason: 'length', text_language: 'en' });
      expect(h.inserts[0].textsSource).toBe('legacy');
    });

    it('drops checks that fail the contract, logs the issue count once and still inserts the record', async () => {
      const h = finishHarness();
      const checks = { sentences: [sentence({ text_hash: 'not-a-hash' })], truncated: false, finish_reason: 'stop' } as AnswerChecksInput;
      scheduleAnswerFinish(finishInput({ checks, answerLanguage: 'en', textsSource: 'registry' }), h.deps);
      await h.run();
      expect(h.inserts).toHaveLength(1);
      expect('checks' in h.inserts[0]).toBe(false);
      expect(h.inserts[0].textsSource).toBe('registry');
      const lines = warnings.mock.calls.filter((call) => String(call[0]).startsWith('[Answer Record]'));
      expect(lines).toHaveLength(1);
      expect(lines[0][1]).toMatchObject({ issues: 1 });
      expect(JSON.stringify(lines)).not.toContain(ANSWER_TEXT);
    });
  });

  describe('store insert payload', () => {
    it('is the Phase 5 row with no checks or texts_source given', async () => {
      const admin = fakeAdmin();
      await insertAnswerRecord(admin.client, storeInput());
      const payload = admin.calls[0].payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(PHASE5_ROW_KEYS);
    });

    it('writes validated checks and texts_source when given', async () => {
      const admin = fakeAdmin();
      const checks = AnswerChecksSchema.parse({ sentences: [sentence()], truncated: false, finish_reason: 'stop', text_language: 'en' });
      await insertAnswerRecord(admin.client, storeInput({ checks, textsSource: 'registry' }));
      const payload = admin.calls[0].payload as Record<string, unknown>;
      expect(payload.checks).toEqual(checks);
      expect(payload.texts_source).toBe('registry');
    });

    it('rejects an invalid texts_source', async () => {
      const admin = fakeAdmin();
      await expect(insertAnswerRecord(admin.client, storeInput({ textsSource: 'other' as never }))).rejects.toThrow();
      expect(admin.calls).toHaveLength(0);
    });
  });

  describe('review reasons (D-55)', () => {
    it('accepts claim_unsupported and still rejects an unknown reason', async () => {
      const admin = fakeAdmin();
      await expect(appendReviewReason(admin.client, { id: mintAnswerId(), reason: 'claim_unsupported' })).resolves.toBe(true);
      const update = admin.calls.find((call) => call.op === 'update');
      expect((update?.payload as { review_reasons: string[] }).review_reasons).toEqual(['claim_unsupported']);
      await expect(appendReviewReason(fakeAdmin().client, { id: mintAnswerId(), reason: 'unknown_reason' as ReviewReason })).rejects.toThrow(
        'unknown review reason',
      );
    });
  });

  describe('updateAnswerChecks', () => {
    it('writes the whole validated object for that answer only', async () => {
      const admin = fakeAdmin();
      const id = mintAnswerId();
      const checks = AnswerChecksSchema.parse({ sentences: [sentence({ support: 'supported', scorer: 'hhem_2_1_open' })], truncated: false });
      await expect(updateAnswerChecks(admin.client, { id, checks })).resolves.toBe(true);
      expect(admin.calls).toHaveLength(1);
      const call = admin.calls[0];
      expect(call.op).toBe('update');
      expect(call.filters).toEqual([['eq', 'id', id]]);
      const payload = call.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(['checks', 'updated_at']);
      expect(payload.checks).toEqual(checks);
    });

    it('rejects checks that fail the contract and ignores a malformed id', async () => {
      const admin = fakeAdmin();
      await expect(updateAnswerChecks(admin.client, { id: mintAnswerId(), checks: { truncated: 'yes' } as never })).rejects.toThrow();
      await expect(updateAnswerChecks(admin.client, { id: 'not-a-uuid', checks: AnswerChecksSchema.parse({}) })).resolves.toBe(false);
      expect(admin.calls).toHaveLength(0);
    });
  });
});
