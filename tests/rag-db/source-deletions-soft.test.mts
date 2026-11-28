import { after, afterEach, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase, type TwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin';
import type { TenantScope } from '@/lib/rag';

/**
 * Phase 6.3 tracer (D-03, D-08): a file removed at the source of a `soft` connection goes through
 * applySourceDeletions, the existing soft-delete SQL and runRetrieval on PGlite, multi-tenant mode.
 */

type Row = Record<string, unknown>;

const OPTIONS = { maxResults: 25, fallbackToLowerThreshold: true };
const TOKEN = 'zqxsrcdel4417';
const CONNECTION_A = 'conn-source-del-a';
const markdown = (body: string) => `# Field notes\n\n${body}\n`;

describe('applySourceDeletions in soft mode (D-03, D-08)', () => {
  let fixture: TwoTenantDatabase;
  let edge: FakeEdge;
  let rag: typeof import('@/lib/rag');
  let ingestModule: typeof import('@/lib/rag/ingest');
  let depsModule: typeof import('@/lib/rag/ingest/deps');
  let objectStoreModule: typeof import('@/lib/rag/ingest/object-store');
  let fakeStoreModule: typeof import('../helpers/fake-object-store');
  let resolver: typeof import('@/lib/rag/tenant/resolve-chat');
  let supabaseModule: typeof import('@/lib/supabase');
  let deletions: typeof import('@/lib/nango/source-deletions');

  let scopeA: TenantScope;
  let scopeB: TenantScope;
  let counter = 0;

  before(async () => {
    fixture = await createTwoTenantDatabase();
    edge = await startFakeEdge({ db: fixture.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    rag = await import('@/lib/rag');
    ingestModule = await import('@/lib/rag/ingest');
    depsModule = await import('@/lib/rag/ingest/deps');
    objectStoreModule = await import('@/lib/rag/ingest/object-store');
    fakeStoreModule = await import('../helpers/fake-object-store');
    resolver = await import('@/lib/rag/tenant/resolve-chat');
    supabaseModule = await import('@/lib/supabase');
    deletions = await import('@/lib/nango/source-deletions');
    scopeA = await scopeOf(TWO_TENANT_IDS.userA);
    scopeB = await scopeOf(TWO_TENANT_IDS.userB);
  });

  after(async () => {
    await edge?.close();
    await fixture?.db.close();
  });

  afterEach(() => {
    objectStoreModule.resetObjectStoreForTests();
    depsModule.resetIngestDepsForTests();
    mock.restoreAll();
  });

  async function scopeOf(userId: string) {
    const resolved = await resolver.resolveTenantScope({
      requestedOrganizationId: null,
      deploymentMode: 'multi-tenant',
      getUser: async () => ({ id: userId }),
      admin: supabaseModule.getSupabaseAdmin(),
      signal: new AbortController().signal,
    });
    assert.ok(resolved.ok && resolved.scope, 'scope must resolve');
    return resolved.scope;
  }

  const rows = async (sql: string, params: unknown[]): Promise<Row[]> => (await fixture.db.query<Row>(sql, params)).rows;

  async function ingestNango(scope: TenantScope, connectionId: string, fileId: string, label: string) {
    objectStoreModule.setObjectStoreForTests(fakeStoreModule.createFakeObjectStore());
    counter += 1;
    const body = `${TOKEN} ${label} case ${counter}: sample rows about synthetic widgets and gauges.`;
    const ready = await ingestModule.ingest({
      scope,
      source: 'nango',
      sourceKey: fileId,
      text: markdown(body),
      filename: `${fileId}.md`,
      mimeType: 'text/markdown',
      options: { origin: { sourceProvider: 'google-drive', sourceFileId: fileId, sourceConnectionId: connectionId } },
      signal: new AbortController().signal,
    });
    assert.equal(ready.status, 'ready');
    assert.ok(ready.documentId);
    const lineage = await rows('SELECT lineage_id FROM documents WHERE id = $1', [ready.documentId]);
    return { documentId: String(ready.documentId), lineageId: String(lineage[0]?.lineage_id ?? ready.documentId), query: body };
  }

  async function insertConnection(userId: string, connectionId: string, mode: 'soft' | 'purge' | null, provider = 'google-drive') {
    const id = crypto.randomUUID();
    await fixture.db.query(
      "INSERT INTO nango_connections (id, user_id, connection_id, provider, status, deletion_mode) VALUES ($1, $2, $3, $5, 'connected', $4)",
      [id, userId, connectionId, mode, provider],
    );
    return { id, connection_id: connectionId, user_id: userId, provider, deletion_mode: mode };
  }

  async function insertSyncRecord(userId: string, connectionId: string, fileId: string, documentId: string | null) {
    await fixture.db.query(
      "INSERT INTO nango_sync_records (user_id, connection_id, provider, file_id, file_name, document_id, status) VALUES ($1, $2, 'google-drive', $3, $4, $5, 'completed')",
      [userId, connectionId, fileId, `${fileId}.md`, documentId],
    );
  }

  const retrieve = async (scope: TenantScope, query: string) =>
    rag.runRetrieval({ scope, query, profile: 'eval', options: OPTIONS, signal: new AbortController().signal });

  const hits = async (scope: TenantScope, query: string, lineageId: string) => {
    const docIds = (await rows('SELECT id FROM documents WHERE lineage_id = $1', [lineageId])).map((row) => String(row.id));
    const result = await retrieve(scope, query);
    return result.candidates.some((candidate) => docIds.includes(candidate.document_id));
  };

  test('a soft connection removes the file from retrieval, keeps its versions and drops the sync record; a repeat is a no-op', async () => {
    const connection = await insertConnection(TWO_TENANT_IDS.userA, CONNECTION_A, 'soft');
    const fileId = 'file-soft-a';
    const doc = await ingestNango(scopeA, CONNECTION_A, fileId, 'alpha');
    await insertSyncRecord(TWO_TENANT_IDS.userA, CONNECTION_A, fileId, doc.documentId);
    assert.equal(await hits(scopeA, doc.query, doc.lineageId), true, 'a retrieval candidate before the deletion');

    const admin = createPgliteAdmin(fixture.db);
    const first = await deletions.applySourceDeletions(connection, [fileId], 'change_feed', { admin: admin as never });
    assert.equal(first.removed, 1);
    assert.equal(first.failed, 0);

    assert.equal(await hits(scopeA, doc.query, doc.lineageId), false, 'no retrieval candidate after the deletion');
    const versions = await rows('SELECT status, is_current FROM documents WHERE lineage_id = $1', [doc.lineageId]);
    assert.ok(versions.length > 0, 'versions are kept');
    assert.ok(versions.every((row) => row.status === 'deleted' && row.is_current === false));
    assert.equal((await rows('SELECT 1 FROM nango_sync_records WHERE file_id = $1', [fileId])).length, 0);

    const runs = await rows("SELECT origin, status, tenant_key FROM rag_source_reconcile_runs WHERE connection_id = $1::uuid", [connection.id]);
    assert.deepEqual(runs, [{ origin: 'change_feed', status: 'completed', tenant_key: `u:${TWO_TENANT_IDS.userA}` }]);

    const second = await deletions.applySourceDeletions(connection, [fileId], 'change_feed', { admin: admin as never });
    assert.equal(second.removed, 0);
    assert.equal(second.failed, 0);
  });

  test("another tenant's document under the same connection and file id is never touched", async () => {
    const connectionId = 'conn-source-del-shared';
    const connection = await insertConnection(TWO_TENANT_IDS.userA, connectionId, 'soft', 'dropbox');
    const fileId = 'file-shared-b';
    const docB = await ingestNango(scopeB, connectionId, fileId, 'bravo');
    await insertSyncRecord(TWO_TENANT_IDS.userA, connectionId, fileId, null);

    const admin = createPgliteAdmin(fixture.db);
    const result = await deletions.applySourceDeletions(connection, [fileId], 'change_feed', { admin: admin as never });
    assert.equal(result.failed, 0);

    const versions = await rows('SELECT status, is_current FROM documents WHERE lineage_id = $1', [docB.lineageId]);
    assert.ok(versions.length > 0);
    assert.ok(versions.every((row) => row.status === 'ready' && row.is_current === true), "tenant B's lineage stays current");
    assert.equal(await hits(scopeB, docB.query, docB.lineageId), true, 'tenant B still retrieves its document');
  });
});
