import type { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedText } from '../../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS } from '../../../eval/harness/two-tenant.mts';
import { startRouteFixture, type RouteFixture } from '../../helpers/route-fixture';

const h = await vi.hoisted(async () => {
  const session: { userId: string | null } = { userId: null };
  return {
    session,
    ssr: {
      auth: {
        getUser: async () => ({ data: { user: session.userId ? { id: session.userId } : null }, error: null }),
      },
    },
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.ssr }));
// The fixture database has no admin tables; the write-access rules are covered in tests/rag/ai-to-rag-route.test.ts.
vi.mock('@/lib/kb-write-access', () => ({ checkSingleTenantKbWrite: async () => ({ ok: true, isAdmin: false }) }));
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: async () => ({ choices: [{ message: { content: 'Quarterly Handover Notes' } }] }) } };
  },
}));

const { userA, userB, orgO } = TWO_TENANT_IDS;
const CONTENT = 'The harbour crane inspection ritual starts at dawn.\n\nIt ends when the kestrel logbook is signed.';

type Post = (req: Request) => Promise<Response>;

function request(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/ai-to-rag', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: CONTENT, messageId: 'message-1', chatId: 'chat-1', ...body }),
  });
}

interface Loaded {
  fixture: RouteFixture;
  db: PGlite;
  post: Post;
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
  process.env.RAG_INGEST_PIPELINE = 'unified';
  const { POST } = await fixture.loadRoute<{ POST: Post }>('ai-to-rag');
  const { setIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  setIngestDepsForTests({ embedDocuments: async (texts) => texts.map((text) => embedText(text)) });
  const { setObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
  const { createFakeObjectStore } = await import('../../helpers/fake-object-store');
  setObjectStoreForTests(createFakeObjectStore());
  return { fixture, db: db as unknown as PGlite, post: POST };
}

async function stop(loaded: Loaded): Promise<void> {
  const { resetIngestDepsForTests } = await import('@/lib/rag/ingest/deps');
  const { resetObjectStoreForTests } = await import('@/lib/rag/ingest/object-store');
  resetIngestDepsForTests();
  resetObjectStoreForTests();
  await loaded.fixture.close();
  vi.unstubAllEnvs();
}

async function aiRows(db: PGlite) {
  const { rows } = await db.query<{
    id: string;
    tenant_key: string;
    user_id: string | null;
    organization_id: string | null;
    source: string;
    source_key: string;
    filename: string;
    status: string;
    is_current: boolean;
    version: number;
    metadata: Record<string, unknown>;
    chunks: number;
  }>(
    `SELECT d.id, d.tenant_key, d.user_id, d.organization_id, d.source, d.source_key, d.filename, d.status, d.is_current, d.version, d.metadata,
            (SELECT count(*)::int FROM document_chunks c WHERE c.document_id = d.id) AS chunks
       FROM documents d WHERE d.source = 'ai_to_rag' ORDER BY d.created_at, d.id`,
  );
  return rows;
}

beforeEach(() => {
  h.session.userId = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ai-to-rag unified write path against two tenants', () => {
  let loaded: Loaded;

  beforeAll(async () => {
    loaded = await start('multi-tenant');
  });

  afterAll(async () => {
    await stop(loaded);
  });

  it('a signed-in user saves an answer as a ready, current, chunked document of their own personal tenant', async () => {
    h.session.userId = userA;
    const response = await loaded.post(request({}));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, status: 'ready', version: 1, title: 'Quarterly Handover Notes', filename: 'Quarterly Handover Notes.md' });
    const rows = await aiRows(loaded.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.documentId,
      tenant_key: `u:${userA}`,
      user_id: userA,
      organization_id: null,
      source: 'ai_to_rag',
      source_key: 'chat:chat-1/message:message-1',
      status: 'ready',
      is_current: true,
      version: 1,
    });
    expect(rows[0].chunks).toBeGreaterThanOrEqual(1);
    expect(rows[0].metadata).toMatchObject({ source: 'ai_response', messageId: 'message-1', chatId: 'chat-1' });
    expect(Number.isNaN(Date.parse(String(rows[0].metadata.generatedAt)))).toBe(false);
  });

  it('saving the same answer again is skipped as a duplicate and adds no document', async () => {
    h.session.userId = userA;
    const before = await aiRows(loaded.db);
    const response = await loaded.post(request({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      status: 'skipped_duplicate',
      documentId: before[0].id,
      version: null,
      filename: 'Quarterly Handover Notes.md',
      title: 'Quarterly Handover Notes',
    });
    expect(await aiRows(loaded.db)).toHaveLength(before.length);
  });

  it('another user saving the same text under the same message id gets a separate document in their own tenant', async () => {
    h.session.userId = userB;
    const response = await loaded.post(request({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready', version: 1 });
    const rows = await aiRows(loaded.db);
    expect(rows.map((row) => row.tenant_key).sort()).toEqual([`u:${userA}`, `u:${userB}`].sort());
    expect(rows.every((row) => row.status === 'ready' && row.is_current)).toBe(true);
  });

  it('a member saves into the organization workspace', async () => {
    h.session.userId = userA;
    const response = await loaded.post(request({ organizationId: orgO, messageId: 'message-org' }));
    expect(response.status).toBe(200);
    const row = (await aiRows(loaded.db)).find((candidate) => candidate.source_key.endsWith('message:message-org'));
    expect(row).toMatchObject({ tenant_key: `o:${orgO}`, organization_id: orgO, status: 'ready' });
  });

  it('a non-member naming the organization gets 403 and nothing is written', async () => {
    h.session.userId = userB;
    const before = await aiRows(loaded.db);
    const response = await loaded.post(request({ organizationId: orgO, messageId: 'message-denied' }));
    expect(response.status).toBe(403);
    expect(await aiRows(loaded.db)).toEqual(before);
  });

  it('a body userId other than the session user gets 403, and no session gets 401, with nothing written', async () => {
    const before = await aiRows(loaded.db);
    h.session.userId = userA;
    expect((await loaded.post(request({ userId: userB, messageId: 'message-spoof' }))).status).toBe(403);
    h.session.userId = null;
    expect((await loaded.post(request({ messageId: 'message-anon' }))).status).toBe(401);
    expect(await aiRows(loaded.db)).toEqual(before);
  });
});

describe('ai-to-rag unified write path, single-tenant', () => {
  let loaded: Loaded;

  beforeAll(async () => {
    loaded = await start('single-tenant');
  });

  afterAll(async () => {
    await stop(loaded);
  });

  it('writes under s:default with no user id and skips the second identical save', async () => {
    h.session.userId = userA;
    const first = await loaded.post(request({ userId: userA }));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ status: 'ready', version: 1 });
    const rows = await aiRows(loaded.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_key: 's:default', user_id: null, organization_id: null, status: 'ready', is_current: true });
    const second = await loaded.post(request({}));
    expect(await second.json()).toMatchObject({ status: 'skipped_duplicate', documentId: body.documentId });
    expect(await aiRows(loaded.db)).toHaveLength(1);
  });

  it('refuses a request with no session before any write', async () => {
    h.session.userId = null;
    const before = await aiRows(loaded.db);
    expect((await loaded.post(request({ messageId: 'message-anon' }))).status).toBe(401);
    expect(await aiRows(loaded.db)).toEqual(before);
  });
});
