import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MODES,
  adminActor,
  asRole,
  count,
  createWorld,
  errorOf,
  purge,
  rows,
  seedLineage,
  verify,
  type PurgeWorld,
  type SeededLineage,
} from '../helpers/purge-fixture.mts';

const FOREIGN_KEYS = ['translations', 'translation_gaps', 'table_rows', 'duplicate_groups', 'supersession', 'rebuild', 'recaption', 'golden_items'];
const hex = (): string => crypto.randomBytes(16).toString('hex');

async function seedTranslations(world: PurgeWorld, seeded: SeededLineage, tenantKey: string): Promise<void> {
  await world.db.query(
    `INSERT INTO chunk_translations (chunk_id, document_id, tenant_key, language, content, source_content_hash, model)
     SELECT c.id, c.document_id, $2, 'it', 'A synthetic translated sentence.', $3, 'synthetic-model'
       FROM document_chunks c WHERE c.id = ANY ($1::uuid[])`,
    [seeded.chunkIds, tenantKey, hex()],
  );
}

async function seedTableRows(world: PurgeWorld, seeded: SeededLineage, tenantKey: string): Promise<void> {
  for (const [index, documentId] of seeded.versionIds.entries()) {
    await world.db.query(
      `INSERT INTO rag_table_rows (tenant_key, document_id, version, is_current, status, table_key, row_index, chunk_ids)
       VALUES ($1, $2, $3, $4, 'ready', 'synthetic-table', 0, $5::uuid[])`,
      [tenantKey, documentId, index + 1, index === 1, seeded.chunkIds],
    );
  }
}

async function seedCluster(world: PurgeWorld, tenantKey: string, documentIds: string[]): Promise<string> {
  const result = await rows(
    world.db,
    `INSERT INTO rag_dup_clusters (tenant_key, embedding_profile_id, source_document_ids, member_count)
     VALUES ($1, 'synthetic-profile', $2::uuid[], $3) RETURNING id`,
    [tenantKey, documentIds, documentIds.length],
  );
  const id = String(result[0]?.id);
  // A real cluster has chunk memberships too (document_chunks.dup_cluster_id); the 4.2 reserved hook (0864) counts and removes those.
  await world.db.query('UPDATE document_chunks SET dup_cluster_id = $1 WHERE tenant_key = $2 AND document_id = ANY ($3::uuid[])', [id, tenantKey, documentIds]);
  return id;
}

for (const mode of MODES) {
  describe(`rag_purge_foreign_stores with every migration applied (${mode})`, () => {
    let world: PurgeWorld;

    before(async () => {
      world = await createWorld(mode);
    });

    after(async () => {
      await world?.db.close();
    });

    test('translations, table rows and cluster memberships of the lineage are removed, counted and verified; another lineage keeps its rows', async () => {
      const { db } = world;
      const tenantKey = world.tenantA.key;
      const target = await seedLineage(world, world.tenantA);
      const other = await seedLineage(world, world.tenantA);
      for (const seeded of [target, other]) {
        await seedTranslations(world, seeded, tenantKey);
        await seedTableRows(world, seeded, tenantKey);
      }
      const shared = await seedCluster(world, tenantKey, [target.versionIds[1] as string, other.versionIds[1] as string]);

      const result = await purge(db, tenantKey, target.lineageId, adminActor(world.adminA));

      assert.equal(result.counts.translations, target.chunkIds.length);
      assert.equal(result.counts.table_rows, 2);
      assert.ok(Number(result.counts.duplicate_groups) >= 1, 'the shared cluster is updated');
      for (const key of ['translation_gaps', 'supersession', 'rebuild', 'recaption']) assert.equal(result.counts[key], 0, key);

      assert.equal(await count(db, 'SELECT count(*) AS n FROM chunk_translations WHERE document_id = ANY ($1::uuid[])', [target.versionIds]), 0);
      assert.equal(await count(db, 'SELECT count(*) AS n FROM rag_table_rows WHERE document_id = ANY ($1::uuid[])', [target.versionIds]), 0);
      assert.equal(await count(db, 'SELECT count(*) AS n FROM chunk_translations WHERE document_id = ANY ($1::uuid[])', [other.versionIds]), other.chunkIds.length);
      assert.equal(await count(db, 'SELECT count(*) AS n FROM rag_table_rows WHERE document_id = ANY ($1::uuid[])', [other.versionIds]), 2);
      // The shared cluster no longer names the purged versions: the 0853 hook leaves it dirty for recompute, the reserved 0864 hook
      // recomputes it at once (a cluster left with one member dissolves). Either way no chunk of the purged lineage is a member.
      const cluster = await rows(db, 'SELECT source_document_ids FROM rag_dup_clusters WHERE id = $1', [shared]);
      for (const row of cluster) {
        for (const id of target.versionIds) assert.ok(!(row.source_document_ids as string[]).includes(id), 'the cluster drops the purged version');
      }
      assert.equal(
        await count(db, 'SELECT count(*) AS n FROM document_chunks WHERE dup_cluster_id = $1 AND document_id = ANY ($2::uuid[])', [shared, target.versionIds]),
        0,
      );

      const remaining = new Map((await verify(db, tenantKey, target.lineageId)).map((row) => [row.store, row.remaining]));
      for (const key of ['translations', 'translation_gaps', 'table_rows', 'duplicate_groups', 'supersession', 'rebuild', 'recaption']) {
        assert.equal(remaining.get(key), 0, `verify ${key}`);
      }
    });

    test('rag_purge_foreign_leftovers counts the rows a purge has not removed yet', async () => {
      const tenantKey = world.tenantA.key;
      const seeded = await seedLineage(world, world.tenantA);
      await seedTranslations(world, seeded, tenantKey);
      await seedTableRows(world, seeded, tenantKey);
      await seedCluster(world, tenantKey, seeded.versionIds);
      const leftovers = new Map(
        (await rows(world.db, 'SELECT store, remaining FROM public.rag_purge_foreign_leftovers($1, $2, $3::uuid[])', [tenantKey, seeded.lineageId, seeded.versionIds])).map(
          (row) => [String(row.store), Number(row.remaining)],
        ),
      );
      assert.equal(leftovers.get('translations'), seeded.chunkIds.length);
      assert.equal(leftovers.get('table_rows'), 2);
      assert.equal(leftovers.get('duplicate_groups'), 1);
    });

    if (mode === 'multi-tenant') {
      test("another tenant's key removes nothing of tenant A's stores", async () => {
        const tenantB = world.tenantB;
        assert.ok(tenantB);
        const seeded = await seedLineage(world, world.tenantA);
        await seedTranslations(world, seeded, world.tenantA.key);
        await seedTableRows(world, seeded, world.tenantA.key);
        // The reserved 4.2 hooks (0864) refuse ids of another tenant with 22023; without them the guarded deletes match nothing.
        let refusedCode: string | null = null;
        try {
          await world.db.query('SELECT public.rag_purge_foreign_stores($1, $2, $3::uuid[])', [tenantB.key, seeded.lineageId, seeded.versionIds]);
        } catch (error) {
          refusedCode = String((error as { code?: unknown }).code ?? 'unknown');
        }
        assert.ok(refusedCode === null || refusedCode === '22023', `no-op or 22023, got ${refusedCode}`);
        assert.equal(await count(world.db, 'SELECT count(*) AS n FROM chunk_translations WHERE document_id = ANY ($1::uuid[])', [seeded.versionIds]), seeded.chunkIds.length);
        assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_table_rows WHERE document_id = ANY ($1::uuid[])', [seeded.versionIds]), 2);
      });
    }

    test('anon and authenticated get 42501 on the foreign-store functions', async () => {
      const args = [world.tenantA.key, crypto.randomUUID(), [crypto.randomUUID()]];
      for (const role of ['anon', 'authenticated'] as const) {
        for (const sql of ['SELECT public.rag_purge_foreign_stores($1, $2::uuid, $3::uuid[])', 'SELECT * FROM public.rag_purge_foreign_leftovers($1, $2::uuid, $3::uuid[])']) {
          const refused = await errorOf(() => asRole(world.db, role, world.adminA, () => world.db.query(sql, args)));
          assert.equal(refused.code, '42501', `${role} ${sql}`);
        }
      }
    });
  });

  describe(`rag_purge_foreign_stores calls the Phase 3.3 and Phase 6.1 hooks (${mode})`, () => {
    let world: PurgeWorld;

    before(async () => {
      world = await createWorld(mode);
    });

    after(async () => {
      await world?.db.close();
    });

    async function stage(tenantKey: string, seeded: SeededLineage): Promise<void> {
      await world.db.query(
        `INSERT INTO public.rag_staged_attributes (tenant_key, source, source_key, attributes)
         VALUES ($1, 'config_upload', $2, '{"alpha_code": "K-1"}'::jsonb)`,
        [tenantKey, seeded.sourceKey],
      );
    }

    async function insertVersion(id: string, tenantKeys: string[]): Promise<void> {
      await world.db.query(
        `INSERT INTO public.embedding_model_versions
           (id, base_model, base_revision, scope, tenant_keys, dataset_manifest_sha256, training_config_sha256, offline_metrics, probe,
            query_prompt, document_prompt, dims, artifact_uri, created_by)
         VALUES ($1, 'example-org/example-embedding', $2, 'deployment', $3::text[], $4, $5, '{}'::jsonb, '{}'::jsonb, 'query: ', 'passage: ',
                 1024, $6, 'admin:test')`,
        [id, 'a'.repeat(40), [...tenantKeys].sort(), 'b'.repeat(64), 'c'.repeat(64), `s3://models-bucket/${id}`],
      );
    }

    const versionStatus = async (id: string): Promise<string> =>
      String((await rows(world.db, 'SELECT status FROM public.embedding_model_versions WHERE id = $1', [id]))[0]?.status);

    test('a purge deletes the lineage\'s staged attributes, counts and verifies doc_attributes; another lineage keeps its row', async () => {
      const tenantKey = world.tenantA.key;
      const target = await seedLineage(world, world.tenantA);
      const other = await seedLineage(world, world.tenantA);
      await stage(tenantKey, target);
      await stage(tenantKey, other);
      const before = new Map(
        (await rows(world.db, 'SELECT store, remaining FROM public.rag_purge_foreign_leftovers($1, $2, $3::uuid[])', [tenantKey, target.lineageId, target.versionIds])).map(
          (row) => [String(row.store), Number(row.remaining)],
        ),
      );
      assert.equal(before.get('doc_attributes'), 1, 'leftovers see the staged row before the purge');

      const result = await purge(world.db, tenantKey, target.lineageId, adminActor(world.adminA));
      assert.ok(Number(result.counts.doc_attributes) >= 1, 'counts.doc_attributes');
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM public.rag_staged_attributes WHERE tenant_key = $1 AND source_key = $2', [tenantKey, target.sourceKey]), 0);
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM public.rag_staged_attributes WHERE tenant_key = $1 AND source_key = $2', [tenantKey, other.sourceKey]), 1);
      const remaining = new Map((await verify(world.db, tenantKey, target.lineageId)).map((row) => [row.store, row.remaining]));
      assert.equal(remaining.get('doc_attributes'), 0, 'verify doc_attributes');
    });

    test('a purge taints the fine-tune versions trained on the tenant, counts and verifies finetune', async () => {
      const tenantKey = world.tenantA.key;
      const trained = `ft-${crypto.randomUUID().slice(0, 8)}`;
      await insertVersion(trained, [tenantKey]);
      const untouched = `ft-${crypto.randomUUID().slice(0, 8)}`;
      if (world.tenantB) await insertVersion(untouched, [world.tenantB.key]);
      const seeded = await seedLineage(world, world.tenantA);

      const result = await purge(world.db, tenantKey, seeded.lineageId, adminActor(world.adminA));
      assert.ok(Number(result.counts.finetune) >= 1, 'counts.finetune');
      assert.equal(await versionStatus(trained), 'tainted');
      if (world.tenantB) assert.notEqual(await versionStatus(untouched), 'tainted', "another tenant's version is not tainted");
      const remaining = new Map((await verify(world.db, tenantKey, seeded.lineageId)).map((row) => [row.store, row.remaining]));
      assert.equal(remaining.get('finetune'), 0, 'verify finetune');
    });

    test('verify reports a fine-tune version trained on the tenant that the purge left untainted', async () => {
      const tenantKey = world.tenantA.key;
      const seeded = await seedLineage(world, world.tenantA);
      await purge(world.db, tenantKey, seeded.lineageId, adminActor(world.adminA));
      const late = `ft-${crypto.randomUUID().slice(0, 8)}`;
      await insertVersion(late, [tenantKey]);
      await world.db.query("UPDATE public.embedding_model_versions SET created_at = now() - interval '1 day' WHERE id = $1", [late]);
      const remaining = new Map((await verify(world.db, tenantKey, seeded.lineageId)).map((row) => [row.store, row.remaining]));
      assert.equal(remaining.get('finetune'), 1, 'an untainted version that existed before the purge is a leftover');
    });

    test('the inventory lists the staged attributes, the fine-tune stores and the Phase 3.3 rule tables with their handling', async () => {
      const inventory = new Map((await rows(world.db, 'SELECT relation, store_id, handling FROM public.rag_purge_store_inventory()')).map((row) => [String(row.relation), row]));
      assert.deepEqual([inventory.get('rag_staged_attributes')?.handling, inventory.get('rag_staged_attributes')?.store_id], ['purge_step', 'doc_attributes']);
      assert.deepEqual([inventory.get('embedding_model_versions')?.handling, inventory.get('embedding_model_versions')?.store_id], ['purge_step', 'finetune']);
      assert.deepEqual([inventory.get('rag_finetune_consent')?.handling, inventory.get('rag_finetune_consent')?.store_id], ['purge_step', 'finetune']);
      for (const relation of ['rag_section_rule_sets', 'rag_boilerplate_rules', 'rag_attribute_definitions', 'rag_attribute_header_templates']) {
        assert.equal(inventory.get(relation)?.handling, 'exempt', relation);
      }
    });
  });

  describe(`rag_purge_foreign_stores on a trunk without the other phases' stores (${mode})`, () => {
    let world: PurgeWorld;

    before(async () => {
      world = await createWorld(mode, { migrationsThrough: '0728' });
    });

    after(async () => {
      await world?.db.close();
    });

    test('with no foreign relation or hook the purge succeeds and reports no such store', async () => {
      assert.equal(await count(world.db, "SELECT count(*) AS n FROM pg_class WHERE relname IN ('chunk_translations', 'rag_table_rows', 'rag_dup_clusters')"), 0);
      const seeded = await seedLineage(world, world.tenantA);
      const result = await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      assert.equal(result.counts.documents, 2);
      for (const key of FOREIGN_KEYS) assert.equal(key in result.counts, false, `counts has no ${key}`);
      const stores = (await verify(world.db, world.tenantA.key, seeded.lineageId)).map((row) => row.store);
      for (const key of FOREIGN_KEYS) assert.equal(stores.includes(key), false, `verify has no ${key}`);
    });

    test('a chunk_translations relation without its hook is purged through the guarded delete: only the lineage, counted and verified', async () => {
      const { db } = world;
      await db.exec('CREATE TABLE public.chunk_translations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chunk_id uuid, document_id uuid, tenant_key text)');
      try {
        const target = await seedLineage(world, world.tenantA);
        const other = await seedLineage(world, world.tenantA);
        for (const seeded of [target, other]) {
          await db.query(
            'INSERT INTO chunk_translations (chunk_id, document_id, tenant_key) SELECT c.id, c.document_id, $2 FROM document_chunks c WHERE c.id = ANY ($1::uuid[])',
            [seeded.chunkIds, world.tenantA.key],
          );
        }
        const result = await purge(db, world.tenantA.key, target.lineageId, adminActor(world.adminA));
        assert.equal(result.counts.translations, target.chunkIds.length);
        assert.equal(await count(db, 'SELECT count(*) AS n FROM chunk_translations WHERE document_id = ANY ($1::uuid[])', [target.versionIds]), 0);
        assert.equal(await count(db, 'SELECT count(*) AS n FROM chunk_translations WHERE document_id = ANY ($1::uuid[])', [other.versionIds]), other.chunkIds.length);
        const remaining = new Map((await verify(db, world.tenantA.key, target.lineageId)).map((row) => [row.store, row.remaining]));
        assert.equal(remaining.get('translations'), 0);
      } finally {
        await db.exec('DROP TABLE public.chunk_translations');
      }
    });

    test('a rag_purge_hook_table_rows hook is called once with the tenant, lineage and version ids and its result is counted', async () => {
      const { db } = world;
      await db.exec(`
        CREATE TABLE public.synthetic_hook_calls (tenant_key text, lineage_id uuid, document_ids uuid[]);
        CREATE FUNCTION public.rag_purge_hook_table_rows(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
        RETURNS bigint LANGUAGE plpgsql SET search_path = '' AS $fn$
        BEGIN
          INSERT INTO public.synthetic_hook_calls VALUES (p_tenant_key, p_lineage_id, p_document_ids);
          RETURN 7;
        END
        $fn$;`);
      try {
        const seeded = await seedLineage(world, world.tenantA);
        const result = await purge(db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
        assert.equal(result.counts.table_rows, 7);
        const calls = await rows(db, 'SELECT tenant_key, lineage_id, document_ids FROM public.synthetic_hook_calls');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.tenant_key, world.tenantA.key);
        assert.equal(calls[0]?.lineage_id, seeded.lineageId);
        assert.deepEqual(calls[0]?.document_ids, seeded.versionIds);
      } finally {
        await db.exec('DROP FUNCTION public.rag_purge_hook_table_rows(text, uuid, uuid[]); DROP TABLE public.synthetic_hook_calls;');
      }
    });

    test('the reserved golden-item and duplicate-cluster hooks are called when they exist', async () => {
      const { db } = world;
      await db.exec(`
        CREATE FUNCTION public.rag_purge_hook_golden_items(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
        RETURNS integer LANGUAGE sql SET search_path = '' AS $fn$ SELECT pg_catalog.cardinality(p_document_ids) $fn$;
        CREATE FUNCTION public.rag_purge_hook_duplicate_clusters(p_tenant_key text, p_lineage_id uuid, p_document_ids uuid[])
        RETURNS bigint LANGUAGE sql SET search_path = '' AS $fn$ SELECT 3::bigint $fn$;`);
      try {
        const seeded = await seedLineage(world, world.tenantA);
        const result = await purge(db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
        assert.equal(result.counts.golden_items, 2);
        assert.equal(result.counts.duplicate_groups, 3);
      } finally {
        await db.exec(
          'DROP FUNCTION public.rag_purge_hook_golden_items(text, uuid, uuid[]); DROP FUNCTION public.rag_purge_hook_duplicate_clusters(text, uuid, uuid[]);',
        );
      }
    });
  });
}
