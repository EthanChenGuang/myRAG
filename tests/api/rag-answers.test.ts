import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerRecordSchema } from '@/lib/rag-eval/contracts.generated';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const ORG = '00000000-0000-4000-8000-00000000d0a1';
const QUOTE_TEXT = 'Placeholder quote about the annual leave allowance';

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

const state = {
  session: null as { id: string } | null,
  authThrows: false,
  tables: {} as Record<string, Row[]>,
  sessionQueries: [] as Array<{ table: string; op: string }>,
  adminQueries: [] as Array<{ table: string; op: string; payload?: Row; filters: Array<[string, string, unknown]> }>,
};

function visibleToSession(table: string, row: Row): boolean {
  if (table === 'rag_answer_records' || table === 'chats') return row.user_id === state.session?.id;
  if (table === 'documents') return row.visible !== false;
  return true;
}

function builder(kind: 'session' | 'admin', table: string) {
  const filters: Filter[] = [];
  const described: Array<[string, string, unknown]> = [];
  let op: 'select' | 'update' = 'select';
  let payload: Row = {};
  let limit = Infinity;
  let order: { column: string; ascending: boolean } | null = null;
  const run = (): Row[] => {
    if (kind === 'session') state.sessionQueries.push({ table, op });
    else state.adminQueries.push({ table, op, payload: op === 'update' ? payload : undefined, filters: described });
    const rows = state.tables[table] ?? [];
    let hit = rows.filter((row) => (kind === 'admin' || visibleToSession(table, row)) && filters.every((filter) => filter(row)));
    if (op === 'update') {
      if (kind === 'session') throw new Error('session client must not write');
      hit.forEach((row) => Object.assign(row, payload));
    }
    if (order) {
      const { column, ascending } = order;
      hit = [...hit].sort((x, y) => String(x[column]).localeCompare(String(y[column])) * (ascending ? 1 : -1));
    }
    return hit.slice(0, limit).map((row) => structuredClone(row));
  };
  const b = {
    select: () => b,
    update(next: Row) {
      op = 'update';
      payload = next;
      return b;
    },
    eq(column: string, value: unknown) {
      described.push(['eq', column, value]);
      filters.push((row) => row[column] === value);
      return b;
    },
    is(column: string, value: null) {
      described.push(['is', column, value]);
      filters.push((row) => row[column] === null || row[column] === undefined);
      return b;
    },
    in(column: string, values: unknown[]) {
      described.push(['in', column, values]);
      filters.push((row) => values.includes(row[column]));
      return b;
    },
    order(column: string, options?: { ascending?: boolean }) {
      order = { column, ascending: options?.ascending !== false };
      return b;
    },
    limit(n: number) {
      limit = n;
      return b;
    },
    maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve()
        .then(() => ({ data: run(), error: null }))
        .then(onFulfilled, onRejected),
  };
  return b;
}

async function loadRoutes() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session }, error: state.session ? null : { message: 'no session' } };
        },
      },
      from: (table: string) => builder('session', table),
    }),
  }));
  const admin = { from: (table: string) => builder('admin', table) };
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: admin, getSupabaseAdmin: () => admin }));
  const one = await import('@/app/api/rag/answers/[answerId]/route');
  const list = await import('@/app/api/rag/answers/route');
  return { one, list };
}

function citation(n: number, documentId: string) {
  return {
    n,
    alias: `S${n}`,
    chunkIds: [`chunk-${n}`],
    documentId,
    documentName: `policy-${n}.md`,
    documentVersion: 1,
    page: n,
    sectionPath: ['Leave'],
    quote: `${QUOTE_TEXT} ${n}`,
    quoteHash: crypto.createHash('sha256').update(`q${n}`).digest('hex'),
    strategy: 'chunk-alias',
  };
}

function record(over: Row = {}): Row {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    user_id: USER_A,
    organization_id: null,
    chat_id: null,
    trace_id: 'trace-placeholder',
    model_id: 'placeholder/model',
    citation_strategy: 'chunk-alias',
    rag_mode: 'strict',
    answer_language: 'en',
    invalid_citations: 0,
    citations: [],
    groundedness: { status: 'pending', truncated: false },
    feedback: null,
    review_reasons: [],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function getOne(id: string) {
  return new NextRequest(`http://localhost/api/rag/answers/${id}`, { method: 'GET' });
}

function getList(query: string) {
  return new NextRequest(`http://localhost/api/rag/answers${query}`, { method: 'GET' });
}

const params = (answerId: string) => ({ params: Promise.resolve({ answerId }) });

describe('/api/rag/answers routes', () => {
  const logs: string[] = [];

  beforeEach(() => {
    state.session = { id: USER_A };
    state.authThrows = false;
    state.tables = { rag_answer_records: [], chats: [], documents: [], document_chunks: [] };
    state.sessionQueries = [];
    state.adminQueries = [];
    logs.length = 0;
    delete process.env.RAG_ANSWER_FEEDBACK;
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
    delete process.env.RAG_ANSWER_FEEDBACK;
  });

  it('answers 401 without a session on both routes', async () => {
    state.session = null;
    const { one, list } = await loadRoutes();
    const id = crypto.randomUUID();
    const single = await one.GET(getOne(id), params(id));
    expect(single.status).toBe(401);
    expect(await single.json()).toHaveProperty('error');
    const many = await list.GET(getList(`?chatId=${crypto.randomUUID()}`));
    expect(many.status).toBe(401);
    expect(await many.json()).toHaveProperty('error');
  });

  it('answers 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const { one } = await loadRoutes();
    const id = crypto.randomUUID();
    expect((await one.GET(getOne(id), params(id))).status).toBe(503);
  });

  it('answers 400 with structured details for a malformed id or chatId', async () => {
    const { one, list } = await loadRoutes();
    const bad = await one.GET(getOne('not-a-uuid'), params('not-a-uuid'));
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0]).toHaveProperty('path');
    for (const query of ['', '?chatId=nope']) {
      const response = await list.GET(getList(query));
      expect(response.status).toBe(400);
      expect((await response.json()).success).toBe(false);
    }
    expect(state.sessionQueries.filter((q) => q.table === 'rag_answer_records')).toHaveLength(0);
  });

  it("returns the caller's record validated by AnswerRecordSchema", async () => {
    const current = crypto.randomUUID();
    state.tables.documents.push({ id: current, is_current: true, status: 'ready' });
    const row = record({ citations: [citation(1, current)], chat_id: null });
    state.tables.rag_answer_records.push(row);
    const { one } = await loadRoutes();
    const response = await one.GET(getOne(String(row.id)), params(String(row.id)));
    expect(response.status).toBe(200);
    const body = AnswerRecordSchema.parse(await response.json());
    expect(body.answerId).toBe(row.id);
    expect(body.citations).toHaveLength(1);
    expect(body.groundedness.status).toBe('pending');
    expect(body.documents).toEqual({ [current]: 'current' });
    expect(body.feedbackEnabled).toBe(false);
    expect(state.adminQueries).toHaveLength(0);
  });

  it("answers an identical 404 for a missing record and another user's record, never 403", async () => {
    const foreign = record({ user_id: USER_B });
    state.tables.rag_answer_records.push(foreign);
    const { one } = await loadRoutes();
    const missingId = crypto.randomUUID();
    const missing = await one.GET(getOne(missingId), params(missingId));
    const other = await one.GET(getOne(String(foreign.id)), params(String(foreign.id)));
    expect(missing.status).toBe(404);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual(await missing.json());
  });

  it('reports a record pending for 120 s as not_checked/expired without writing', async () => {
    const old = record({ created_at: new Date(Date.now() - 121_000).toISOString() });
    const fresh = record({ created_at: new Date(Date.now() - 119_000).toISOString() });
    state.tables.rag_answer_records.push(old, fresh);
    const { one } = await loadRoutes();
    const expired = AnswerRecordSchema.parse(await (await one.GET(getOne(String(old.id)), params(String(old.id)))).json());
    expect(expired.groundedness).toMatchObject({ status: 'not_checked', label: 'not_checked', reason: 'expired' });
    const pending = AnswerRecordSchema.parse(await (await one.GET(getOne(String(fresh.id)), params(String(fresh.id)))).json());
    expect(pending.groundedness.status).toBe('pending');
    expect(state.adminQueries).toHaveLength(0);
    expect(state.sessionQueries.every((q) => q.op === 'select')).toBe(true);
    expect((old.groundedness as Row).status).toBe('pending');
  });

  it('maps cited documents to current or unavailable from documents rows only', async () => {
    const current = crypto.randomUUID();
    const superseded = crypto.randomUUID();
    const deleted = crypto.randomUUID();
    const hidden = crypto.randomUUID();
    const gone = crypto.randomUUID();
    state.tables.documents.push(
      { id: current, is_current: true, status: 'ready' },
      { id: superseded, is_current: false, status: 'ready' },
      { id: deleted, is_current: false, status: 'deleted' },
      { id: hidden, is_current: true, status: 'ready', visible: false },
    );
    const row = record({ citations: [current, superseded, deleted, hidden, gone, 'not-a-uuid'].map((id, index) => citation(index + 1, id)) });
    state.tables.rag_answer_records.push(row);
    const { one } = await loadRoutes();
    const body = AnswerRecordSchema.parse(await (await one.GET(getOne(String(row.id)), params(String(row.id)))).json());
    expect(body.documents).toEqual({
      [current]: 'current',
      [superseded]: 'unavailable',
      [deleted]: 'unavailable',
      [hidden]: 'unavailable',
      [gone]: 'unavailable',
      'not-a-uuid': 'unavailable',
    });
    expect([...state.sessionQueries, ...state.adminQueries].some((q) => q.table === 'document_chunks')).toBe(false);
  });

  it('mirrors RAG_ANSWER_FEEDBACK at call time', async () => {
    const row = record();
    state.tables.rag_answer_records.push(row);
    const { one } = await loadRoutes();
    expect((await (await one.GET(getOne(String(row.id)), params(String(row.id)))).json()).feedbackEnabled).toBe(false);
    process.env.RAG_ANSWER_FEEDBACK = 'true';
    expect((await (await one.GET(getOne(String(row.id)), params(String(row.id)))).json()).feedbackEnabled).toBe(true);
    process.env.RAG_ANSWER_FEEDBACK = 'false';
    expect((await (await one.GET(getOne(String(row.id)), params(String(row.id)))).json()).feedbackEnabled).toBe(false);
  });

  it('answers 500 with a generic error and logs no content when a stored record fails the schema', async () => {
    const row = record({ trace_id: null, citations: [citation(1, crypto.randomUUID())] });
    state.tables.rag_answer_records.push(row);
    const { one } = await loadRoutes();
    const response = await one.GET(getOne(String(row.id)), params(String(row.id)));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(JSON.stringify(body)).not.toContain(QUOTE_TEXT);
    expect(logs.some((line) => line.startsWith('[RAG Answers]'))).toBe(true);
    expect(logs.join('\n')).not.toContain(QUOTE_TEXT);
  });

  it("answers 404 for another user's chat and writes nothing", async () => {
    const chatId = crypto.randomUUID();
    const orphan = record({ user_id: USER_A });
    state.tables.chats.push({ id: chatId, user_id: USER_B, organization_id: null, messages: [{ role: 'assistant', metadata: { answerId: orphan.id } }] });
    state.tables.rag_answer_records.push(orphan);
    const { list } = await loadRoutes();
    const response = await list.GET(getList(`?chatId=${chatId}`));
    expect(response.status).toBe(404);
    const missing = await list.GET(getList(`?chatId=${crypto.randomUUID()}`));
    expect(await response.json()).toEqual(await missing.json());
    expect(state.adminQueries).toHaveLength(0);
    expect(orphan.chat_id).toBe(null);
  });

  it("attaches the caller's unlinked records listed in the chat, then returns every record of the chat", async () => {
    const chatId = crypto.randomUUID();
    const linked = record({ chat_id: chatId, organization_id: ORG, created_at: new Date(Date.now() - 5_000).toISOString() });
    const unlinked = record({ organization_id: ORG });
    const otherOrg = record({ organization_id: crypto.randomUUID() });
    const foreign = record({ user_id: USER_B, organization_id: ORG });
    const unlisted = record({ organization_id: ORG });
    state.tables.rag_answer_records.push(linked, unlinked, otherOrg, foreign, unlisted);
    state.tables.chats.push({
      id: chatId,
      user_id: USER_A,
      organization_id: ORG,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', metadata: { answerId: linked.id } },
        { role: 'assistant', metadata: { answerId: unlinked.id } },
        { role: 'assistant', metadata: { answerId: otherOrg.id } },
        { role: 'assistant', metadata: { answerId: foreign.id } },
      ],
    });
    const { list } = await loadRoutes();
    const response = await list.GET(getList(`?chatId=${chatId}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { records: unknown[] };
    const records = body.records.map((item) => AnswerRecordSchema.parse(item));
    expect(records.map((item) => item.answerId)).toEqual([linked.id, unlinked.id]);
    expect(records.every((item) => item.chatId === chatId)).toBe(true);

    const attach = state.adminQueries.filter((q) => q.op === 'update');
    expect(attach).toHaveLength(1);
    expect(attach[0]?.payload?.chat_id).toBe(chatId);
    expect(attach[0]?.filters).toEqual(
      expect.arrayContaining([
        ['in', 'id', [linked.id, unlinked.id, otherOrg.id, foreign.id]],
        ['eq', 'user_id', USER_A],
        ['is', 'chat_id', null],
        ['eq', 'organization_id', ORG],
      ]),
    );
    expect(state.adminQueries.every((q) => q.table === 'rag_answer_records')).toBe(true);
    expect(otherOrg.chat_id).toBe(null);
    expect(foreign.chat_id).toBe(null);
    expect(unlisted.chat_id).toBe(null);
    expect(state.sessionQueries.some((q) => q.table === 'chats' && q.op !== 'select')).toBe(false);
  });

  it('returns an empty list for an owned chat without answers and makes no write', async () => {
    const chatId = crypto.randomUUID();
    state.tables.chats.push({ id: chatId, user_id: USER_A, organization_id: null, messages: [] });
    const { list } = await loadRoutes();
    const response = await list.GET(getList(`?chatId=${chatId}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ records: [] });
    expect(state.adminQueries).toHaveLength(0);
  });
});
