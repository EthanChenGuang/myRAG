import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { MODES, adminActor, createWorld, purge, rows, seedLineage, verify, type PurgeWorld } from '../helpers/purge-fixture.mts';

const SEAM = 'public.rag_vector_sync_enqueue_purge(text,uuid,uuid[],text,text)';

async function setTargets(db: PGlite, enabled: string[]): Promise<void> {
  await db.query('UPDATE public.rag_vector_sync_targets SET enabled = (target = ANY($1::text[]))', [enabled]);
}

async function hasSeam(db: PGlite): Promise<boolean> {
  return (await rows(db, 'SELECT pg_catalog.to_regprocedure($1) IS NOT NULL AS present', [SEAM]))[0]?.present === true;
}

for (const mode of MODES) {
  describe(`purge and the vector sync outbox (${mode})`, () => {
    let world: PurgeWorld;
    let seam: boolean;

    before(async () => {
      world = await createWorld(mode);
      seam = await hasSeam(world.db);
    });

    after(async () => {
      await world?.db.close();
    });

    beforeEach(async () => {
      await setTargets(world.db, []);
      await world.db.exec('DELETE FROM public.vector_sync_outbox');
      if (seam) await world.db.exec('DELETE FROM public.vector_sync_purges');
    });

    test('no target enabled: the purge writes no outbox row and no purge ledger row', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      assert.deepEqual(await rows(world.db, 'SELECT * FROM public.vector_sync_outbox'), []);
      const checked = await verify(world.db, world.tenantA.key, seeded.lineageId);
      if (seam) {
        assert.deepEqual(await rows(world.db, 'SELECT * FROM public.vector_sync_purges'), []);
        const external = checked.filter((row) => row.store.startsWith('external:'));
        assert.ok(external.length > 0);
        for (const row of external) assert.deepEqual([row.state, row.remaining], ['not_applicable', 0]);
      } else {
        assert.ok(!checked.some((row) => row.store.startsWith('external:')), 'without 0740 verify reports no external store');
      }
    });

    test('qdrant enabled without 0740: one pending document row per purged version', { skip: false }, async (t) => {
      if (seam) {
        t.skip('0740 is present; the purge seam case covers this database');
        return;
      }
      await setTargets(world.db, ['qdrant']);
      const seeded = await seedLineage(world, world.tenantA);
      await world.db.exec('DELETE FROM public.vector_sync_outbox');
      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      const outbox = await rows(world.db, 'SELECT target, entity, entity_id, tenant_key, status FROM public.vector_sync_outbox ORDER BY entity_id');
      assert.deepEqual(
        outbox,
        [...seeded.versionIds].sort().map((id) => ({ target: 'qdrant', entity: 'document', entity_id: id, tenant_key: world.tenantA.key, status: 'pending' })),
      );
    });

    test('qdrant enabled with 0740: one purge ledger row with every version and one purge outbox row; verify follows the target state', async (t) => {
      if (!seam) {
        t.skip('0740 is not on this branch; the 0702 trigger case covers this database');
        return;
      }
      await setTargets(world.db, ['qdrant']);
      const seeded = await seedLineage(world, world.tenantA);
      await world.db.exec('DELETE FROM public.vector_sync_outbox');
      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      const ledger = await rows(world.db, 'SELECT id, tenant_key, lineage_id, document_ids, requested_by, reason_code FROM public.vector_sync_purges');
      assert.equal(ledger.length, 1);
      assert.deepEqual([...(ledger[0]?.document_ids as string[])].sort(), [...seeded.versionIds].sort());
      assert.equal(ledger[0]?.requested_by, `admin:${world.adminA}`);
      assert.equal(ledger[0]?.reason_code, 'added_in_error');
      const purgeId = String(ledger[0]?.id);
      const purgeRows = await rows(world.db, "SELECT id, target, status FROM public.vector_sync_outbox WHERE entity = 'purge' AND entity_id = $1", [purgeId]);
      assert.deepEqual(purgeRows.map((row) => [row.target, row.status]), [['qdrant', 'pending']]);
      const documentRows = await rows(world.db, "SELECT entity_id FROM public.vector_sync_outbox WHERE entity = 'document' ORDER BY entity_id");
      assert.deepEqual(documentRows.map((row) => row.entity_id), [...seeded.versionIds].sort());

      const external = async () => (await verify(world.db, world.tenantA.key, seeded.lineageId)).find((row) => row.store === 'external:qdrant');
      assert.deepEqual(await external(), { store: 'external:qdrant', remaining: 1, state: 'pending' });

      await world.db.query("UPDATE public.vector_sync_outbox SET status = 'dead' WHERE id = $1", [purgeRows[0]?.id]);
      assert.deepEqual(await external(), { store: 'external:qdrant', remaining: 1, state: 'dead' });

      await world.db.query("UPDATE public.vector_sync_outbox SET status = 'done' WHERE id = $1", [purgeRows[0]?.id]);
      await world.db.query("SELECT public.rag_vector_sync_purge_complete($1::uuid, 'qdrant', 1, 4)", [purgeId]);
      assert.deepEqual(await external(), { store: 'external:qdrant', remaining: 0, state: 'done' });
    });
  });
}
