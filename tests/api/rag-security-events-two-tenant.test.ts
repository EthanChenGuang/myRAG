import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { ReviewCheckDetailsSchema, ReviewItemListResponseSchema, ReviewItemSchema } from '@/lib/rag-eval/contracts.generated';
import { securityRoutes, seedSecurityTenants, type SecurityFixture, type SecurityRoutes } from '../helpers/security-events-fixture';

let db: PGlite;
let fx: SecurityFixture;
const session: { userId: string | null } = { userId: null };
const preview: { hosts: string[] | null } = { hosts: [] };
let guardItemA: string;
let conflictItemA: string;
let guardItemB: string;
let minedItemA: string;

const get = (url: string) => new NextRequest(`http://localhost${url}`);
const post = (url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function enqueue(tenantKey: string, reason: string, source: Record<string, string[]>): Promise<string> {
  await db.exec('SET ROLE service_role');
  try {
    const result = await db.query<{ id: string }>('SELECT public.rag_enqueue_review_item($1, $2, $3::jsonb, $4::jsonb) AS id', [
      tenantKey,
      reason,
      JSON.stringify(source),
      JSON.stringify({ detector: 'rules', trace_id: `trace-${crypto.randomUUID()}` }),
    ]);
    return result.rows[0]!.id;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function routes(): Promise<SecurityRoutes> {
  return securityRoutes(db, session, preview, fx.names);
}

beforeAll(async () => {
  db = (await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', supabaseFunctionDefaults: true })).db;
  fx = await seedSecurityTenants(db);
  await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2)', [fx.tenantA, fx.admin]);
  guardItemA = await enqueue(fx.tenantA, 'output_guard', { chunk_ids: [fx.chunkA1] });
  conflictItemA = await enqueue(fx.tenantA, 'version_conflict', { document_ids: [fx.docA1, fx.docA2] });
  guardItemB = await enqueue(fx.tenantB, 'output_guard', { chunk_ids: [fx.chunkB1], document_ids: [fx.docB1] });
  const mined = await db.query<{ id: string }>(
    `INSERT INTO rag_review_items (tenant_key, trace_id, query_masked, query_fingerprint, channel, outcome, reasons, candidates, mining_window)
     VALUES ($1, 'trace-mined', 'A synthetic question', $2, 'chat', 'answered', ARRAY['low_score'], '[]'::jsonb, '2026-11-23T00:00:00Z') RETURNING id`,
    [fx.tenantA, crypto.createHash('sha256').update('mined').digest('hex')],
  );
  minedItemA = mined.rows[0]!.id;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  session.userId = null;
  vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  vi.stubEnv('RAG_SECURITY_EVENTS', 'true');
  vi.stubEnv('RAG_UPLOADER_HOLD', 'manual');
  vi.stubEnv('RAG_UPLOADER_ALERT_THRESHOLD', '2');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('review items raised by a check', () => {
  it('returns the check, the documents by id and name and the uploader, without e-mail for a domain expert', async () => {
    session.userId = fx.expertA;
    const res = await (await routes()).reviewItem.GET(get(`/api/rag/review/items/${guardItemA}`), params(guardItemA));
    expect(res.status).toBe(200);
    const body = await res.json();
    const { check_details: details, ...item } = body;
    expect(ReviewItemSchema.parse(item)).toMatchObject({ id: guardItemA, tenant_key: fx.tenantA, reasons: ['output_guard'], channel: null });
    expect(ReviewCheckDetailsSchema.parse(details)).toEqual({
      check: 'output_guard',
      detector: 'rules',
      documents: [{ document_id: fx.docA1, file_name: 'document-a1.pdf', uploader_id: fx.uploaderA1, uploader_name: 'Uploader One', uploader_email: null }],
    });
  });

  it('returns both documents of a version_conflict item, and the e-mail for a deployment admin', async () => {
    session.userId = fx.admin;
    const body = await (await (await routes()).reviewItem.GET(get(`/api/rag/review/items/${conflictItemA}`), params(conflictItemA))).json();
    expect(body.check_details.check).toBe('version_conflict');
    const documents = [...body.check_details.documents].sort((a, b) => a.file_name.localeCompare(b.file_name));
    expect(documents).toEqual([
      { document_id: fx.docA1, file_name: 'document-a1.pdf', uploader_id: fx.uploaderA1, uploader_name: 'Uploader One', uploader_email: fx.emailOf(fx.uploaderA1) },
      { document_id: fx.docA2, file_name: 'document-a2.pdf', uploader_id: fx.uploaderA2, uploader_name: 'Uploader Two', uploader_email: fx.emailOf(fx.uploaderA2) },
    ]);
  });

  it('returns an item of another reason exactly as before, without check details', async () => {
    session.userId = fx.expertA;
    const body = await (await (await routes()).reviewItem.GET(get(`/api/rag/review/items/${minedItemA}`), params(minedItemA))).json();
    expect(body).not.toHaveProperty('check_details');
    expect(body).toEqual(ReviewItemSchema.parse(body));
    expect(body.reasons).toEqual(['low_score']);
  });

  it('lists check-raised items for their tenant and filters by the new reasons', async () => {
    session.userId = fx.expertA;
    const r = await routes();
    const listed = ReviewItemListResponseSchema.parse(await (await r.reviewList.GET(get('/api/rag/review/items'))).json());
    expect(listed.items.map((item) => item.id).sort()).toEqual([guardItemA, conflictItemA, minedItemA].sort());
    const filtered = await r.reviewList.GET(get('/api/rag/review/items?reason=version_conflict'));
    expect(filtered.status).toBe(200);
    expect(ReviewItemListResponseSchema.parse(await filtered.json()).items.map((item) => item.id)).toEqual([conflictItemA]);
  });
});

describe('two tenants: A never reads or changes B', () => {
  it("answers 404 for tenant B's review item to A's expert and organization admin", async () => {
    for (const user of [fx.expertA, fx.orgAdminA]) {
      session.userId = user;
      const res = await (await routes()).reviewItem.GET(get(`/api/rag/review/items/${guardItemB}`), params(guardItemB));
      expect(res.status).toBe(404);
    }
  });

  it("never returns tenant B's events, alerts, holds or uploader names to A's organization admin or expert", async () => {
    await db.query("INSERT INTO rag_uploader_holds (tenant_key, user_id, created_by, reason) VALUES ($1, $2, $3, 'security_alert')", [fx.tenantB, fx.uploaderB, fx.orgAdminB]);
    for (const user of [fx.orgAdminA, fx.expertA]) {
      session.userId = user;
      const r = await routes();
      const bodies: string[] = [];
      for (let cursor: string | null = '0'; cursor !== null; ) {
        const page: { items: Array<{ tenant_key: string }>; next_cursor: string | null } = await (
          await r.events.GET(get(`/api/rag/admin/security-events?cursor=${cursor}`))
        ).json();
        bodies.push(JSON.stringify(page));
        expect(page.items.every((item) => item.tenant_key === fx.tenantA)).toBe(true);
        cursor = page.next_cursor;
      }
      for (const route of [r.alerts, r.uploaders]) {
        const body = await (await route.GET(get('/api/rag/admin/security-events/x'))).json();
        expect(body.items.every((item: { tenant_key: string }) => item.tenant_key === fx.tenantA)).toBe(true);
        bodies.push(JSON.stringify(body));
      }
      const uploaderFilter = await (await r.events.GET(get(`/api/rag/admin/security-events?uploader=${fx.uploaderB}`))).json();
      expect(uploaderFilter.items).toEqual([]);
      const text = bodies.join('\n');
      for (const secret of [fx.tenantB, fx.uploaderB, 'Uploader Bravo', 'Workspace B', 'document-b1.pdf', fx.alertB, fx.docB1]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("cannot hold, release or acknowledge for tenant B, whatever tenant key it names", async () => {
    const before = await db.query('SELECT id, released_at, created_at FROM rag_uploader_holds ORDER BY id');
    const alertsBefore = await db.query('SELECT id, status FROM rag_security_alerts ORDER BY id');
    for (const user of [fx.orgAdminA, fx.expertA]) {
      session.userId = user;
      const r = await routes();
      for (const tenantKey of [fx.tenantB, fx.tenantA]) {
        expect((await r.hold.POST(post('/x', { tenantKey }), params(fx.uploaderB))).status).toBe(404);
        expect((await r.release.POST(post('/x', { tenantKey }), params(fx.uploaderB))).status).toBe(404);
      }
      expect((await r.hold.POST(post('/x', { tenantKey: fx.tenantB }), params(fx.uploaderA1))).status).toBe(404);
      expect((await r.acknowledge.POST(post('/x'), params(fx.alertB))).status).toBe(404);
    }
    expect((await db.query('SELECT id, released_at, created_at FROM rag_uploader_holds ORDER BY id')).rows).toEqual(before.rows);
    expect((await db.query('SELECT id, status FROM rag_security_alerts ORDER BY id')).rows).toEqual(alertsBefore.rows);
  });

  it("lets B's organization admin act on B and not on A", async () => {
    session.userId = fx.orgAdminB;
    const r = await routes();
    expect((await r.acknowledge.POST(post('/x'), params(fx.alertA))).status).toBe(404);
    expect((await r.hold.POST(post('/x', { tenantKey: fx.tenantA }), params(fx.uploaderA1))).status).toBe(404);
    const released = await r.release.POST(post('/x', { tenantKey: fx.tenantB }), params(fx.uploaderB));
    expect(released.status).toBe(200);
  });
});
