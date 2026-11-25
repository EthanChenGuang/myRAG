import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFixtureDatabase } from '../../../eval/harness/pglite-supabase.mts';
import { ReviewItemSchema } from '@/lib/rag-eval/contracts.generated';
import { getReviewItem, listReviewItems, REVIEW_PAGE_SIZE } from '@/lib/rag/feedback-loop/review-access';
import { maskPII } from '@/lib/rag/trace/mask';
import { pgliteClient } from '../../helpers/pglite-rest-client';

type Row = Record<string, unknown>;

const EXPERT_A = '00000000-0000-4000-8000-0000000051a1';
const EXPERT_B = '00000000-0000-4000-8000-0000000051b1';
const ASKER = '00000000-0000-4000-8000-0000000051c1';
const TENANT_A = 'o:00000000-0000-4000-8000-0000000051f1';
const TENANT_B = 'o:00000000-0000-4000-8000-0000000051f2';
const ANSWER = 'The sample widget is described in section two; contact sample.person@example.org for more.';

let db: PGlite;
let calls: string[];

function clients(userId: string | null) {
  calls = [];
  return {
    ssr: pgliteClient(db, { role: 'authenticated', userId, label: 'ssr', calls }) as unknown as SupabaseClient,
    admin: pgliteClient(db, { role: 'service_role', label: 'admin', calls }) as unknown as SupabaseClient,
  };
}

async function insertItem(row: Row = {}): Promise<string> {
  const values: Row = {
    tenant_key: TENANT_A,
    trace_id: crypto.randomUUID(),
    query_masked: 'A synthetic question about the sample topic',
    query_fingerprint: crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'),
    channel: 'chat',
    outcome: 'answered',
    reasons: ['low_score'],
    mining_window: '2026-11-23T00:00:00Z',
    ...row,
  };
  const names = Object.keys(values);
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    names.map((name) => values[name]),
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
  for (const id of [EXPERT_A, EXPERT_B, ASKER]) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(-4)}@example.invalid`]);
  }
  await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($3, $4)', [TENANT_A, EXPERT_A, TENANT_B, EXPERT_B]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM rag_review_items');
  await db.query('DELETE FROM chats');
  calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listReviewItems', () => {
  it("returns only the caller's tenant items, newest first, each valid against ReviewItemSchema, through the SSR client", async () => {
    const a1 = await insertItem({ mined_at: '2026-11-20T10:00:00Z' });
    const a2 = await insertItem({ mined_at: '2026-11-21T10:00:00Z' });
    await insertItem({ tenant_key: TENANT_B });
    const { ssr } = clients(EXPERT_A);
    const result = await listReviewItems(ssr, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.items.map((item) => item.id)).toEqual([a2, a1]);
    for (const item of result.items) expect(ReviewItemSchema.safeParse(item).success).toBe(true);
    expect(result.next_cursor).toBeNull();
    expect(calls).toEqual(['ssr:rag_review_items']);
  });

  it('filters by status, reason and language', async () => {
    const open = await insertItem({ reasons: ['feedback_negative', 'low_score'], query_language: 'it' });
    await insertItem({ status: 'skipped', reasons: ['zero_results'], query_language: 'en' });
    const { ssr } = clients(EXPERT_A);
    const ids = async (query: Parameters<typeof listReviewItems>[1]) => {
      const result = await listReviewItems(ssr, query);
      return result.ok ? result.items.map((item) => item.id) : null;
    };
    expect(await ids({ status: 'open' })).toEqual([open]);
    expect(await ids({ reason: 'feedback_negative' })).toEqual([open]);
    expect(await ids({ reason: 'refusal_disputed' })).toEqual([]);
    expect(await ids({ language: 'it' })).toEqual([open]);
  });

  it('caps a page at 50 and pages through ties on mined_at with the opaque cursor', async () => {
    const minedAt = '2026-11-22T08:00:00.123456Z';
    const inserted: string[] = [];
    for (let i = 0; i < REVIEW_PAGE_SIZE + 7; i += 1) inserted.push(await insertItem({ mined_at: minedAt }));
    const { ssr } = clients(EXPERT_A);
    const first = await listReviewItems(ssr, {});
    expect(first.ok && first.items.length).toBe(REVIEW_PAGE_SIZE);
    if (!first.ok || !first.next_cursor) throw new Error('expected a cursor');
    expect(first.next_cursor.length).toBeLessThanOrEqual(256);
    const second = await listReviewItems(ssr, { cursor: first.next_cursor });
    if (!second.ok) throw new Error('expected a page');
    expect(second.items).toHaveLength(7);
    expect(second.next_cursor).toBeNull();
    const seen = [...first.items, ...second.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...inserted].sort());
  });

  it('refuses a cursor it did not issue', async () => {
    const { ssr } = clients(EXPERT_A);
    expect(await listReviewItems(ssr, { cursor: 'not-a-cursor' })).toEqual({ ok: false, reason: 'invalid_cursor' });
    const forged = Buffer.from(JSON.stringify(["2026-01-01T00:00:00Z' OR 1=1", crypto.randomUUID()])).toString('base64url');
    expect(await listReviewItems(ssr, { cursor: forged })).toEqual({ ok: false, reason: 'invalid_cursor' });
  });

  it('returns tags exactly as stored (D-29) and the D-03a language snapshot unchanged', async () => {
    const mined = await insertItem({
      query_language: 'zh',
      query_language_confidence: 0.75,
      answer_language: 'en',
      chunk_languages: ['en', 'it'],
      mined_at: '2026-11-20T00:00:00Z',
    });
    const tagged = await insertItem({ mined_at: '2026-11-21T00:00:00Z' });
    await db.query("UPDATE rag_review_items SET tags = ARRAY['representative'] WHERE id = $1", [tagged]);
    const { ssr, admin } = clients(EXPERT_A);
    const result = await listReviewItems(ssr, {});
    if (!result.ok) throw new Error('expected items');
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get(tagged)?.tags).toEqual(['representative']);
    expect(byId.get(mined)?.tags).toEqual([]);
    expect(byId.get(mined)).toMatchObject({ query_language: 'zh', query_language_confidence: 0.75, answer_language: 'en', chunk_languages: ['en', 'it'] });
    const detail = await getReviewItem(ssr, admin, tagged);
    expect(detail.ok && detail.item.tags).toEqual(['representative']);
  });
});

describe('getReviewItem', () => {
  async function chatItem(messages: unknown[], over: Row = {}): Promise<{ id: string; traceId: string }> {
    const chatId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    await db.query('INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, $3, $4::jsonb)', [
      chatId,
      over.chat_owner ?? ASKER,
      'Synthetic chat',
      JSON.stringify(messages.map((m) => JSON.parse(JSON.stringify(m).replaceAll('__TRACE__', traceId)))),
    ]);
    const rest = Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'chat_owner'));
    const id = await insertItem({ chat_id: chatId, user_id: ASKER, trace_id: traceId, ...rest });
    return { id, traceId };
  }

  it("returns the masked answer of the linked chat's assistant message for the item's trace id, read after the RLS read", async () => {
    const { id } = await chatItem([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'an unrelated earlier answer', metadata: { ragTraceId: 'other-trace' } },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }], metadata: { ragTraceId: '__TRACE__' } },
    ]);
    const { ssr, admin } = clients(EXPERT_A);
    const result = await getReviewItem(ssr, admin, id);
    if (!result.ok) throw new Error('expected the item');
    expect(result.item.answer_masked).toBe(maskPII(ANSWER));
    expect(result.item.answer_masked).not.toContain('sample.person@example.org');
    expect(ReviewItemSchema.safeParse(result.item).success).toBe(true);
    expect(calls[0]).toBe('ssr:rag_review_items');
    expect(calls.filter((c) => c.endsWith(':rag_review_items')).every((c) => c.startsWith('ssr:'))).toBe(true);
    expect(calls).toContain('admin:chats');
  });

  it('returns answer null for an item without a chat, a chat of another user or no matching message', async () => {
    const plain = await insertItem();
    const foreign = await chatItem([{ role: 'assistant', content: ANSWER, metadata: { ragTraceId: '__TRACE__' } }], { chat_owner: EXPERT_B });
    const unmatched = await chatItem([{ role: 'assistant', content: ANSWER, metadata: { ragTraceId: 'other' } }]);
    const { ssr, admin } = clients(EXPERT_A);
    for (const id of [plain, foreign.id, unmatched.id]) {
      const result = await getReviewItem(ssr, admin, id);
      expect(result.ok && result.item.answer_masked).toBeNull();
    }
    expect(calls.filter((c) => c.startsWith('admin:')).every((c) => c === 'admin:chats' || c === 'admin:rag_retrieval_log')).toBe(true);
  });

  it("is not_found for another tenant's item and for a missing id, and then issues no admin query", async () => {
    const other = await insertItem({ tenant_key: TENANT_B });
    const { ssr, admin } = clients(EXPERT_A);
    expect(await getReviewItem(ssr, admin, other)).toEqual({ ok: false, reason: 'not_found' });
    expect(await getReviewItem(ssr, admin, crypto.randomUUID())).toEqual({ ok: false, reason: 'not_found' });
    expect(calls.every((c) => c.startsWith('ssr:'))).toBe(true);
  });
});

describe('review list and item routes', () => {
  const session: { userId: string | null } = { userId: null };

  async function loadRoutes() {
    vi.resetModules();
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => clients(session.userId).ssr }));
    vi.doMock('@/lib/supabase', () => ({
      getSupabaseAdmin: () => pgliteClient(db, { role: 'service_role', label: 'admin', calls }),
      getSupabase: () => ({}),
    }));
    const list = await import('@/app/api/rag/review/items/route');
    const item = await import('@/app/api/rag/review/items/[id]/route');
    return { list, item };
  }

  const get = (url: string) => new NextRequest(`http://localhost${url}`);
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  beforeEach(() => {
    session.userId = null;
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers 404 while RAG_DOMAIN_EXPERT_REVIEW is off, even for an expert', async () => {
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'false');
    session.userId = EXPERT_A;
    const id = await insertItem();
    const { list, item } = await loadRoutes();
    expect((await list.GET(get('/api/rag/review/items'))).status).toBe(404);
    expect((await item.GET(get(`/api/rag/review/items/${id}`), params(id))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('answers 401 without a session', async () => {
    const id = await insertItem();
    const { list, item } = await loadRoutes();
    expect((await list.GET(get('/api/rag/review/items'))).status).toBe(401);
    expect((await item.GET(get(`/api/rag/review/items/${id}`), params(id))).status).toBe(401);
  });

  it('lists with the query filters only, rejects unknown parameters such as a tag filter, and returns one item', async () => {
    session.userId = EXPERT_A;
    const id = await insertItem({ reasons: ['feedback_negative'] });
    const { list, item } = await loadRoutes();
    const res = await list.GET(get('/api/rag/review/items?status=open&reason=feedback_negative&language=en'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], next_cursor: null });
    const all = await (await list.GET(get('/api/rag/review/items'))).json();
    expect(all.items.map((entry: { id: string }) => entry.id)).toEqual([id]);
    expect((await list.GET(get('/api/rag/review/items?tag=representative'))).status).toBe(400);
    expect((await list.GET(get('/api/rag/review/items?status=exportedx'))).status).toBe(400);
    expect((await list.GET(get('/api/rag/review/items?cursor=abc'))).status).toBe(400);
    const one = await item.GET(get(`/api/rag/review/items/${id}`), params(id));
    expect(one.status).toBe(200);
    const body = await one.json();
    expect(ReviewItemSchema.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('chat_id');
  });

  it('gives the same 404 body for a missing, malformed and other-tenant id', async () => {
    session.userId = EXPERT_A;
    const other = await insertItem({ tenant_key: TENANT_B });
    const { item } = await loadRoutes();
    const bodies = [];
    for (const id of [other, crypto.randomUUID(), 'not-a-uuid']) {
      const res = await item.GET(get(`/api/rag/review/items/${id}`), params(id));
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
  });
});
