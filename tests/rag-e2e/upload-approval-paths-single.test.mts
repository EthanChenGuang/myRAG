import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createEmptyFixtureDatabase, type EmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

// Plan 03.2-15 (D-37): in single-tenant mode a connector item is written to the one shared tenant and its uploader is the user who owns
// the connection, so that user's role decides the hold: a member's connection is held under members, an admin's is not. (In multi-tenant
// mode a connection syncs into its owner's personal workspace; tests/rag-e2e/upload-approval-paths.test.mts covers that.)

type Row = Record<string, unknown>;

const ADMIN = '00000000-0000-4000-8000-0000000015b1';
const MEMBER = '00000000-0000-4000-8000-0000000015b2';
const CONNECTION = 'conn-approval-single-1';
const REFUSAL = 'upload_approval_requires_unified_pipeline';

function note(token: string): string {
  return `# Drive Notes ${token}\n\nThe ${token} widget rests on the lower shelf beside the copper rail and the oak frame.\n`;
}

describe('upload approval for Nango items in single-tenant mode (connection owner decides)', () => {
  let db: EmptyFixtureDatabase;
  let edge: FakeEdge;
  let envObject: Record<string, string>;
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let nango: typeof import('@/lib/nango/document-adapter');
  const saved = new Map<string, string | undefined>();

  before(async () => {
    db = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' });
    await db.db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [ADMIN, 'admin-15@example.invalid', MEMBER, 'member-15@example.invalid']);
    await db.db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
    edge = await startFakeEdge({ db: db.db });
    const fixtureEnv = {
      ...fixtureProcessEnv(edge.url),
      NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE: 'single-tenant',
      MYRAG_DEPLOYMENT_MODE: 'single-tenant',
      RAG_PARSER_ALLOW_CLOUD: 'false',
      RAG_INGEST_PIPELINE: 'unified',
      RAG_UPLOAD_APPROVAL: 'members',
    };
    for (const name of Object.keys(fixtureEnv)) saved.set(name, process.env[name]);
    Object.assign(process.env, fixtureEnv);
    envObject = (await import('@/lib/env')).env as unknown as Record<string, string>;
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    nango = await import('@/lib/nango/document-adapter');
  });

  after(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await edge?.close();
    await db?.db.close();
  });

  beforeEach(() => objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore()));
  afterEach(() => objectStoreModule.resetObjectStoreForTests());

  const useSwitches = (pipeline: 'legacy' | 'unified', approval: 'off' | 'members' | 'all') => {
    for (const [name, value] of Object.entries({ RAG_INGEST_PIPELINE: pipeline, RAG_UPLOAD_APPROVAL: approval })) {
      process.env[name] = value;
      envObject[name] = value;
    }
  };

  const sync = (owner: string, token: string) =>
    nango.processDocumentWithMetadata(`drive-${token}.md`, Buffer.from(note(token)), {
      userId: owner,
      sourceProvider: 'google-drive',
      sourceFileId: `file-${token}`,
      sourceConnectionId: CONNECTION,
      nangoConnectionId: CONNECTION,
      mimeType: 'text/markdown',
    });

  const documentById = async (id: string) =>
    (await db.db.query<Row>('SELECT status, is_current, tenant_key, processing_state FROM documents WHERE id = $1', [id])).rows[0] as Row;
  const approvalOf = (document: Row) => (document.processing_state as Row).approval as Row;

  test("members: a member's connection is held and the adapter finishes without throwing", async () => {
    useSwitches('unified', 'members');
    const document = await documentById(await sync(MEMBER, 'zqxsinglemember'));
    assert.equal(document.status, 'pending_review');
    assert.equal(document.is_current, false);
    assert.equal(document.tenant_key, 's:default');
    assert.equal(approvalOf(document).uploader_id, MEMBER);
    assert.equal(approvalOf(document).reason, 'member_upload');
  });

  test("members: an admin's connection is not held", async () => {
    useSwitches('unified', 'members');
    const document = await documentById(await sync(ADMIN, 'zqxsingleadmin'));
    assert.equal(document.status, 'ready');
    assert.equal(approvalOf(document).uploader_id, ADMIN);
    assert.equal(approvalOf(document).reason, 'admin_upload');
  });

  test('members: an exempt connector lifts the hold of a member connection', async () => {
    useSwitches('unified', 'members');
    await db.db.query("INSERT INTO rag_upload_approval_exemptions (tenant_key, kind, ref, created_by) VALUES ('s:default', 'connector', $1, $2)", [CONNECTION, ADMIN]);
    try {
      const document = await documentById(await sync(MEMBER, 'zqxsingleexempt'));
      assert.equal(document.status, 'ready');
      assert.equal(approvalOf(document).reason, 'exempt_connector');
    } finally {
      await db.db.query('DELETE FROM rag_upload_approval_exemptions WHERE ref = $1', [CONNECTION]);
    }
  });

  test('legacy pipeline with approval on: the sync item fails with the refusal code and writes nothing', async () => {
    useSwitches('legacy', 'members');
    const before = Number((await db.db.query<Row>('SELECT count(*)::int AS n FROM documents')).rows[0]?.n);
    await assert.rejects(sync(ADMIN, 'zqxsinglelegacy'), (error: unknown) => (error as { code?: string }).code === REFUSAL);
    assert.equal(Number((await db.db.query<Row>('SELECT count(*)::int AS n FROM documents')).rows[0]?.n), before);
  });
});
