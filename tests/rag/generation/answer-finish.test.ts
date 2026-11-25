import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { InsertAnswerRecordInput } from '@/lib/answers/store';
import { AnswerStoreError } from '@/lib/answers/store';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import {
  mintAnswerId,
  scheduleAnswerFinish,
  shouldPersistAnswer,
  type AnswerFinishDeps,
  type AnswerFinishInput,
} from '@/lib/rag/generation/answer-finish';

const USER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_USER = '00000000-0000-4000-8000-0000000000b2';
const ORG = '00000000-0000-4000-8000-0000000000c3';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000d4';
const CHAT = '00000000-0000-4000-8000-0000000000e5';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ALL_OFF = { citations: false, claudeCitations: false, groundedness: false, feedback: false };

function quote(text: string): CitationRecord {
  return {
    n: 1,
    alias: 'S1',
    chunkIds: ['c1'],
    documentId: 'd1',
    documentName: 'Refunds.pdf',
    documentVersion: 1,
    page: null,
    sectionPath: null,
    quote: text,
    quoteHash: createHash('sha256').update(text).digest('hex'),
    strategy: 'chunk-alias',
  };
}

interface ChatRow {
  id: string;
  user_id: string;
  organization_id: string | null;
}

function fakeAdmin(options: { chat?: ChatRow | null; error?: { code: string } } = {}) {
  const lookups: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const client = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          lookups.push({ table, filters });
          if (options.error) return { data: null, error: options.error };
          const chat = options.chat ?? null;
          const matches = chat && filters.every(([column, value]) => (chat as unknown as Record<string, unknown>)[column] === value);
          return { data: matches ? chat : null, error: null };
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, lookups };
}

function harness(options: { chat?: ChatRow | null; lookupError?: { code: string }; insertError?: unknown; groundedness?: boolean } = {}) {
  const admin = fakeAdmin({ chat: options.chat, error: options.lookupError });
  const inserts: InsertAnswerRecordInput[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const pending: string[] = [];
  const deps: Partial<AnswerFinishDeps> = {
    admin: () => admin.client,
    insert: async (_client, input) => {
      if (options.insertError) throw options.insertError;
      inserts.push(input);
      return { inserted: true };
    },
    schedule: (task) => {
      tasks.push(task);
    },
    readConfig: () => ({ groundedness: options.groundedness === true }),
    onPending: async ({ answerId }) => {
      pending.push(answerId);
    },
  };
  return {
    admin,
    inserts,
    tasks,
    pending,
    deps,
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
    traceId: 'trace-1',
    modelId: 'test/model',
    ragMode: 'strict',
    queryText: 'What is the refund window?',
    citations: [quote('Refunds are accepted within 30 days of purchase.')],
    citationStrategy: 'chunk-alias',
    invalidCitations: 2,
    answerText: 'Refunds are accepted within 30 days [S1].',
    aborted: false,
    groundednessEligible: true,
    toolOutputUsed: false,
    premise: { blocks: [{ alias: 'S1', text: 'Refunds are accepted within 30 days of purchase.' }], webSearchTexts: [] },
    requestLanguage: 'en',
    ...overrides,
  };
}

describe('shouldPersistAnswer', () => {
  const base = { capabilities: { citations: true }, userId: USER, chatId: CHAT, config: { ...ALL_OFF, citations: true } };

  it('is true with the capability, a session user, a non-ghost chat and one switch on', () => {
    expect(shouldPersistAnswer(base)).toBe(true);
    expect(shouldPersistAnswer({ ...base, chatId: null })).toBe(true);
    expect(shouldPersistAnswer({ ...base, chatId: undefined })).toBe(true);
    for (const name of ['citations', 'claudeCitations', 'groundedness', 'feedback'] as const) {
      expect(shouldPersistAnswer({ ...base, config: { ...ALL_OFF, [name]: true } })).toBe(true);
    }
  });

  it('is false when any one condition is missing', () => {
    expect(shouldPersistAnswer({ ...base, capabilities: null })).toBe(false);
    expect(shouldPersistAnswer({ ...base, capabilities: { citations: false } })).toBe(false);
    expect(shouldPersistAnswer({ ...base, userId: null })).toBe(false);
    expect(shouldPersistAnswer({ ...base, userId: '' })).toBe(false);
    expect(shouldPersistAnswer({ ...base, chatId: 'ghost-1234' })).toBe(false);
    expect(shouldPersistAnswer({ ...base, config: ALL_OFF })).toBe(false);
  });
});

describe('mintAnswerId', () => {
  it('returns a fresh v4 UUID each call', () => {
    const a = mintAnswerId();
    const b = mintAnswerId();
    expect(a).toMatch(UUID_RE);
    expect(b).toMatch(UUID_RE);
    expect(a).not.toBe(b);
  });
});

describe('scheduleAnswerFinish', () => {
  let errors: ReturnType<typeof vi.spyOn>;
  let warnings: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function logged(): string[] {
    return [...errors.mock.calls, ...warnings.mock.calls].map((call) => call.map((part: unknown) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  }

  it('inserts exactly one row after the response, with the full citations and no query text', async () => {
    const h = harness();
    const long = 'x'.repeat(1500);
    const answer = input({ citations: [quote(long)] });
    scheduleAnswerFinish(answer, h.deps);
    expect(h.inserts).toHaveLength(0);
    expect(h.tasks).toHaveLength(1);
    await h.run();
    expect(h.inserts).toHaveLength(1);
    const row = h.inserts[0];
    expect(row).toMatchObject({
      id: answer.answerId,
      userId: USER,
      chatId: null,
      traceId: 'trace-1',
      modelId: 'test/model',
      ragMode: 'strict',
      citationStrategy: 'chunk-alias',
      invalidCitations: 2,
      answerLanguage: 'en',
    });
    expect(row.scope).toBe(answer.scope);
    expect(row.citations[0].quote).toHaveLength(1500);
    expect(JSON.stringify(row)).not.toContain('What is the refund window?');
  });

  it('ignores a second call for the same answerId', async () => {
    const h = harness();
    const answer = input();
    scheduleAnswerFinish(answer, h.deps);
    scheduleAnswerFinish(answer, h.deps);
    await h.run();
    expect(h.inserts).toHaveLength(1);
  });

  it('links a chat owned by the user in the same organization', async () => {
    const h = harness({ chat: { id: CHAT, user_id: USER, organization_id: ORG } });
    scheduleAnswerFinish(input({ chatId: CHAT, scope: mintScope('org', USER, ORG) }), h.deps);
    await h.run();
    expect(h.inserts[0].chatId).toBe(CHAT);
    expect(h.admin.lookups).toEqual([{ table: 'chats', filters: [['id', CHAT], ['user_id', USER]] }]);
  });

  it('links a single-tenant chat with no organization', async () => {
    const h = harness({ chat: { id: CHAT, user_id: USER, organization_id: null } });
    scheduleAnswerFinish(input({ chatId: CHAT }), h.deps);
    await h.run();
    expect(h.inserts[0].chatId).toBe(CHAT);
  });

  it('stores null for a chat owned by another user', async () => {
    const h = harness({ chat: { id: CHAT, user_id: OTHER_USER, organization_id: null } });
    scheduleAnswerFinish(input({ chatId: CHAT }), h.deps);
    await h.run();
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0].chatId).toBeNull();
  });

  it('stores null for a chat in another organization or outside the personal scope', async () => {
    const other = harness({ chat: { id: CHAT, user_id: USER, organization_id: OTHER_ORG } });
    scheduleAnswerFinish(input({ chatId: CHAT, scope: mintScope('org', USER, ORG) }), other.deps);
    await other.run();
    expect(other.inserts[0].chatId).toBeNull();

    const orgChatPersonalScope = harness({ chat: { id: CHAT, user_id: USER, organization_id: ORG } });
    scheduleAnswerFinish(input({ chatId: CHAT, scope: mintScope('personal', USER, null) }), orgChatPersonalScope.deps);
    await orgChatPersonalScope.run();
    expect(orgChatPersonalScope.inserts[0].chatId).toBeNull();

    const personalChatOrgScope = harness({ chat: { id: CHAT, user_id: USER, organization_id: null } });
    scheduleAnswerFinish(input({ chatId: CHAT, scope: mintScope('org', USER, ORG) }), personalChatOrgScope.deps);
    await personalChatOrgScope.run();
    expect(personalChatOrgScope.inserts[0].chatId).toBeNull();
  });

  it('stores null without a lookup for a chat id that is not a UUID', async () => {
    const h = harness({ chat: { id: CHAT, user_id: USER, organization_id: null } });
    scheduleAnswerFinish(input({ chatId: 'chat-123' }), h.deps);
    await h.run();
    expect(h.inserts[0].chatId).toBeNull();
    expect(h.admin.lookups).toHaveLength(0);
  });

  it('stores null and logs one [Answer Record] line without text when the lookup fails', async () => {
    const h = harness({ lookupError: { code: 'PGRST301' } });
    const answer = input({ chatId: CHAT });
    scheduleAnswerFinish(answer, h.deps);
    await h.run();
    expect(h.inserts[0].chatId).toBeNull();
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[Answer Record]');
    expect(lines[0]).not.toContain(answer.answerText);
    expect(lines[0]).not.toContain(answer.queryText);
    expect(lines[0]).not.toContain('Refunds');
  });

  it('marks groundedness pending when the switch is on and the turn is eligible, and calls the scoring hook', async () => {
    const h = harness({ groundedness: true });
    const answer = input();
    scheduleAnswerFinish(answer, h.deps);
    await h.run();
    expect(h.inserts[0].groundedness).toEqual({ status: 'pending' });
    expect(h.pending).toEqual([answer.answerId]);
  });

  it('marks an aborted stream not_checked/aborted', async () => {
    const h = harness({ groundedness: true });
    scheduleAnswerFinish(input({ aborted: true }), h.deps);
    await h.run();
    expect(h.inserts[0].groundedness).toEqual({ status: 'not_checked', label: 'not_checked', reason: 'aborted' });
    expect(h.pending).toEqual([]);
  });

  it('marks the switch off as not_checked/disabled', async () => {
    const h = harness({ groundedness: false });
    scheduleAnswerFinish(input(), h.deps);
    await h.run();
    expect(h.inserts[0].groundedness).toEqual({ status: 'not_checked', label: 'not_checked', reason: 'disabled' });
    expect(h.pending).toEqual([]);
  });

  it('marks an ineligible turn not_checked/not_eligible and a tool-output turn not_checked/tool_output', async () => {
    const ineligible = harness({ groundedness: true });
    scheduleAnswerFinish(input({ groundednessEligible: false }), ineligible.deps);
    await ineligible.run();
    expect(ineligible.inserts[0].groundedness).toEqual({ status: 'not_checked', label: 'not_checked', reason: 'not_eligible' });

    const tool = harness({ groundedness: true });
    scheduleAnswerFinish(input({ toolOutputUsed: true }), tool.deps);
    await tool.run();
    expect(tool.inserts[0].groundedness).toEqual({ status: 'not_checked', label: 'not_checked', reason: 'tool_output' });
    expect(tool.pending).toEqual([]);
  });

  it('never throws into the caller and logs one line with the answerId and error code only on an insert error', async () => {
    const h = harness({ insertError: new AnswerStoreError('insert', '23503'), groundedness: true });
    const answer = input();
    expect(() => scheduleAnswerFinish(answer, h.deps)).not.toThrow();
    await expect(h.run()).resolves.toBeUndefined();
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[[A-Za-z ]+\]/);
    expect(lines[0]).toContain(answer.answerId);
    expect(lines[0]).toContain('23503');
    expect(lines[0]).not.toContain('Refunds');
    expect(h.pending).toEqual([]);
  });

  it('swallows a throwing scheduler, admin factory or hook', async () => {
    const throwingScheduler = harness();
    throwingScheduler.deps.schedule = () => {
      throw new Error('no request scope');
    };
    expect(() => scheduleAnswerFinish(input(), throwingScheduler.deps)).not.toThrow();

    const noAdmin = harness();
    noAdmin.deps.admin = () => {
      throw new Error('admin unavailable');
    };
    scheduleAnswerFinish(input(), noAdmin.deps);
    await expect(noAdmin.run()).resolves.toBeUndefined();
    expect(noAdmin.inserts).toHaveLength(0);

    const badHook = harness({ groundedness: true });
    badHook.deps.onPending = async () => {
      throw new Error('scorer down');
    };
    scheduleAnswerFinish(input(), badHook.deps);
    await expect(badHook.run()).resolves.toBeUndefined();
    expect(badHook.inserts).toHaveLength(1);
  });
});
