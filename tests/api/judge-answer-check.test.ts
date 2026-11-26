import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteClient } from '../helpers/pglite-rest-client';
import { CHUNK_A, CHUNK_B, DOC_A, DOC_B, EXPERT_A, OWNER_A, OWNER_B, TENANT_A, TENANT_B, candidate, createReviewFixture } from '../helpers/review-fixture';

const ANSWER_A = 'A synthetic answer: the sample component restarts every night.';
const ANSWER_B = 'A synthetic answer of tenant bravo that alpha must never read.';

let db: PGlite;
const calls: string[] = [];
const session: { userId: string | null } = { userId: null };
let answeredA: string;
let answeredB: string;
let noAnswerA: string;
let exportedA: string;

async function chatItem(tenantKey: string, owner: string, chunkId: string, documentId: string, answer: string): Promise<string> {
  const chatId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  await db.query('INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, $3, $4::jsonb)', [
    chatId,
    owner,
    'Synthetic chat',
    JSON.stringify([
      { role: 'user', content: 'A synthetic question' },
      { role: 'assistant', content: answer, metadata: { ragTraceId: traceId } },
    ]),
  ]);
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, trace_id, query_masked, query_fingerprint, channel, outcome, reasons, candidates, mining_window, chat_id, user_id)
     VALUES ($1, $2, 'A synthetic question', $3, 'chat', 'answered', ARRAY['low_score'], $4::jsonb, '2026-11-23T00:00:00Z', $5, $6) RETURNING id`,
    [tenantKey, traceId, crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'), JSON.stringify([candidate(chunkId, documentId, 1)]), chatId, owner],
  );
  return result.rows[0].id;
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => pgliteClient(db, { role: 'authenticated', userId: session.userId, label: 'ssr', calls }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => pgliteClient(db, { role: 'service_role', label: 'admin', calls }),
    getSupabase: () => ({}),
  }));
  return import('@/app/api/rag/review/items/[id]/answer-check/route');
}

const url = (id: string) => `http://localhost/api/rag/review/items/${id}/answer-check`;
const get = (id: string) => new NextRequest(url(id));
const post = (id: string, body: unknown) =>
  new NextRequest(url(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function labelCount(itemId?: string): Promise<number> {
  const result = itemId
    ? await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_judge_labels WHERE review_item_id = $1', [itemId])
    : await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_judge_labels');
  return result.rows[0].n;
}

beforeAll(async () => {
  ({ db } = await createReviewFixture());
  answeredA = await chatItem(TENANT_A, OWNER_A, CHUNK_A, DOC_A, ANSWER_A);
  answeredB = await chatItem(TENANT_B, OWNER_B, CHUNK_B, DOC_B, ANSWER_B);
  exportedA = await chatItem(TENANT_A, OWNER_A, CHUNK_A, DOC_A, ANSWER_A);
  await db.query("UPDATE rag_review_items SET status = 'exported' WHERE id = $1", [exportedA]);
  const plain = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, trace_id, query_masked, query_fingerprint, channel, outcome, reasons, candidates, mining_window)
     VALUES ($1, $2, 'A synthetic question', $3, 'voice', 'answered', ARRAY['low_score'], '[]'::jsonb, '2026-11-23T00:00:00Z') RETURNING id`,
    [TENANT_A, crypto.randomUUID(), crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex')],
  );
  noAnswerA = plain.rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  calls.length = 0;
  session.userId = null;
  vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  vi.stubEnv('MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await db.query('DELETE FROM rag_judge_labels');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('answer check for domain experts (D-31, D-55)', () => {
  it("lets A's expert save, read and update the three verdicts of A's item", async () => {
    session.userId = EXPERT_A;
    const route = await loadRoute();

    const empty = await route.GET(get(answeredA), params(answeredA));
    expect(empty.status).toBe(200);
    expect(empty.headers.get('cache-control')).toBe('no-store');
    expect(await empty.json()).toEqual({ supported: null, relevant: null, unsupported_content: null, labelled_at: null });

    const saved = await route.POST(post(answeredA, { supported: true, relevant: true, unsupported_content: false }), params(answeredA));
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).toMatchObject({ supported: true, relevant: true, unsupported_content: false });
    expect(typeof body.labelled_at).toBe('string');
    expect(Object.keys(body).sort()).toEqual(['labelled_at', 'relevant', 'supported', 'unsupported_content']);

    const read = await (await route.GET(get(answeredA), params(answeredA))).json();
    expect(read).toEqual(body);

    const updated = await route.POST(post(answeredA, { supported: false, relevant: true, unsupported_content: true }), params(answeredA));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ supported: false, relevant: true, unsupported_content: true });
    expect(await labelCount(answeredA)).toBe(1);
    const stored = await db.query<{ tenant_key: string; labelled_by: string }>('SELECT tenant_key, labelled_by FROM rag_judge_labels');
    expect(stored.rows).toEqual([{ tenant_key: TENANT_A, labelled_by: EXPERT_A }]);
  });

  it("gives A's expert the foreign-item 404 for B's item and writes no label", async () => {
    session.userId = EXPERT_A;
    const route = await loadRoute();
    const foreignGet = await route.GET(get(answeredB), params(answeredB));
    expect(foreignGet.status).toBe(404);
    const missing = await route.GET(get(crypto.randomUUID()), params(crypto.randomUUID()));
    expect(await foreignGet.json()).toEqual(await missing.json());

    const foreignPost = await route.POST(post(answeredB, { supported: true, relevant: true, unsupported_content: false }), params(answeredB));
    expect(foreignPost.status).toBe(404);
    const text = JSON.stringify(await foreignPost.json());
    expect(text).not.toContain(ANSWER_B);
    expect(text).not.toContain(TENANT_B);
    expect(await labelCount()).toBe(0);
  });

  it('answers 403 to a signed-in user who is no expert and 401 without a session', async () => {
    session.userId = OWNER_A;
    let route = await loadRoute();
    expect((await route.GET(get(answeredA), params(answeredA))).status).toBe(403);
    expect((await route.POST(post(answeredA, { supported: true, relevant: true, unsupported_content: false }), params(answeredA))).status).toBe(403);

    session.userId = null;
    route = await loadRoute();
    expect((await route.GET(get(answeredA), params(answeredA))).status).toBe(401);
    expect((await route.POST(post(answeredA, { supported: true, relevant: true, unsupported_content: false }), params(answeredA))).status).toBe(401);
    expect(await labelCount()).toBe(0);
  });

  it.each([
    ['a missing verdict', { supported: true, relevant: true }],
    ['a non-boolean', { supported: 'yes', relevant: true, unsupported_content: false }],
    ['an extra tenant_key', { supported: true, relevant: true, unsupported_content: false, tenant_key: TENANT_B }],
    ['an extra judge score', { supported: true, relevant: true, unsupported_content: false, score: 0.9 }],
  ])('rejects a body with %s with the structured 400', async (_name, body) => {
    session.userId = EXPERT_A;
    const route = await loadRoute();
    const res = await route.POST(post(answeredA, body), params(answeredA));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(Array.isArray(json.details)).toBe(true);
    expect(await labelCount()).toBe(0);
  });

  it('rejects malformed JSON with 400', async () => {
    session.userId = EXPERT_A;
    const route = await loadRoute();
    expect((await route.POST(post(answeredA, '{not json'), params(answeredA))).status).toBe(400);
  });

  it('answers 409 no_answer for an item without an answer and stores nothing', async () => {
    session.userId = EXPERT_A;
    const route = await loadRoute();
    const read = await route.GET(get(noAnswerA), params(noAnswerA));
    expect(read.status).toBe(409);
    expect(await read.json()).toEqual({ error: 'no_answer' });
    const write = await route.POST(post(noAnswerA, { supported: true, relevant: true, unsupported_content: false }), params(noAnswerA));
    expect(write.status).toBe(409);
    expect(await write.json()).toEqual({ error: 'no_answer' });
    expect(await labelCount()).toBe(0);
  });

  it('answers the 5.1.1 already-exported 409 for an exported item', async () => {
    session.userId = EXPERT_A;
    const route = await loadRoute();
    const res = await route.POST(post(exportedA, { supported: true, relevant: true, unsupported_content: false }), params(exportedA));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Review item already exported' });
    expect(await labelCount()).toBe(0);
  });

  it('answers 404 while RAG_DOMAIN_EXPERT_REVIEW is off', async () => {
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'false');
    session.userId = EXPERT_A;
    const route = await loadRoute();
    expect((await route.GET(get(answeredA), params(answeredA))).status).toBe(404);
    expect((await route.POST(post(answeredA, { supported: true, relevant: true, unsupported_content: false }), params(answeredA))).status).toBe(404);
    expect(await labelCount()).toBe(0);
  });

  it('never returns a judge score and logs no answer text', async () => {
    session.userId = EXPERT_A;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const route = await loadRoute();
    await route.POST(post(answeredA, { supported: true, relevant: false, unsupported_content: false }), params(answeredA));
    const body = JSON.stringify(await (await route.GET(get(answeredA), params(answeredA))).json());
    expect(body).not.toMatch(/score/);
    const logged = JSON.stringify([...log.mock.calls, ...(console.error as unknown as { mock: { calls: unknown[] } }).mock.calls]);
    expect(logged).not.toContain(ANSWER_A);
    expect(logged).not.toContain('A synthetic question');
  });

  it('writes labels with the session client only (no service-role write in the module)', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/rag/judge/answer-check.ts'), 'utf8');
    expect(source).toContain('rag_judge_labels');
    expect(source).not.toContain('getSupabaseAdmin');
  });
});
