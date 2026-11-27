import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { MODES, TEXT_LEAKS, count, createWorld, rows, seedLineage, type PurgeWorld, type SeededLineage } from '../helpers/purge-fixture.mts';

// Purge destroys data by design: these cases run only on PGlite fixture databases with synthetic rows.

type PurgeModule = typeof import('@/lib/rag/ingest/purge');
type ObjectStoreModule = typeof import('@/lib/rag/ingest/object-store');
type PublicStoreModule = typeof import('@/lib/rag/ingest/images/public-store');
type FakeStoreModule = typeof import('../helpers/fake-object-store');
type FakePublicModule = typeof import('../helpers/fake-public-image-store');

const signal = () => new AbortController().signal;

let edge: FakeEdge | null = null;
let purge: PurgeModule;
let objectStore: ObjectStoreModule;
let publicStore: PublicStoreModule;
let fakeStore: FakeStoreModule;
let fakePublic: FakePublicModule;

async function ready(world: PurgeWorld): Promise<void> {
  process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = world.mode;
  process.env.MYRAG_DEPLOYMENT_MODE = world.mode;
  if (edge) {
    edge.useDatabase(world.db);
    return;
  }
  edge = await startFakeEdge({ db: world.db });
  Object.assign(process.env, fixtureProcessEnv(edge.url));
  purge = await import('@/lib/rag/ingest/purge');
  objectStore = await import('@/lib/rag/ingest/object-store');
  publicStore = await import('@/lib/rag/ingest/images/public-store');
  fakeStore = await import('../helpers/fake-object-store');
  fakePublic = await import('../helpers/fake-public-image-store');
}

after(async () => {
  await edge?.close();
});

async function currentVersion(world: PurgeWorld, seeded: SeededLineage): Promise<string> {
  const row = (await rows(world.db, 'SELECT id FROM documents WHERE lineage_id = $1 AND is_current', [seeded.lineageId]))[0];
  assert.ok(row, 'the seeded lineage has a current version');
  return String(row.id);
}

for (const mode of MODES) {
  describe(`purge library (${mode})`, () => {
    let world: PurgeWorld;

    before(async () => {
      world = await createWorld(mode);
      await ready(world);
    });

    after(async () => {
      await world?.db.close();
    });

    afterEach(() => {
      objectStore.resetObjectStoreForTests();
      publicStore.resetPublicImageStoreForTests();
    });

    test('an admin purge removes every database store and reads verified with every left count 0', async () => {
      objectStore.setObjectStoreForTests(fakeStore.createFakeObjectStore());
      fakePublic.installFakePublicImageStore();
      const seeded = await seedLineage(world, world.tenantA);
      const documentId = await currentVersion(world, seeded);

      const result = await purge.purgeDocumentAsAdmin({
        documentId,
        actorUserId: world.adminA,
        reasonCode: 'added_in_error',
        reasonNote: null,
        signal: signal(),
      });
      assert.ok(result.ok, `purge failed: ${result.ok ? '' : result.reason}`);
      assert.equal(result.lineageId, seeded.lineageId);
      assert.equal(result.removed.documents, 2);
      assert.equal(result.removed.chunks, 4);
      assert.equal(result.removed.vectors, 4);
      assert.equal(result.check.result, 'verified');
      assert.ok(Object.keys(result.check.left).length >= 10);
      for (const [store, left] of Object.entries(result.check.left)) assert.equal(left, 0, `store ${store} still holds ${left}`);
      assert.equal(result.check.pendingFiles, 0);
      assert.equal(result.check.queuedExternal, 0);
      assert.ok(!Number.isNaN(Date.parse(result.check.checkedAt)));

      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 0);
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM document_chunks WHERE id = ANY ($1::uuid[])', [seeded.chunkIds]), 0);
      const audit = (await rows(world.db, 'SELECT actor_kind, actor_id, reason_code, result, verification, verification_checked_at FROM rag_purge_audit WHERE id = $1', [result.auditId]))[0];
      assert.ok(audit, 'the audit row exists');
      assert.equal(audit.actor_kind, 'admin');
      assert.equal(audit.actor_id, world.adminA);
      assert.equal(audit.reason_code, 'added_in_error');
      assert.equal(audit.result, 'verified');
      assert.ok(audit.verification_checked_at, 'the check time is stored');
      assert.equal((audit.verification as { result?: string }).result, 'verified');
      assert.doesNotMatch(JSON.stringify(audit), TEXT_LEAKS);
    });

    test('an unknown id and a document the admin does not administer answer the same not_found and purge nothing', async () => {
      objectStore.setObjectStoreForTests(fakeStore.createFakeObjectStore());
      fakePublic.installFakePublicImageStore();
      const unknown = await purge.purgeDocumentAsAdmin({
        documentId: crypto.randomUUID(),
        actorUserId: world.adminA,
        reasonCode: 'owner_request',
        reasonNote: null,
        signal: signal(),
      });
      assert.deepEqual(unknown, { ok: false, reason: 'not_found' });

      const target = world.tenantB ?? world.tenantA;
      const actor = world.tenantB ? world.adminA : world.outsider;
      const seeded = await seedLineage(world, target);
      const refused = await purge.purgeDocumentAsAdmin({
        documentId: await currentVersion(world, seeded),
        actorUserId: actor,
        reasonCode: 'owner_request',
        reasonNote: null,
        signal: signal(),
      });
      assert.deepEqual(refused, unknown);
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 2);
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_purge_audit WHERE lineage_id = $1', [seeded.lineageId]), 0);
    });

    test('the stored files, parse-cache objects and page pictures of the lineage are gone after the purge; other lineages stay', async () => {
      const objects = fakeStore.createFakeObjectStore();
      objectStore.setObjectStoreForTests(objects);
      const pictures = fakePublic.installFakePublicImageStore();
      const seeded = await seedLineage(world, world.tenantA);
      const other = await seedLineage(world, world.tenantA);
      for (const key of [...seeded.objectKeys, ...other.objectKeys]) await objects.put(key, new Uint8Array([1]), { contentType: 'text/markdown' });
      await objects.put(`${seeded.parsePrefix}result.json`, new Uint8Array([1]), { contentType: 'application/json' });
      await objects.put(`${other.parsePrefix}result.json`, new Uint8Array([1]), { contentType: 'application/json' });
      const picture = `rag/${world.tenantA.key}/${seeded.lineageId}/2/p1-1.png`;
      const otherPicture = `rag/${world.tenantA.key}/${other.lineageId}/2/p1-1.png`;
      for (const key of [picture, otherPicture]) await pictures.put(key, new Uint8Array([1]), { contentType: 'image/png' });

      const result = await purge.purgeDocumentAsAdmin({
        documentId: await currentVersion(world, seeded),
        actorUserId: world.adminA,
        reasonCode: 'retention_ended',
        reasonNote: null,
        signal: signal(),
      });
      assert.ok(result.ok);
      assert.equal(result.check.result, 'verified');
      assert.deepEqual(
        objects.keys().filter((key) => key.includes(seeded.lineageId) || key.startsWith(seeded.parsePrefix)),
        [],
      );
      assert.deepEqual(pictures.keys(), [otherPicture]);
      for (const key of other.objectKeys) assert.ok(objects.keys().includes(key), 'another lineage keeps its files');
      assert.ok(objects.keys().includes(`${other.parsePrefix}result.json`));
      assert.equal(result.removed.original_files, 4);
      assert.equal(result.removed.parse_cache_files, 1);
      assert.equal(result.removed.page_images, 1);
      const audit = (await rows(world.db, 'SELECT pending_object_paths, object_counts FROM rag_purge_audit WHERE id = $1', [result.auditId]))[0];
      assert.deepEqual(audit?.pending_object_paths, []);
      assert.equal((audit?.object_counts as Record<string, number>).original_files, 4);
    });

    test('the records list holds only the tenants the admin administers, newest first, with ids and counts, and a check can run again', async () => {
      objectStore.setObjectStoreForTests(fakeStore.createFakeObjectStore());
      fakePublic.installFakePublicImageStore();
      const own = await seedLineage(world, world.tenantA);
      const purged = await purge.purgeDocumentAsAdmin({
        documentId: await currentVersion(world, own),
        actorUserId: world.adminA,
        reasonCode: 'other',
        reasonNote: 'A synthetic note.',
        signal: signal(),
      });
      assert.ok(purged.ok);
      let foreignAudit: string | null = null;
      if (world.tenantB) {
        const foreign = await seedLineage(world, world.tenantB);
        const other = await purge.purgeDocumentAsAdmin({
          documentId: await currentVersion(world, foreign),
          actorUserId: world.outsider,
          reasonCode: 'owner_request',
          reasonNote: null,
          signal: signal(),
        });
        assert.ok(other.ok);
        foreignAudit = other.auditId;
      }

      const listed = await purge.listPurgeRecords({ actorUserId: world.adminA, limit: 100, offset: 0, signal: signal() });
      assert.ok(listed.ok);
      const ids = listed.records.map((record) => record.id);
      assert.ok(ids.includes(purged.auditId));
      if (foreignAudit) assert.ok(!ids.includes(foreignAudit), 'another tenant record is never listed');
      for (const record of listed.records) assert.equal(record.workspaceKey, world.tenantA.key);
      const starts = listed.records.map((record) => Date.parse(record.startedAt));
      assert.deepEqual(starts, [...starts].sort((a, b) => b - a));
      const mine = listed.records.find((record) => record.id === purged.auditId);
      assert.ok(mine);
      assert.equal(mine.actorKind, 'admin');
      assert.equal(mine.actorId, world.adminA);
      assert.equal(mine.reasonCode, 'other');
      assert.equal(mine.versionCount, 2);
      assert.equal(mine.result, 'verified');
      assert.equal(mine.removed.documents, 2);
      assert.doesNotMatch(JSON.stringify(listed.records), TEXT_LEAKS);
      assert.doesNotMatch(JSON.stringify(listed.records), /[0-9a-f]{64}|_parse-cache/);

      const again = await purge.reverifyPurgeAsAdmin({ auditId: purged.auditId, actorUserId: world.adminA, signal: signal() });
      assert.ok(again.ok);
      assert.equal(again.check.result, 'verified');
      if (foreignAudit) {
        const refused = await purge.reverifyPurgeAsAdmin({ auditId: foreignAudit, actorUserId: world.adminA, signal: signal() });
        const unknown = await purge.reverifyPurgeAsAdmin({ auditId: crypto.randomUUID(), actorUserId: world.adminA, signal: signal() });
        assert.deepEqual(refused, { ok: false, reason: 'not_found' });
        assert.deepEqual(unknown, refused);
      }
    });

    test('ids that are not uuids are refused before any call', async () => {
      const result = await purge.purgeDocumentAsAdmin({
        documentId: 'not-a-uuid',
        actorUserId: world.adminA,
        reasonCode: 'owner_request',
        reasonNote: null,
        signal: signal(),
      });
      assert.deepEqual(result, { ok: false, reason: 'invalid_argument' });
    });
  });
}
