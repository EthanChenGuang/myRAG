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
