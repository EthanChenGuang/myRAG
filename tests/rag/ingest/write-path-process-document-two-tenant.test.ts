import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const session: { userId: string | null } = { userId: null };
  const admin: { result: { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503; reason: string } } = {
    result: { ok: false, status: 403, reason: 'not_admin' },
  };
  const database: { db: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> } | null } = { db: null };
  return {
    session,
    admin,
    database,
    ssr: {
      auth: {
        getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }),
      },
    },
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
// The fixture database has no admin tables; the write-access rules are covered in tests/rag/single-tenant-writes.test.ts
// and the admin guard decision in tests/rag/ingest/write-path-process-document.test.ts.
vi.mock('@/lib/kb-write-access', () => ({ checkSingleTenantKbWrite: async () => ({ ok: true, isAdmin: false }) }));
vi.mock('@/lib/admin-route-auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/admin-route-auth')>();
  return { ...original, checkAdmin: async () => h.admin.result };
});
vi.mock('@/lib/auth/organization-handler', () => ({
  verifyUserOrganizationAccess: async (userId: string, organizationId: string) => {
    const { rows } = (await h.database.db?.query('SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2', [organizationId, userId])) ?? { rows: [] };
    return { hasAccess: rows.length > 0 };
  },
}));

const { userA, userB, orgO } = TWO_TENANT_IDS;

type Post = (req: Request) => Promise<Response>;

function upload(fields: Record<string, string> = {}, text = 'The harbour crane inspection ritual starts at dawn.\n\nIt ends when the kestrel logbook is signed.', name = 'handover.txt'): Request {
  const form = new FormData();
  form.append('file', new File([text], name, { type: 'text/plain' }));
  form.append('isTemporary', 'false');
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request('http://localhost/api/process-document', { method: 'POST', body: form });
}

interface Loaded {
  fixture: RouteFixture;
  db: PGlite;
  post: Post;
  /** Documents the fixture corpus already holds; the tests look only at what the route wrote. */
  seeded: string[];
}

async function start(deploymentMode: 'single-tenant' | 'multi-tenant'): Promise<Loaded> {
  vi.stubEnv('RAG_INGEST_PIPELINE', 'unified');
  let db: PGlite | null = null;
  const fixture = await startRouteFixture({
    deploymentMode,
    ...(deploymentMode === 'multi-tenant' ? { twoTenant: true } : {}),
    seed: async (database) => {
      db = database;
    },
  });
  h.database.db = db as unknown as PGlite;
  process.env.RAG_INGEST_PIPELINE = 'unified';
  const { POST } = await fixture.loadRoute<{ POST: Post }>('process-document');
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ embedDocuments: async (texts) => texts.map((text) => embedText(text)) });
  const { setObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
  const { createFakeObjectStore } = await import('../../helpers/fake-object-store');
  setObjectStoreForTests(createFakeObjectStore());
  const database = db as unknown as PGlite;
  const seeded = (await database.query<{ id: string }>('SELECT id FROM documents')).rows.map((row) => row.id);
  return { fixture, db: database, post: POST, seeded };
}

async function stop(loaded: Loaded): Promise<void> {
  const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  const { resetObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
  resetIngestDepsForTests();
  resetObjectStoreForTests();
  h.database.db = null;
  await loaded.fixture.close();
  vi.unstubAllEnvs();
}

async function uploadRows(loaded: Loaded) {
  const { rows } = await loaded.db.query<{
    id: string;
    tenant_key: string;
    user_id: string | null;
    organization_id: string | null;
    source: string;
    source_key: string;
    filename: string;
    doc_type: string;
    status: string;
    is_current: boolean;
    version: number;
    chunks: number;
  }>(
    `SELECT d.id, d.tenant_key, d.user_id, d.organization_id, d.source, d.source_key, d.filename, d.doc_type, d.status, d.is_current, d.version,
            (SELECT count(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunks
       FROM documents d WHERE d.source IN ('chat_upload', 'config_upload') AND NOT (d.id = ANY($1::uuid[])) ORDER BY d.created_at, d.id`,
    [loaded.seeded],
  );
  return rows;
}

beforeEach(() => {
  h.session.userId = null;
  h.admin.result = { ok: false, status: 403, reason: 'not_admin' };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('process-document unified write path against two tenants', () => {
  let loaded: Loaded;

  beforeAll(async () => {
    loaded = await start('multi-tenant');
  });

  afterAll(async () => {
    await stop(loaded);
  });

  it('a signed-in user uploads into a ready, current, chunked document of their own personal tenant', async () => {
    h.session.userId = userA;
    const response = await loaded.post(upload());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'ready', version: 1, parserUsed: 'text', name: 'handover.txt', filename: 'handover.txt' });
    const rows = await uploadRows(loaded);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.documentId,
      tenant_key: `u:${userA}`,
      user_id: userA,
      organization_id: null,
      source: 'chat_upload',
      source_key: 'root/handover.txt',
      status: 'ready',
      is_current: true,
      version: 1,
    });
    expect(rows[0].chunks).toBeGreaterThanOrEqual(1);
    expect(body.successfulChunks).toBe(rows[0].chunks);
  });

  it('the same file again is skipped as a duplicate, and the same file from another user is that user\'s own document', async () => {
    h.session.userId = userA;
    const before = await uploadRows(loaded);
    const again = await loaded.post(upload());
    expect(await again.json()).toMatchObject({ status: 'skipped_duplicate', documentId: before[0].id });
    expect(await uploadRows(loaded)).toHaveLength(before.length);

    h.session.userId = userB;
    const other = await loaded.post(upload());
    expect(other.status).toBe(200);
    expect(await other.json()).toMatchObject({ status: 'ready', version: 1 });
    const rows = await uploadRows(loaded);
    expect(rows.map((row) => row.tenant_key).sort()).toEqual([`u:${userA}`, `u:${userB}`].sort());
    expect(rows.every((row) => row.status === 'ready' && row.is_current)).toBe(true);
  });

  it('a member uploads into the organization workspace and a non-member naming it gets 403 with nothing written', async () => {
    h.session.userId = userA;
    const member = await loaded.post(upload({ organization_id: orgO }, 'Organization handbook paragraph one.\n\nParagraph two.', 'handbook.txt'));
    expect(member.status).toBe(200);
    const row = (await uploadRows(loaded)).find((candidate) => candidate.source_key === 'root/handbook.txt');
    expect(row).toMatchObject({ tenant_key: `o:${orgO}`, organization_id: orgO, status: 'ready' });

    h.session.userId = userB;
    const before = await uploadRows(loaded);
    const denied = await loaded.post(upload({ organization_id: orgO }, 'Another organization paragraph.\n\nSecond.', 'denied.txt'));
    expect(denied.status).toBe(403);
    expect(await uploadRows(loaded)).toEqual(before);
  });

  it('a config_upload by admin A is written as source config_upload with the picked type, in A\'s tenant only', async () => {
    h.session.userId = userA;
    h.admin.result = { ok: true, userId: userA };
    const response = await loaded.post(upload({ upload_source: 'config_upload', doc_type: 'contract_legal' }, 'Clause one of the placeholder agreement.\n\nClause two.', 'agreement.txt'));
    expect(response.status).toBe(200);
    const row = (await uploadRows(loaded)).find((candidate) => candidate.source_key === 'root/agreement.txt');
    expect(row).toMatchObject({ source: 'config_upload', tenant_key: `u:${userA}`, doc_type: 'contract_legal', status: 'ready' });
  });

  it('the admin guard naming admin A for the session of user B, or refusing, never yields config_upload and never writes into A\'s tenant', async () => {
    h.session.userId = userB;
    h.admin.result = { ok: true, userId: userA };
    const mismatch = await loaded.post(upload({ upload_source: 'config_upload' }, 'Mismatch placeholder paragraph.\n\nSecond.', 'mismatch.txt'));
    expect(mismatch.status).toBe(200);
    h.admin.result = { ok: false, status: 401, reason: 'no_admin_session' };
    const refused = await loaded.post(upload({ upload_source: 'config_upload' }, 'Refused placeholder paragraph.\n\nSecond.', 'refused.txt'));
    expect(refused.status).toBe(200);
    const rows = await uploadRows(loaded);
    for (const name of ['mismatch.txt', 'refused.txt']) {
      expect(rows.find((row) => row.source_key === `root/${name}`)).toMatchObject({ source: 'chat_upload', tenant_key: `u:${userB}`, user_id: userB });
    }
  });

  it('an admin guard 503 writes nothing, and no session gets 401 with nothing written, whatever the guard would answer', async () => {
    const before = await uploadRows(loaded);
    h.session.userId = userA;
    h.admin.result = { ok: false, status: 503, reason: 'admin_check_unavailable' };
    expect((await loaded.post(upload({ upload_source: 'config_upload' }, 'Unavailable placeholder paragraph.\n\nSecond.', 'unavailable.txt'))).status).toBe(503);
    h.session.userId = null;
    h.admin.result = { ok: true, userId: userA };
    expect((await loaded.post(upload({ upload_source: 'config_upload' }, 'Anonymous placeholder paragraph.\n\nSecond.', 'anonymous.txt'))).status).toBe(401);
    expect(await uploadRows(loaded)).toEqual(before);
  });
});

describe('process-document unified write path, single-tenant', () => {
  let loaded: Loaded;

  beforeAll(async () => {
    loaded = await start('single-tenant');
  });

  afterAll(async () => {
    await stop(loaded);
  });

  it('writes chat and config uploads under s:default with no user id, and skips an identical second upload', async () => {
    h.session.userId = userA;
    const first = await loaded.post(upload());
    expect(first.status).toBe(200);
    const body = await first.json();
    h.admin.result = { ok: true, userId: userA };
    const config = await loaded.post(upload({ upload_source: 'config_upload', doc_type: 'invoice_receipt' }, 'Invoice placeholder line one.\n\nLine two.', 'invoice.txt'));
    expect(config.status).toBe(200);
    const rows = await uploadRows(loaded);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenant_key: 's:default', user_id: null, organization_id: null, source: 'chat_upload', status: 'ready', is_current: true });
    expect(rows[1]).toMatchObject({ tenant_key: 's:default', source: 'config_upload', doc_type: 'invoice_receipt' });
    const second = await loaded.post(upload());
    expect(await second.json()).toMatchObject({ status: 'skipped_duplicate', documentId: body.documentId });
    expect(await uploadRows(loaded)).toHaveLength(2);
  });

  it('refuses a request with no session before any write, even when the admin guard would answer ok', async () => {
    h.session.userId = null;
    h.admin.result = { ok: true, userId: userA };
    const before = await uploadRows(loaded);
    expect((await loaded.post(upload({ upload_source: 'config_upload' }, 'Anonymous placeholder paragraph.\n\nSecond.', 'anonymous.txt'))).status).toBe(401);
    expect(await uploadRows(loaded)).toEqual(before);
  });
});
