import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteAdmin } from '../helpers/pglite-admin';
import {
  DOC_A,
  DOC_A_QUARANTINED,
  DOC_B,
  OWNER_A,
  OWNER_B,
  TENANT_A,
  TENANT_B,
  TEXT_A,
  TEXT_A_SUPERSEDED,
  TEXT_A_ZH,
  TEXT_B,
  createReviewFixture,
} from '../helpers/review-fixture';
import { normalizeQuote, quoteSha256 } from '@/lib/rag/monitor/golden-evidence';

const ADMIN = OWNER_A;
const DOC_A_OLD = '00000000-0000-4000-8000-0000000073d1';
const DOC_B_SHARED = '00000000-0000-4000-8000-0000000073d2';
const DOC_A_WATCHED = '00000000-0000-4000-8000-0000000073d3';
const TEXT_SHARED = 'A neutral synthetic sentence that only tenant bravo stores.';
const SET_ID = 'domain-alpha';

let db: PGlite;
const guard = { session: null as { id: string } | null, lookupFails: false };
const logs: string[] = [];

function adminClient() {
  const data = createPgliteAdmin(db);
  return {
    ...data,
    rpc: data.rpc.bind(data),
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from(table: string) {
      if (table !== 'admin_users') return data.from(table);
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          if (guard.lookupFails) return Promise.resolve({ data: null, error: { message: 'down' } });
          return Promise.resolve({ data: filters.id === ADMIN ? { id: ADMIN } : null, error: null });
        },
      };
      return builder;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: guard.session } }) } }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => adminClient(), getSupabase: () => ({}) }));
  return {
    check: await import('@/app/api/rag/admin/golden/evidence-check/route'),
    register: await import('@/app/api/rag/admin/golden/register/route'),
  };
}

const post = (route: string, body: unknown) =>
  new NextRequest(`http://localhost/api/rag/admin/golden/${route}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const get = (route: string, query: string) => new NextRequest(`http://localhost/api/rag/admin/golden/${route}${query}`);

beforeAll(async () => {
  ({ db } = await createReviewFixture());
  await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  for (const [id, owner, name] of [
    [DOC_A_OLD, OWNER_A, 'alpha-old.md'],
    [DOC_B_SHARED, OWNER_B, 'shared-name.md'],
    [DOC_A_WATCHED, OWNER_A, 'alpha-watched.md'],
  ]) {
    await db.query('INSERT INTO documents (id, filename, content, user_id) VALUES ($1, $2, $3, $4)', [id, name, 'body', owner]);
  }
  await db.query('INSERT INTO document_chunks (id, document_id, content) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)', [
    crypto.randomUUID(),
    DOC_A_OLD,
    'An older neutral sentence.',
    crypto.randomUUID(),
    DOC_B_SHARED,
    TEXT_SHARED,
    crypto.randomUUID(),
    DOC_A_WATCHED,
    'A watched neutral sentence.',
  ]);
  await db.query('UPDATE documents SET is_current = false WHERE id = $1', [DOC_A_OLD]);
  await db.query('UPDATE document_chunks SET is_current = false WHERE document_id = $1', [DOC_A_OLD]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  guard.session = null;
  guard.lookupFails = false;
  logs.length = 0;
  vi.stubEnv('MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(JSON.stringify(args));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
});

describe('normalizeQuote (twin of rag_eval.matching.normalize_text)', () => {
  it('matches every shared vector', () => {
    const file = path.join(process.cwd(), 'eval/fixtures/normalize-text-vectors.json');
    const { vectors } = JSON.parse(fs.readFileSync(file, 'utf8')) as { vectors: Array<{ input: string; expected: string }> };
    expect(vectors.length).toBeGreaterThan(10);
    for (const vector of vectors) expect(normalizeQuote(vector.input)).toBe(vector.expected);
  });

  it('hashes the normalised quote', () => {
    expect(quoteSha256('The Sample, component')).toBe(crypto.createHash('sha256').update('thesamplecomponent').digest('hex'));
  });
});

describe('POST /api/rag/admin/golden/evidence-check (D-48)', () => {
  it('runs the admin guard first: 401 without a session, 403 for a non-admin, 503 when the guard is unavailable', async () => {
    const { check } = await load();
    const body = { tenant: TENANT_A, spans: [{ item_id: 'g-1', document: 'alpha-guide.md', quote: 'sample component' }] };
    expect((await check.POST(post('evidence-check', body))).status).toBe(401);
    guard.session = { id: OWNER_B };
    expect((await check.POST(post('evidence-check', body))).status).toBe(403);
    guard.session = { id: ADMIN };
    guard.lookupFails = true;
    expect((await check.POST(post('evidence-check', body))).status).toBe(503);
  });

  it('answers 403 for a tenant the admin does not administer and 400 for a malformed tenant', async () => {
    const { check } = await load();
    guard.session = { id: ADMIN };
    const spans = [{ item_id: 'g-1', document: 'bravo-private.md', quote: 'private sentence' }];
    expect((await check.POST(post('evidence-check', { tenant: TENANT_B, spans }))).status).toBe(403);
    expect((await check.POST(post('evidence-check', { tenant: 's:default', spans }))).status).toBe(400);
    expect((await check.POST(post('evidence-check', { tenant: 'nonsense', spans }))).status).toBe(400);
  });

  it('answers 400 for more than 500 spans, a quote over 4000 characters or an unknown field', async () => {
    const { check } = await load();
    guard.session = { id: ADMIN };
    const span = { item_id: 'g-1', document: 'alpha-guide.md', quote: 'sample' };
    expect((await check.POST(post('evidence-check', { tenant: TENANT_A, spans: Array.from({ length: 501 }, () => span) }))).status).toBe(400);
    expect((await check.POST(post('evidence-check', { tenant: TENANT_A, spans: [{ ...span, quote: 'x'.repeat(4001) }] }))).status).toBe(400);
    expect((await check.POST(post('evidence-check', { tenant: TENANT_A, spans: [{ ...span, text: 'x' }] }))).status).toBe(400);
    expect((await check.POST(post('evidence-check', { tenant: TENANT_A, spans: [] }))).status).toBe(400);
  });

  it('answers ok, quote_not_found, document_superseded and document_missing per span without echoing any text', async () => {
    const { check } = await load();
    guard.session = { id: ADMIN };
    const spans = [
      { item_id: 'g-ok', document: 'Alpha-Guide.md', quote: 'the SAMPLE component,   restarts every night' },
      { item_id: 'g-zh', document: 'alpha-guide.md', quote: '示例组件每天晚上重新启动' },
      { item_id: 'g-gone', document: 'alpha-guide.md', quote: TEXT_A_SUPERSEDED },
      { item_id: 'g-old', document: 'alpha-old.md', quote: 'An older neutral sentence.' },
      { item_id: 'g-none', document: 'never-uploaded.md', quote: 'anything at all' },
      { item_id: 'g-quarantined', document: 'alpha-quarantined.md', quote: 'quarantined sentence' },
      { item_id: 'g-other-tenant', document: 'bravo-private.md', quote: TEXT_B },
      { item_id: 'g-shared', document: 'shared-name.md', quote: TEXT_SHARED },
    ];
    const response = await check.POST(post('evidence-check', { tenant: TENANT_A, spans }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.results).toEqual([
      { item_id: 'g-ok', status: 'ok', document_id: DOC_A },
      { item_id: 'g-zh', status: 'ok', document_id: DOC_A },
      { item_id: 'g-gone', status: 'quote_not_found', document_id: DOC_A },
      { item_id: 'g-old', status: 'document_superseded', document_id: DOC_A_OLD },
      { item_id: 'g-none', status: 'document_missing', document_id: null },
      { item_id: 'g-quarantined', status: 'document_missing', document_id: DOC_A_QUARANTINED },
      { item_id: 'g-other-tenant', status: 'document_missing', document_id: null },
      { item_id: 'g-shared', status: 'document_missing', document_id: null },
    ]);
    expect(body.counts).toEqual({ ok: 2, document_missing: 4, document_superseded: 1, quote_not_found: 1 });
    const serialized = JSON.stringify(body) + logs.join('\n');
    for (const secret of ['alpha-guide', 'alpha-old', 'bravo-private', 'shared-name', 'never-uploaded', 'SAMPLE', 'restarts', TEXT_A, TEXT_A_ZH, TEXT_B, TEXT_SHARED, DOC_B, DOC_B_SHARED]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('GET|POST /api/rag/admin/golden/register (D-48)', () => {
  it('runs the guard and the tenant check before anything else', async () => {
    const { register } = await load();
    const body = { tenant: TENANT_A, set_id: SET_ID, rows: [] };
    expect((await register.POST(post('register', body))).status).toBe(401);
    expect((await register.GET(get('register', `?tenant=${TENANT_A}&set_id=${SET_ID}`))).status).toBe(401);
    guard.session = { id: ADMIN };
    expect((await register.POST(post('register', { ...body, tenant: TENANT_B }))).status).toBe(403);
    expect((await register.GET(get('register', `?tenant=${TENANT_B}&set_id=${SET_ID}`))).status).toBe(403);
    expect((await register.GET(get('register', `?tenant=${TENANT_A}&set_id=${SET_ID}&extra=1`))).status).toBe(400);
    expect((await register.POST(post('register', { ...body, rows: [{ item_id: 'g-1', document_id: DOC_A, quote_sha256: 'not-a-hash' }] }))).status).toBe(400);
  });

  it('stores rows of the tenant, drops another tenant’s document, lists flagged items and clears them', async () => {
    const { register } = await load();
    guard.session = { id: ADMIN };
    const rows = [
      { item_id: 'g-watched', document_id: DOC_A_WATCHED, quote_sha256: quoteSha256('A watched neutral sentence.') },
      { item_id: 'g-guide', document_id: DOC_A, quote_sha256: quoteSha256(TEXT_A) },
      { item_id: 'g-foreign', document_id: DOC_B, quote_sha256: quoteSha256(TEXT_B) },
    ];
    const stored = await register.POST(post('register', { tenant: TENANT_A, set_id: SET_ID, rows }));
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({ success: true, stored: 2, dropped: 1 });

    const empty = await (await register.GET(get('register', `?tenant=${TENANT_A}&set_id=${SET_ID}`))).json();
    expect(empty).toEqual({ success: true, item_ids: [], count: 0 });

    await db.query("UPDATE documents SET status = 'quarantined' WHERE id = $1", [DOC_A_WATCHED]);
    const flagged = await (await register.GET(get('register', `?tenant=${TENANT_A}&set_id=${SET_ID}`))).json();
    expect(flagged).toEqual({ success: true, item_ids: ['g-watched'], count: 1 });

    const cleared = await register.POST(post('register', { action: 'clear', tenant: TENANT_A, set_id: SET_ID, item_ids: ['g-watched'] }));
    expect(await cleared.json()).toEqual({ success: true, cleared: 1 });
    const after = await (await register.GET(get('register', `?tenant=${TENANT_A}&set_id=${SET_ID}`))).json();
    expect(after.item_ids).toEqual([]);
  });
});

describe('POST /api/rag/admin/golden/re-review (D-50)', () => {
  async function loadReReview() {
    vi.resetModules();
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: guard.session } }) } }),
    }));
    vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => adminClient(), getSupabase: () => ({}) }));
    return import('@/app/api/rag/admin/golden/re-review/route');
  }

  const items = [
    { item_id: 'g-r1', question: 'What does the first synthetic note say? Write to someone@example.com.' },
    { item_id: 'g-r2', question: 'Which value does the second synthetic note give?' },
    { item_id: 'g-r3', question: 'When does the third synthetic note apply?' },
  ];

  it('runs the guard and the tenant check, and refuses more than 100 items', async () => {
    const route = await loadReReview();
    expect((await route.POST(post('re-review', { tenant: TENANT_A, items }))).status).toBe(401);
    guard.session = { id: OWNER_B };
    expect((await route.POST(post('re-review', { tenant: TENANT_A, items }))).status).toBe(403);
    guard.session = { id: ADMIN };
    expect((await route.POST(post('re-review', { tenant: TENANT_B, items }))).status).toBe(403);
    const many = Array.from({ length: 101 }, (_, index) => ({ item_id: `g-${index}`, question: `Synthetic question ${index}?` }));
    expect((await route.POST(post('re-review', { tenant: TENANT_A, items: many }))).status).toBe(400);
    expect((await route.POST(post('re-review', { tenant: TENANT_A, items: [{ ...items[0], extra: 1 }] }))).status).toBe(400);
  });

  it('queues masked, fingerprinted items with reason re_review in this week’s window, once', async () => {
    const route = await loadReReview();
    guard.session = { id: ADMIN };
    const first = await route.POST(post('re-review', { tenant: TENANT_A, items }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true, requested: 3, inserted: 3 });
    const repeat = await route.POST(post('re-review', { tenant: TENANT_A, items }));
    expect(await repeat.json()).toEqual({ success: true, requested: 3, inserted: 0 });

    const { weekStart } = await import('@/lib/rag/monitor/golden-evidence');
    const { maskPII } = await import('@/lib/rag/trace/mask');
    const { fingerprintMaskedQuery } = await import('@/lib/rag/feedback-loop/retrieval-log');
    const rows = (
      await db.query<{ tenant_key: string; query_masked: string; query_fingerprint: string; reasons: string[]; status: string; mining_window: Date }>(
        "SELECT tenant_key, query_masked, query_fingerprint, reasons, status, mining_window FROM rag_review_items WHERE 're_review' = ANY (reasons) ORDER BY query_masked",
      )
    ).rows;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.tenant_key).toBe(TENANT_A);
      expect(row.reasons).toEqual(['re_review']);
      expect(row.status).toBe('open');
      expect(new Date(row.mining_window).toISOString()).toBe(weekStart(new Date()));
      expect(row.query_fingerprint).toBe(fingerprintMaskedQuery(row.query_masked));
    }
    const masked = maskPII(items[0].question);
    expect(masked).not.toContain('someone@example.com');
    expect(rows.map((row) => row.query_masked)).toContain(masked);
    expect(rows.some((row) => row.query_masked.includes('someone@example.com'))).toBe(false);
    expect(logs.join('\n')).not.toContain('synthetic note');
  });

  it('computes the week start as Monday 00:00 UTC', async () => {
    const { weekStart } = await import('@/lib/rag/monitor/golden-evidence');
    expect(weekStart(new Date('2026-11-26T15:00:00Z'))).toBe('2026-11-23T00:00:00.000Z');
    expect(weekStart(new Date('2026-11-23T00:00:00Z'))).toBe('2026-11-23T00:00:00.000Z');
    expect(weekStart(new Date('2026-11-29T23:59:59Z'))).toBe('2026-11-23T00:00:00.000Z');
  });
});
