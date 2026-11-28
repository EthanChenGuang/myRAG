import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { count, createWorld, rows, seedLineage, verify, type PurgeWorld, type Tenant } from '../helpers/purge-fixture.mts';
import { createPgliteAdmin } from '../helpers/pglite-admin';

// Phase 6.3 (D-08, D-11, D-13, DATA-24): a file deleted at the source of a `purge` connection goes through
// applySourceDeletions and the purge library on PGlite. Purge destroys data by design: synthetic rows only.

type Deletions = typeof import('@/lib/nango/source-deletions');

describe('applySourceDeletions in purge mode (D-08, D-11)', () => {
  let world: PurgeWorld;
  let edge: FakeEdge;
  let deletions: Deletions;
  let objectStore: typeof import('@/lib/rag/ingest/object-store');
  let publicStore: typeof import('@/lib/rag/ingest/images/public-store');
  let fakeStore: typeof import('../helpers/fake-object-store');
  let fakePublic: typeof import('../helpers/fake-public-image-store');
  let personal: Tenant;

  before(async () => {
    world = await createWorld('multi-tenant');
    edge = await startFakeEdge({ db: world.db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    process.env.MYRAG_DEPLOYMENT_MODE = 'multi-tenant';
    deletions = await import('@/lib/nango/source-deletions');
    objectStore = await import('@/lib/rag/ingest/object-store');
    publicStore = await import('@/lib/rag/ingest/images/public-store');
    fakeStore = await import('../helpers/fake-object-store');
    fakePublic = await import('../helpers/fake-public-image-store');
    // Connector documents live in the owner's personal workspace (nangoOwnerScope).
    personal = { key: `u:${world.tenantA.userId}`, userId: world.tenantA.userId, orgId: null };
  });

  after(async () => {
    await edge?.close();
    await world?.db.close();
  });

  afterEach(() => {
    objectStore.resetObjectStoreForTests();
    publicStore.resetPublicImageStoreForTests();
  });

  async function insertConnection(mode: 'soft' | 'purge' | null) {
    const id = crypto.randomUUID();
    const connectionId = `conn-purge-${id.slice(0, 8)}`;
    // One connection per provider and user: each case uses its own synthetic provider name.
    const provider = `provider-${id.slice(0, 8)}`;
    await world.db.query(
      "INSERT INTO nango_connections (id, user_id, connection_id, provider, status, deletion_mode) VALUES ($1, $2, $3, $4, 'connected', $5)",
      [id, personal.userId, connectionId, provider, mode],
    );
    return { id, connection_id: connectionId, user_id: personal.userId, provider, deletion_mode: mode };
  }

  test('a purge connection removes every store of the lineage, marks citations withdrawn and records the source sync as actor', async () => {
    const objects = fakeStore.createFakeObjectStore();
    objectStore.setObjectStoreForTests(objects);
    fakePublic.installFakePublicImageStore();
    const connection = await insertConnection('purge');
    const fileId = `file-${crypto.randomUUID().slice(0, 8)}`;
    const seeded = await seedLineage(world, personal, { nango: { connectionUuid: connection.id, connectionId: connection.connection_id, fileId } });
    for (const key of seeded.objectKeys) await objects.put(key, new Uint8Array([1]), { contentType: 'text/markdown' });

    const admin = createPgliteAdmin(world.db);
    const result = await deletions.applySourceDeletions(connection, [fileId], 'change_feed', { admin: admin as never });
    assert.deepEqual(result, { removed: 1, failed: 0, deferred: 0 });

    for (const entry of await verify(world.db, personal.key, seeded.lineageId)) assert.equal(entry.remaining, 0, `store ${entry.store} still holds ${entry.remaining}`);
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 0);
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM nango_sync_records WHERE file_id = $1', [fileId]), 0);
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_semantic_cache WHERE id = $1', [seeded.cacheId]), 0);
    for (const key of seeded.objectKeys) assert.ok(!objects.keys().includes(key), `object ${key} is gone`);

    const record = (await rows(world.db, 'SELECT citations FROM rag_answer_records WHERE id = $1', [seeded.answerRecordId]))[0];
    const citation = (record?.citations as Array<Record<string, unknown>>)[0] ?? {};
    assert.equal(citation.withdrawn, true, 'the citation is a withdrawn marker');
    assert.doesNotMatch(JSON.stringify(citation), /Synthetic purge sentence/);

    const audit = await rows(world.db, 'SELECT actor_kind, actor_id, reason_code FROM rag_purge_audit WHERE lineage_id = $1', [seeded.lineageId]);
    assert.deepEqual(audit, [{ actor_kind: 'source_sync', actor_id: connection.id, reason_code: 'source_deleted' }]);
  });

  test('a lineage whose purge fails keeps its sync record and reports failed', async () => {
    objectStore.setObjectStoreForTests(fakeStore.createFakeObjectStore());
    fakePublic.installFakePublicImageStore();
    const connection = await insertConnection('purge');
    const fileId = `file-${crypto.randomUUID().slice(0, 8)}`;
    const seeded = await seedLineage(world, personal, { nango: { connectionUuid: connection.id, connectionId: connection.connection_id, fileId } });
    // A version of the lineage from another source makes the SQL refuse a source-sync purge (not_found).
    await world.db.query("UPDATE documents SET source = 'config_upload' WHERE id = $1", [seeded.versionIds[0]]);

    const admin = createPgliteAdmin(world.db);
    const result = await deletions.applySourceDeletions(connection, [fileId], 'change_feed', { admin: admin as never });
    assert.deepEqual(result, { removed: 0, failed: 1, deferred: 0 });
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM nango_sync_records WHERE file_id = $1', [fileId]), 1);
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 2);
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_purge_audit WHERE lineage_id = $1', [seeded.lineageId]), 0);
  });

  test('only an admin purge leaves a tombstone (D-35): a source-sync purge lets a restored file come back', async () => {
    objectStore.setObjectStoreForTests(fakeStore.createFakeObjectStore());
    fakePublic.installFakePublicImageStore();
    const purgeModule = await import('@/lib/rag/ingest/purge');
    const rag = await import('@/lib/rag');
    const owner = rag.nangoOwnerScope({ ownerUserId: personal.userId });
    assert.ok(owner.ok);
    const connection = await insertConnection('purge');

    const synced = `file-${crypto.randomUUID().slice(0, 8)}`;
    await seedLineage(world, personal, { nango: { connectionUuid: connection.id, connectionId: connection.connection_id, fileId: synced } });
    const admin = createPgliteAdmin(world.db);
    assert.equal((await deletions.applySourceDeletions(connection, [synced], 'change_feed', { admin: admin as never })).removed, 1);
    assert.deepEqual(await purgeModule.isPurgeTombstoned(owner.scope, connection.connection_id, synced, { signal: new AbortController().signal }), { ok: true, tombstoned: false });

    const purgedByAdmin = `file-${crypto.randomUUID().slice(0, 8)}`;
    const seeded = await seedLineage(world, personal, { nango: { connectionUuid: connection.id, connectionId: connection.connection_id, fileId: purgedByAdmin } });
    await world.db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [personal.userId]);
    const current = (await rows(world.db, 'SELECT id FROM documents WHERE lineage_id = $1 AND is_current', [seeded.lineageId]))[0];
    const byAdmin = await purgeModule.purgeDocumentAsAdmin({
      documentId: String(current?.id),
      actorUserId: personal.userId,
      reasonCode: 'owner_request',
      reasonNote: null,
      signal: new AbortController().signal,
    });
    assert.ok(byAdmin.ok, `admin purge failed: ${byAdmin.ok ? '' : byAdmin.reason}`);
    assert.deepEqual(await purgeModule.isPurgeTombstoned(owner.scope, connection.connection_id, purgedByAdmin, { signal: new AbortController().signal }), { ok: true, tombstoned: true });
  });

  test('the scheduled reconcile retries the pending objects of a source purge and scrubs a stale chat again (D-15, C-10)', async () => {
    const objects = fakeStore.createFakeObjectStore();
    objectStore.setObjectStoreForTests(objects);
    fakePublic.installFakePublicImageStore();
    const connection = await insertConnection('purge');
    const fileId = `file-${crypto.randomUUID().slice(0, 8)}`;
    const seeded = await seedLineage(world, personal, { nango: { connectionUuid: connection.id, connectionId: connection.connection_id, fileId } });
    for (const key of seeded.objectKeys) await objects.put(key, new Uint8Array([1]), { contentType: 'text/markdown' });
    const before = (await rows(world.db, 'SELECT messages FROM chats WHERE id = $1', [seeded.chatId]))[0]?.messages;
    objects.failOn('remove');

    const admin = createPgliteAdmin(world.db);
    assert.equal((await deletions.applySourceDeletions(connection, [fileId], 'change_feed', { admin: admin as never })).removed, 1);
    const pending = (await rows(world.db, 'SELECT pending_object_paths FROM rag_purge_audit WHERE lineage_id = $1', [seeded.lineageId]))[0];
    assert.ok((pending?.pending_object_paths as string[]).length > 0, 'the failed removal is pending');

    // A stale tab writes the withdrawn quote back.
    await world.db.query('UPDATE chats SET messages = $2::jsonb WHERE id = $1', [seeded.chatId, JSON.stringify(before)]);
    assert.match(JSON.stringify((await rows(world.db, 'SELECT messages FROM chats WHERE id = $1', [seeded.chatId]))[0]?.messages), /Synthetic purge sentence/);

    objects.heal();
    const reconcile = await import('@/lib/nango/reconcile');
    const result = await reconcile.runSourceReconcile({
      deadlineMs: 60_000,
      connectionId: crypto.randomUUID(),
      deps: { admin: admin as never, listFiles: async () => ({ fileIds: [], complete: false }) },
    });
    assert.ok(result.purgeRetried >= 1, `purgeRetried ${result.purgeRetried}`);
    assert.ok(result.purgeRescrubbed >= 1, `purgeRescrubbed ${result.purgeRescrubbed}`);
    assert.equal(result.purgeFailed, 0);

    const audit = (await rows(world.db, 'SELECT pending_object_paths, result FROM rag_purge_audit WHERE lineage_id = $1', [seeded.lineageId]))[0];
    assert.deepEqual(audit?.pending_object_paths, []);
    assert.equal(audit?.result, 'verified');
    for (const key of seeded.objectKeys) assert.ok(!objects.keys().includes(key), `object ${key} is gone`);
    assert.doesNotMatch(JSON.stringify((await rows(world.db, 'SELECT messages FROM chats WHERE id = $1', [seeded.chatId]))[0]?.messages), /Synthetic purge sentence/);
  });

  test('switching a connection to purge mode purges nothing by itself', async () => {
    const connection = await insertConnection(null);
    const fileId = `file-${crypto.randomUUID().slice(0, 8)}`;
    const seeded = await seedLineage(world, personal, { nango: { connectionUuid: connection.id, connectionId: connection.connection_id, fileId } });
    await world.db.query("UPDATE nango_connections SET deletion_mode = 'purge' WHERE id = $1", [connection.id]);
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 2);
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM nango_sync_records WHERE file_id = $1', [fileId]), 1);
    assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_purge_audit WHERE lineage_id = $1', [seeded.lineageId]), 0);
  });
});
