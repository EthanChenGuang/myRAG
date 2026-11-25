import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { ReviewItemListResponseSchema, ReviewItemSchema } from '@/lib/rag-eval/contracts.generated';
import { pgliteClient } from '../helpers/pglite-rest-client';

const OWNER_A = '00000000-0000-4000-8000-0000000061a0';
const OWNER_B = '00000000-0000-4000-8000-0000000061b0';
const EXPERT_A = '00000000-0000-4000-8000-0000000061a1';
const EXPERT_B = '00000000-0000-4000-8000-0000000061b1';
const ADMIN = '00000000-0000-4000-8000-0000000061ad';
const TENANT_A = `u:${OWNER_A}`;
const TENANT_B = `u:${OWNER_B}`;

const DOC_A = '00000000-0000-4000-8000-0000000061d1';
const DOC_A_QUARANTINED = '00000000-0000-4000-8000-0000000061d2';
const DOC_B = '00000000-0000-4000-8000-0000000061d3';
const CHUNK_A = '00000000-0000-4000-8000-0000000061e1';
const CHUNK_A_QUARANTINED = '00000000-0000-4000-8000-0000000061e2';
const CHUNK_A_SUPERSEDED = '00000000-0000-4000-8000-0000000061e3';
const CHUNK_B = '00000000-0000-4000-8000-0000000061e4';

const TEXT_A = 'Tenant alpha evidence sentence about the sample component.';
const TEXT_A_QUARANTINED = 'Tenant alpha quarantined sentence that must stay hidden.';
const TEXT_A_SUPERSEDED = 'Tenant alpha superseded sentence from an older version.';
const TEXT_B = 'Tenant bravo private sentence that tenant alpha must never read.';

let db: PGlite;
let calls: string[] = [];
const session: { userId: string | null } = { userId: null };
let itemA: string;
let itemB: string;

function candidate(chunkId: string, documentId: string, rank: number) {
  return { chunk_id: chunkId, document_id: documentId, rank, similarity: 0.5, kept: rank === 1 };
}

async function insertItem(tenantKey: string, candidates: unknown[]): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, trace_id, query_masked, query_fingerprint, channel, outcome, reasons, candidates, mining_window)
     VALUES ($1, $2, $3, $4, 'chat', 'answered', ARRAY['low_score'], $5::jsonb, '2026-11-23T00:00:00Z') RETURNING id`,
    [tenantKey, crypto.randomUUID(), 'A synthetic question', crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex'), JSON.stringify(candidates)],
  );
  return result.rows[0].id;
}

async function loadRoutes() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => pgliteClient(db, { role: 'authenticated', userId: session.userId, label: 'ssr', calls }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => pgliteClient(db, { role: 'service_role', label: 'admin', calls }),
    getSupabase: () => ({}),
  }));
  return {
    list: await import('@/app/api/rag/review/items/route'),
    item: await import('@/app/api/rag/review/items/[id]/route'),
    chunks: await import('@/app/api/rag/review/items/[id]/chunks/route'),
  };
}

const get = (url: string) => new NextRequest(`http://localhost${url}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' })).db;
  for (const id of [OWNER_A, OWNER_B, EXPERT_A, EXPERT_B, ADMIN]) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `user-${id.slice(-4)}@example.invalid`]);
  }
  await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2), ($3, $4)', [TENANT_A, EXPERT_A, TENANT_B, EXPERT_B]);
  for (const [id, owner, name] of [
    [DOC_A, OWNER_A, 'alpha-guide.md'],
    [DOC_A_QUARANTINED, OWNER_A, 'alpha-quarantined.md'],
    [DOC_B, OWNER_B, 'bravo-private.md'],
  ]) {
    await db.query('INSERT INTO documents (id, filename, content, user_id) VALUES ($1, $2, $3, $4)', [id, name, 'body', owner]);
  }
  for (const [id, doc, text] of [
    [CHUNK_A, DOC_A, TEXT_A],
    [CHUNK_A_QUARANTINED, DOC_A_QUARANTINED, TEXT_A_QUARANTINED],
    [CHUNK_A_SUPERSEDED, DOC_A, TEXT_A_SUPERSEDED],
    [CHUNK_B, DOC_B, TEXT_B],
  ]) {
    await db.query("INSERT INTO document_chunks (id, document_id, content, section_path) VALUES ($1, $2, $3, ARRAY['Part one', 'Detail'])", [id, doc, text]);
  }
  await db.query("UPDATE documents SET status = 'quarantined' WHERE id = $1", [DOC_A_QUARANTINED]);
  await db.query("UPDATE document_chunks SET status = 'quarantined' WHERE document_id = $1", [DOC_A_QUARANTINED]);
  await db.query('UPDATE document_chunks SET is_current = false WHERE id = $1', [CHUNK_A_SUPERSEDED]);

  itemA = await insertItem(TENANT_A, [candidate(CHUNK_A, DOC_A, 1), candidate(CHUNK_A_QUARANTINED, DOC_A_QUARANTINED, 2), candidate(CHUNK_A_SUPERSEDED, DOC_A, 3)]);
  itemB = await insertItem(TENANT_B, [candidate(CHUNK_B, DOC_B, 1)]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  calls.length = 0;
  session.userId = null;
  vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('review routes with two tenants (multi-tenant)', () => {
  it("lets the expert of A list and open A's item and read its current, ready chunk text only", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    session.userId = EXPERT_A;
    const { list, item, chunks } = await loadRoutes();
    const listed = ReviewItemListResponseSchema.parse(await (await list.GET(get('/api/rag/review/items'))).json());
    expect(listed.items.map((entry) => entry.id)).toEqual([itemA]);

    const opened = await item.GET(get(`/api/rag/review/items/${itemA}`), params(itemA));
    expect(opened.status).toBe(200);
    expect(ReviewItemSchema.parse(await opened.json()).tenant_key).toBe(TENANT_A);

    const res = await chunks.GET(get(`/api/rag/review/items/${itemA}/chunks`), params(itemA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      item_id: itemA,
      chunks: [
        { chunk_id: CHUNK_A, document_id: DOC_A, available: true, document_name: 'alpha-guide.md', section: 'Part one > Detail', text: TEXT_A },
        { chunk_id: CHUNK_A_QUARANTINED, document_id: DOC_A_QUARANTINED, available: false },
        { chunk_id: CHUNK_A_SUPERSEDED, document_id: DOC_A, available: false },
      ],
    });
  });

  it("answers 404 on every review route for a B item id, and the chunks route then issues no admin query", async () => {
    session.userId = EXPERT_A;
    const { item, chunks } = await loadRoutes();
    const notFound = await (await item.GET(get(`/api/rag/review/items/${crypto.randomUUID()}`), params(crypto.randomUUID()))).json();
    calls.length = 0;
    const one = await item.GET(get(`/api/rag/review/items/${itemB}`), params(itemB));
    expect(one.status).toBe(404);
    expect(await one.json()).toEqual(notFound);
    const evidence = await chunks.GET(get(`/api/rag/review/items/${itemB}/chunks`), params(itemB));
    expect(evidence.status).toBe(404);
    const text = JSON.stringify(await evidence.json());
    expect(text).not.toContain(TEXT_B);
    expect(text).toBe(JSON.stringify(notFound));
    expect(calls.every((call) => call.startsWith('ssr:'))).toBe(true);
  });

  it('reports a B chunk id planted in an A snapshot (service-role tamper) as unavailable, never with its text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tampered = await insertItem(TENANT_A, [candidate(CHUNK_B, DOC_B, 1), candidate(CHUNK_A, DOC_A, 2), candidate(CHUNK_B, DOC_A, 3)]);
    try {
      session.userId = EXPERT_A;
      const { chunks } = await loadRoutes();
      const res = await chunks.GET(get(`/api/rag/review/items/${tampered}/chunks`), params(tampered));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain(TEXT_B);
      expect(JSON.stringify(body)).not.toContain('bravo-private.md');
      expect(body.chunks[0]).toEqual({ chunk_id: CHUNK_B, document_id: DOC_B, available: false });
      expect(body.chunks[1]).toMatchObject({ chunk_id: CHUNK_A, available: true, text: TEXT_A });
      expect(calls[0]).toBe('ssr:rag_review_items');
      expect(calls.slice(1).every((call) => call.startsWith('admin:'))).toBe(true);

      const lines = log.mock.calls.filter((args) => args[0] === '[Review] chunks');
      expect(lines).toHaveLength(1);
      const fields = lines[0][1] as Record<string, unknown>;
      expect(fields).toEqual({ expert: EXPERT_A, item: expect.stringMatching(/^[0-9a-f]{16}$/), count: 1 });
      expect(JSON.stringify(lines)).not.toContain(tampered);
      expect(JSON.stringify(lines)).not.toContain(TEXT_A);
    } finally {
      await db.query('DELETE FROM rag_review_items WHERE id = $1', [tampered]);
    }
  });

  it("gives the expert of B B's item and chunk, and nothing of A", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    session.userId = EXPERT_B;
    const { list, item, chunks } = await loadRoutes();
    const listed = await (await list.GET(get('/api/rag/review/items'))).json();
    expect(listed.items.map((entry: { id: string }) => entry.id)).toEqual([itemB]);
    expect((await item.GET(get(`/api/rag/review/items/${itemA}`), params(itemA))).status).toBe(404);
    expect((await chunks.GET(get(`/api/rag/review/items/${itemA}/chunks`), params(itemA))).status).toBe(404);
    const own = await (await chunks.GET(get(`/api/rag/review/items/${itemB}/chunks`), params(itemB))).json();
    expect(own.chunks).toEqual([{ chunk_id: CHUNK_B, document_id: DOC_B, available: true, document_name: 'bravo-private.md', section: 'Part one > Detail', text: TEXT_B }]);
  });

  it('shows an operator admin without a grant an empty list and 404 for both items', async () => {
    session.userId = ADMIN;
    const { list, item, chunks } = await loadRoutes();
    expect(await (await list.GET(get('/api/rag/review/items'))).json()).toEqual({ items: [], next_cursor: null });
    for (const id of [itemA, itemB]) {
      expect((await item.GET(get(`/api/rag/review/items/${id}`), params(id))).status).toBe(404);
      expect((await chunks.GET(get(`/api/rag/review/items/${id}/chunks`), params(id))).status).toBe(404);
    }
    expect(calls.some((call) => call.startsWith('admin:'))).toBe(false);
  });

  it('answers 404 with the switch off and 401 without a session on the chunks route', async () => {
    const { chunks } = await loadRoutes();
    expect((await chunks.GET(get(`/api/rag/review/items/${itemA}/chunks`), params(itemA))).status).toBe(401);
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'false');
    session.userId = EXPERT_A;
    expect((await chunks.GET(get(`/api/rag/review/items/${itemA}/chunks`), params(itemA))).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
