import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewQueueItemSchema } from '@/lib/rag-eval/contracts.generated';
import { adminClient, newAnswerDb, type AnswerDbState, type Row } from '../helpers/answer-db-fake';

const ADMIN = '00000000-0000-4000-8000-0000000021e1';
const PLAIN = '00000000-0000-4000-8000-0000000021e2';
const OTHER = '00000000-0000-4000-8000-0000000021e3';
const ORG_ONE = '00000000-0000-4000-8000-0000000021f1';
const ORG_TWO = '00000000-0000-4000-8000-0000000021f2';
const TOKEN = 'admin-access-token-placeholder';
const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-30T00:00:00.000Z';
const QUESTION = 'What is the refund window? Mail jane.doe@example.com';
const ANSWER = 'Thirty days, call +39 333 123 4567.';
const QUOTE = 'Refunds within thirty days; escalate to second.marker@example.org.';

let db: AnswerDbState;
let authThrows = false;

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (authThrows) throw new Error('auth down');
          return { data: { user: db.session }, error: null };
        },
      },
    }),
  }));
  const admin = adminClient(db);
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: admin, getSupabaseAdmin: () => admin, getSupabase: () => ({}) }));
  return import('@/app/api/rag/admin/review-candidates/route');
}

function record(over: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    user_id: PLAIN,
    organization_id: null,
    chat_id: null,
    trace_id: crypto.randomBytes(16).toString('hex'),
    model_id: 'placeholder/model',
    citation_strategy: 'chunk-alias',
    rag_mode: 'strict',
    answer_language: 'en',
    invalid_citations: 0,
    citations: [{ n: 1, alias: 'S1', chunkIds: ['c1'], documentId: 'd1', documentName: 'refunds.md', documentVersion: 1, page: null, sectionPath: null, quote: QUOTE, quoteHash: 'a'.repeat(64), strategy: 'chunk-alias' }],
    groundedness: { status: 'scored', label: 'possibly_unreliable', truncated: false },
    feedback: null,
    review_reasons: ['feedback_negative'],
    created_at: '2026-11-10T10:00:00.000Z',
    updated_at: '2026-11-10T10:00:05.000Z',
    ...over,
  };
}

function chatFor(row: Row, over: Row = {}): Row {
  const id = crypto.randomUUID();
  row.chat_id = id;
  return {
    id,
    user_id: row.user_id,
    organization_id: row.organization_id,
    messages: [
      { role: 'user', content: QUESTION },
      { role: 'assistant', content: ANSWER, metadata: { answerId: row.id } },
    ],
    ...over,
  };
}

function get(query: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/rag/admin/review-candidates${query}`, { method: 'GET', headers });
}

const WINDOW = `?from=${FROM}&to=${TO}`;
const dataReads = () => db.queries.filter((q) => q.table === 'rag_answer_records' || q.table === 'chats').length + db.rpcs.length;

describe('GET /api/rag/admin/review-candidates', () => {
  beforeEach(() => {
    db = newAnswerDb();
    db.tables.admin_users = [{ id: ADMIN }];
    db.tokens[TOKEN] = ADMIN;
    db.rpcResults.rag_admin_tenant_keys = { data: ['s:default'], error: null };
    authThrows = false;
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
  });

  it('runs the admin guard first: 401 without a credential, a forged cookie or a literal Bearer admin, 403 for a non-admin, 503 when the lookup fails', async () => {
    db.tables.rag_answer_records.push(record());
    const route = await loadRoute();
    expect((await route.GET(get(WINDOW))).status).toBe(401);
    expect((await route.GET(get(WINDOW, { cookie: 'admin_session=forged-value' }))).status).toBe(401);
    expect((await route.GET(get(WINDOW, { authorization: 'Bearer admin' }))).status).toBe(401);
    expect((await route.GET(get(WINDOW, { authorization: 'Bearer not-a-real-token' }))).status).toBe(401);
    db.session = { id: PLAIN };
    expect((await route.GET(get(WINDOW))).status).toBe(403);
    db.session = { id: ADMIN };
    db.failSelects = ['admin_users'];
    expect((await route.GET(get(WINDOW))).status).toBe(503);
    db.session = null;
    authThrows = true;
    expect((await route.GET(get(WINDOW))).status).toBe(503);
    expect(dataReads()).toBe(0);
  });

  it('answers 400 for a missing, malformed or reversed window', async () => {
    db.session = { id: ADMIN };
    const route = await loadRoute();
    for (const query of ['', `?from=${FROM}`, `?from=yesterday&to=${TO}`, `?from=${TO}&to=${FROM}`]) {
      const response = await route.GET(get(query));
      expect(response.status).toBe(400);
      expect((await response.json()).success).toBe(false);
    }
    expect(db.queries.filter((q) => q.table === 'rag_answer_records')).toHaveLength(0);
  });

  it('returns masked ReviewQueueItem entries for flagged records in the window, with reasons, read from the chat row', async () => {
    const flagged = record({ review_reasons: ['feedback_negative', 'groundedness_flagged'], answer_language: 'zh-Hans' });
    const unlinked = record({ review_reasons: ['groundedness_flagged'], updated_at: '2026-11-20T08:00:00.000Z' });
    const clean = record({ review_reasons: [] });
    const outside = record({ updated_at: '2026-12-02T00:00:00.000Z' });
    db.tables.rag_answer_records.push(flagged, unlinked, clean, outside);
    db.tables.chats.push(chatFor(flagged));
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const response = await route.GET(get(WINDOW, { authorization: `Bearer ${TOKEN}` }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = (await response.json()) as { items: unknown[] };
    const items = body.items.map((item) => ReviewQueueItemSchema.parse(item));
    expect(items.map((item) => item.observation_id).sort()).toEqual([String(flagged.id), String(unlinked.id)].sort());

    const first = items.find((item) => item.observation_id === flagged.id)!;
    expect(first).toMatchObject({
      trace_id: flagged.trace_id,
      tenant_key: 's:default',
      model: 'placeholder/model',
      language: 'zh',
      reasons: ['feedback_negative', 'groundedness_flagged'],
      captured_at: '2026-11-10T10:00:05.000Z',
    });
    expect(first.tags).toEqual(expect.arrayContaining(['review_candidate', 'review:feedback_negative', 'review:groundedness_flagged']));
    expect(first.query_masked).toBe('What is the refund window? Mail [EMAIL]');
    expect(first.answer_masked).toBe('Thirty days, call [PHONE].');
    expect(first.context_masked).toContain('[EMAIL]');
    const second = items.find((item) => item.observation_id === unlinked.id)!;
    expect(second.query_masked).toBe('');
    expect(second.answer_masked).toBe('');
    const text = JSON.stringify(body);
    for (const raw of ['jane.doe', '333 123', 'second.marker']) expect(text).not.toContain(raw);
    expect(db.rpcs).toEqual([{ name: 'rag_admin_tenant_keys', args: { p_actor: ADMIN } }]);
  });

  it('in multi-tenant mode returns only the records of the tenants the admin administers, as resolved in SQL', async () => {
    db.rpcResults.rag_admin_tenant_keys = { data: [`u:${ADMIN}`, `o:${ORG_ONE}`], error: null };
    const personal = record({ user_id: ADMIN });
    const orgOne = record({ user_id: OTHER, organization_id: ORG_ONE });
    const orgTwo = record({ user_id: ADMIN, organization_id: ORG_TWO });
    const othersPersonal = record({ user_id: OTHER });
    db.tables.rag_answer_records.push(personal, orgOne, orgTwo, othersPersonal);
    const foreignChat = chatFor(orgTwo);
    db.tables.chats.push(foreignChat, chatFor(othersPersonal));
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const body = (await (await route.GET(get(WINDOW))).json()) as { items: Array<{ observation_id: string; tenant_key: string }> };
    expect(body.items.map((item) => [item.observation_id, item.tenant_key]).sort()).toEqual(
      [
        [String(personal.id), `u:${ADMIN}`],
        [String(orgOne.id), `o:${ORG_ONE}`],
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('refund window');
  });

  it('never reads a query or answer from a chat row of another user', async () => {
    const flagged = record();
    const chat = chatFor(flagged, { user_id: OTHER });
    db.tables.rag_answer_records.push(flagged);
    db.tables.chats.push(chat);
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const body = (await (await route.GET(get(WINDOW))).json()) as { items: Array<{ query_masked: string; answer_masked: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ query_masked: '', answer_masked: '' });
  });

  it('answers 503 without data when the tenant resolution or the read fails', async () => {
    db.tables.rag_answer_records.push(record());
    db.session = { id: ADMIN };
    db.rpcResults.rag_admin_tenant_keys = { data: null, error: { code: 'P0001', message: 'not_admin' } };
    const route = await loadRoute();
    const denied = await route.GET(get(WINDOW));
    expect(denied.status).toBe(503);
    expect(Object.keys(await denied.json())).not.toContain('items');
    db.rpcResults.rag_admin_tenant_keys = { data: ['s:default'], error: null };
    db.failSelects = ['rag_answer_records'];
    expect((await route.GET(get(WINDOW))).status).toBe(503);
  });
});
