import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DictionaryCandidateSchema, TrainingPairSchema } from '@/lib/rag-eval/contracts.generated';
import { GoldenExportLineSchema } from '@/lib/rag/feedback-loop/exports';
import { pgliteClient } from '../helpers/pglite-rest-client';
import { ADMIN_ID, USER_ID, silenceConsole } from '../helpers/admin-guard-fixture';
import { CHUNK_A, CHUNK_B, DOC_A, DOC_B, TENANT_A, TENANT_B, candidate, createReviewFixture, insertReviewItem } from '../helpers/review-fixture';

let db: PGlite;
const calls: string[] = [];
const guard = { session: null as { id: string } | null, authThrows: false, lookupFails: false };
let golden: string;
let training: string;
let foreign: string;
let open: string;

function adminClient() {
  const data = pgliteClient(db, { role: 'service_role', label: 'admin', calls });
  return {
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
          return Promise.resolve({ data: filters.id === ADMIN_ID ? { id: ADMIN_ID } : null, error: null });
        },
      };
      return builder;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (guard.authThrows) throw new Error('auth down');
          return { data: { user: guard.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => adminClient(), getSupabase: () => ({}) }));
  return {
    exportRoute: await import('@/app/api/rag/admin/feedback-loop/export/route'),
    markRoute: await import('@/app/api/rag/admin/feedback-loop/export/mark/route'),
  };
}

const get = (query: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/rag/admin/feedback-loop/export${query}`, { headers });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/rag/admin/feedback-loop/export/mark', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function label(chunkId: string, documentId: string, quote: string, triage: string[]) {
  return {
    answerable: true,
    category: 'general',
    language: 'en',
    expected_answer: 'A synthetic answer.',
    evidence: [{ chunk_id: chunkId, document_id: documentId, document_name: 'synthetic.md', section: '', quote }],
    triage,
    pii_checked: true,
    ...(triage.includes('dictionary') ? { dictionary_terms: [{ observed_term: 'cfg', canonical_term: 'configuration', relation: 'abbreviation' }] } : {}),
  };
}

async function labelled(tenant: string, chunkId: string, documentId: string, quote: string, triage: string[], status = 'labelled') {
  const id = await insertReviewItem(db, tenant, [candidate(chunkId, documentId, 1)]);
  await db.query('UPDATE rag_review_items SET status = $2, triage = $3, label = $4::jsonb WHERE id = $1', [
    id,
    status,
    triage,
    JSON.stringify(label(chunkId, documentId, quote, triage)),
  ]);
  return id;
}

function enable() {
  vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  vi.stubEnv('MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
}

function lines(text: string): unknown[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

beforeAll(async () => {
  ({ db } = await createReviewFixture());
  golden = await labelled(TENANT_A, CHUNK_A, DOC_A, 'restarts every night', ['golden', 'training', 'dictionary']);
  training = await labelled(TENANT_A, CHUNK_A, DOC_A, 'the sample component', ['training']);
  foreign = await labelled(TENANT_B, CHUNK_B, DOC_B, 'private sentence', ['golden', 'training', 'dictionary']);
  open = await labelled(TENANT_A, CHUNK_A, DOC_A, 'restarts every night', ['golden'], 'open');
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  guard.session = null;
  guard.authThrows = false;
  guard.lookupFails = false;
  calls.length = 0;
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
});

describe('GET /api/rag/admin/feedback-loop/export (D-17, D-20)', () => {
  it('runs the admin guard first: 401, forged cookie 401, 403, 503, and reads nothing before it', async () => {
    enable();
    const { exportRoute, markRoute } = await load();
    const query = `?kind=training&tenant=${TENANT_A}`;
    const body = { tenant: TENANT_A, items: [{ id: golden, split: 'test', split_group: 'g' }] };
    expect((await exportRoute.GET(get(query))).status).toBe(401);
    expect((await exportRoute.GET(get(query, { cookie: 'admin_session=forged-value' }))).status).toBe(401);
    expect((await markRoute.POST(post(body))).status).toBe(401);
    guard.session = { id: USER_ID };
    expect((await exportRoute.GET(get(query))).status).toBe(403);
    expect((await markRoute.POST(post(body))).status).toBe(403);
    guard.session = { id: ADMIN_ID };
    guard.lookupFails = true;
    expect((await exportRoute.GET(get(query))).status).toBe(503);
    guard.lookupFails = false;
    guard.session = null;
    guard.authThrows = true;
    expect((await markRoute.POST(post(body))).status).toBe(503);
    expect(calls).toEqual([]);
    const stored = await db.query<{ status: string }>('SELECT status FROM rag_review_items WHERE id = $1', [golden]);
    expect(stored.rows[0].status).toBe('labelled');
  });

  it('answers 404 with no reads while RAG_DOMAIN_EXPERT_REVIEW is off', async () => {
    guard.session = { id: ADMIN_ID };
    const { exportRoute, markRoute } = await load();
    const response = await exportRoute.GET(get(`?kind=golden&tenant=${TENANT_A}`));
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await markRoute.POST(post({ tenant: TENANT_A, items: [{ id: golden }] }))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('answers 400 for an invalid kind, tenant key, tenant of the other mode or an extra parameter', async () => {
    enable();
    guard.session = { id: ADMIN_ID };
    const { exportRoute } = await load();
    for (const query of [
      `?kind=everything&tenant=${TENANT_A}`,
      `?tenant=${TENANT_A}`,
      '?kind=golden&tenant=u:not-a-uuid',
      '?kind=golden&tenant=s:default',
      '?kind=golden',
      `?kind=golden&tenant=${TENANT_A}&user=${USER_ID}`,
    ]) {
      expect((await exportRoute.GET(get(query))).status, query).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('streams NDJSON lines of the requested kind for that tenant only, with no-store', async () => {
    enable();
    guard.session = { id: ADMIN_ID };
    const { exportRoute } = await load();
    const schemas = { dictionary: DictionaryCandidateSchema, training: TrainingPairSchema, golden: GoldenExportLineSchema };
    for (const kind of ['dictionary', 'training', 'golden'] as const) {
      const response = await exportRoute.GET(get(`?kind=${kind}&tenant=${TENANT_A}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/x-ndjson');
      expect(response.headers.get('cache-control')).toBe('no-store');
      const text = await response.text();
      const parsed = lines(text);
      expect(parsed.length, kind).toBeGreaterThan(0);
      for (const line of parsed) expect(schemas[kind].safeParse(line).success, kind).toBe(true);
      expect(text).not.toContain(foreign);
      expect(text).not.toContain(open);
      expect(text).not.toContain(TENANT_B);
      expect(text).not.toMatch(/"(user_id|chat_id|trace_id)"/);
    }
    const trainingLines = lines(await (await exportRoute.GET(get(`?kind=training&tenant=${TENANT_A}`))).text()) as Array<{ review_item_id: string }>;
    expect(trainingLines.map((line) => line.review_item_id).sort()).toEqual([golden, training].sort());
  });
});

describe('POST /api/rag/admin/feedback-loop/export/mark (D-20, D-21)', () => {
  it('answers 400 for a bad body', async () => {
    enable();
    guard.session = { id: ADMIN_ID };
    const { markRoute } = await load();
    for (const body of [
      '{not json',
      { tenant: TENANT_A, items: [] },
      { tenant: 'u:bad', items: [{ id: golden }] },
      { tenant: TENANT_A, items: [{ id: golden, split: 'test' }] },
      { tenant: TENANT_A, items: [{ id: golden, split: 'train', split_group: 'g' }] },
      { tenant: TENANT_A, items: [{ id: golden }, { id: golden }] },
      { tenant: TENANT_A, items: [{ id: golden, status: 'open' }] },
      { tenant: TENANT_A, items: [{ id: golden }], user_id: USER_ID },
    ]) {
      expect((await markRoute.POST(post(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('marks the tenant items exported with their split, lists foreign items as ignored and maps a frozen split change to 409', async () => {
    enable();
    guard.session = { id: ADMIN_ID };
    const { markRoute } = await load();
    const first = await markRoute.POST(
      post({ tenant: TENANT_A, items: [{ id: golden, split: 'test', split_group: 'group-a' }, { id: foreign, split: 'dev', split_group: 'group-b' }] }),
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const json = await first.json();
    expect(json.marked).toEqual([{ id: golden, split: 'test', split_group: 'group-a' }]);
    expect(json.ignored).toEqual([{ id: foreign, reason: 'not_found' }]);
    const foreignRow = await db.query<{ status: string; split: string | null }>('SELECT status, split FROM rag_review_items WHERE id = $1', [foreign]);
    expect(foreignRow.rows[0]).toEqual({ status: 'labelled', split: null });

    const changed = await markRoute.POST(post({ tenant: TENANT_A, items: [{ id: golden, split: 'dev', split_group: 'group-a' }, { id: training }] }));
    expect(changed.status).toBe(409);
    const changedJson = await changed.json();
    expect(changedJson.conflicts).toEqual([{ id: golden, reason: 'split_immutable' }]);
    expect(changedJson.marked).toEqual([{ id: training, split: null, split_group: null }]);
    const stored = await db.query<{ status: string; split: string; split_group: string }>('SELECT status, split, split_group FROM rag_review_items WHERE id = $1', [golden]);
    expect(stored.rows[0]).toEqual({ status: 'exported', split: 'test', split_group: 'group-a' });
  });
});
