import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  MODES,
  TEXT_LEAKS,
  adminActor,
  count,
  createConnection,
  createWorld,
  errorOf,
  purge,
  reason,
  rows,
  seedLineage,
  verify,
  type PurgeWorld,
  type SeededLineage,
} from '../helpers/purge-fixture.mts';

const DB_STORES = [
  'documents',
  'chunks',
  'vectors',
  'parents',
  'ingestion_jobs',
  'parse_cache',
  'semantic_cache',
  'answer_citations',
  'chat_messages',
  'sync_records',
];

async function storeSnapshot(world: PurgeWorld, seeded: SeededLineage): Promise<Record<string, number>> {
  const { db } = world;
  const ids = seeded.versionIds;
  return {
    documents: await count(db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]),
    chunks: await count(db, 'SELECT count(*) AS n FROM document_chunks WHERE document_id = ANY ($1::uuid[])', [ids]),
    vectors: await count(db, 'SELECT count(*) AS n FROM chunk_embeddings WHERE chunk_id = ANY ($1::uuid[])', [seeded.chunkIds]),
    parents: await count(db, 'SELECT count(*) AS n FROM document_parents WHERE document_id = ANY ($1::uuid[])', [ids]),
    jobs: await count(db, 'SELECT count(*) AS n FROM ingestion_jobs WHERE lineage_id = $1', [seeded.lineageId]),
    archive: await count(db, 'SELECT count(*) AS n FROM ingestion_jobs_archive WHERE lineage_id = $1', [seeded.lineageId]),
    parse_cache: await count(db, 'SELECT count(*) AS n FROM rag_parse_cache WHERE file_sha256 = ANY ($1::text[])', [seeded.hashes]),
    semantic_cache: await count(db, 'SELECT count(*) AS n FROM rag_semantic_cache WHERE id = $1', [seeded.cacheId]),
    sync_records: seeded.fileId
      ? await count(db, 'SELECT count(*) AS n FROM nango_sync_records WHERE connection_id = $1 AND file_id = $2', [seeded.connectionId, seeded.fileId])
      : 0,
  };
}

for (const mode of MODES) {
  describe(`rag_purge_lineage (${mode})`, () => {
    let world: PurgeWorld;

    before(async () => {
      world = await createWorld(mode);
    });

    after(async () => {
      await world?.db.close();
    });

    async function nangoLineage(): Promise<SeededLineage> {
      const connection = await createConnection(world, world.tenantA);
      return seedLineage(world, world.tenantA, { nango: { ...connection, fileId: `file-${crypto.randomUUID().slice(0, 8)}` } });
    }

    test('every store of the lineage is emptied and rag_purge_verify reads 0 for each', async () => {
      const seeded = await nangoLineage();
      const before = await storeSnapshot(world, seeded);
      for (const [store, n] of Object.entries(before)) assert.ok(n > 0, `${store} seeded`);

      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));

      const after = await storeSnapshot(world, seeded);
      for (const [store, n] of Object.entries(after)) assert.equal(n, 0, `${store} emptied`);
      const result = await verify(world.db, world.tenantA.key, seeded.lineageId);
      const stores = result.filter((row) => !row.store.startsWith('external:')).map((row) => row.store);
      assert.deepEqual(
        stores.filter((store) => DB_STORES.includes(store)).sort(),
        [...DB_STORES].sort(),
      );
      assert.equal(new Set(stores).size, stores.length, 'one row per store');
      for (const row of result) {
        if (row.store.startsWith('external:')) continue;
        assert.equal(row.remaining, 0, `${row.store} remaining`);
        assert.equal(row.state, null);
      }
    });

    test('the returned counts equal the seeded rows and the object keys, cache prefixes and image prefix are returned', async () => {
      const seeded = await nangoLineage();
      const before = await storeSnapshot(world, seeded);
      const result = await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      // Foreign stores of other phases (0728) add their own keys; this test pins the 0727 stores.
      assert.deepEqual(Object.fromEntries(Object.entries(result.counts).filter(([key]) => DB_STORES.includes(key))), {
        documents: 2,
        chunks: before.chunks,
        vectors: before.vectors,
        parents: 1,
        ingestion_jobs: before.jobs + before.archive,
        parse_cache: 1,
        semantic_cache: 1,
        answer_citations: 1,
        chat_messages: 1,
        sync_records: 1,
      });
      assert.deepEqual([...result.object_keys].sort(), [...seeded.objectKeys].sort());
      assert.deepEqual(result.parse_cache_prefixes, [seeded.parsePrefix]);
      assert.deepEqual(result.image_prefixes, [`rag/${world.tenantA.key}/${seeded.lineageId}/`]);
      assert.match(result.audit_id, /^[0-9a-f-]{36}$/);
    });

    test('a parse-cache row whose file_sha256 another live document of the tenant shares is kept and its prefix is not returned', async () => {
      const keeper = await seedLineage(world, world.tenantA);
      const seeded = await seedLineage(world, world.tenantA, { sharedHash: keeper.hashes[1] });
      const sharedBefore = await count(world.db, 'SELECT count(*) AS n FROM rag_parse_cache WHERE file_sha256 = $1', [keeper.hashes[1]]);
      const result = await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_parse_cache WHERE file_sha256 = $1', [keeper.hashes[1]]), sharedBefore);
      assert.ok(!result.parse_cache_prefixes.includes(keeper.parsePrefix));
      assert.deepEqual(result.parse_cache_prefixes, [seeded.parsePrefix]);
      const checked = await verify(world.db, world.tenantA.key, seeded.lineageId);
      assert.equal(checked.find((row) => row.store === 'parse_cache')?.remaining, 0);
    });

    test('another lineage of the same tenant and every row of the other tenant are untouched', async () => {
      const other = await seedLineage(world, world.tenantA);
      const foreign = world.tenantB ? await seedLineage(world, world.tenantB) : null;
      const seeded = await seedLineage(world, world.tenantA);
      const otherBefore = await storeSnapshot(world, other);
      const foreignBefore = foreign ? await storeSnapshot(world, foreign) : null;
      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      const otherAfter = await storeSnapshot(world, other);
      // The 0603 statement trigger flushes the tenant's semantic cache on any document delete; that is the cache's own design.
      assert.deepEqual({ ...otherAfter, semantic_cache: 0 }, { ...otherBefore, semantic_cache: 0 });
      const otherRecord = await rows(world.db, 'SELECT citations FROM rag_answer_records WHERE id = $1', [other.answerRecordId]);
      assert.notEqual((otherRecord[0]?.citations as Array<Record<string, unknown>>)[0]?.withdrawn, true);
      if (foreign && foreignBefore) {
        assert.deepEqual(await storeSnapshot(world, foreign), foreignBefore);
        const foreignChat = await rows(world.db, 'SELECT messages::text AS m FROM chats WHERE id = $1', [foreign.chatId]);
        assert.doesNotMatch(String(foreignChat[0]?.m), /"withdrawn": ?true/);
      }
    });

    test('the answer record and the chat carry the withdrawn marker in place of the quote', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      const record = await rows(world.db, 'SELECT citations FROM rag_answer_records WHERE id = $1', [seeded.answerRecordId]);
      const marker = (record[0]?.citations as Array<Record<string, unknown>>)[0];
      assert.equal(marker?.withdrawn, true);
      assert.equal(marker?.quote, '');
      assert.equal(marker?.documentName, '');
      const chat = await rows(world.db, 'SELECT messages::text AS m FROM chats WHERE id = $1', [seeded.chatId]);
      assert.doesNotMatch(String(chat[0]?.m), TEXT_LEAKS);
    });

    test('the audit row holds ids, hashes, counts, actor and reason, and no file name or text', async () => {
      const seeded = await nangoLineage();
      const result = await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA), reason('other', 'A synthetic note.'));
      const audit = await rows(world.db, 'SELECT * FROM rag_purge_audit WHERE id = $1', [result.audit_id]);
      const row = audit[0];
      assert.ok(row);
      assert.equal(row.tenant_key, world.tenantA.key);
      assert.equal(row.lineage_id, seeded.lineageId);
      assert.deepEqual([...(row.version_ids as string[])].sort(), [...seeded.versionIds].sort());
      assert.deepEqual([...(row.file_sha256_values as string[])].sort(), [...seeded.hashes].sort());
      assert.equal(row.source, 'nango');
      assert.equal(row.source_connection_id, seeded.connectionId);
      assert.equal(row.source_key_sha256, crypto.createHash('sha256').update(String(seeded.fileId)).digest('hex'));
      assert.equal(row.actor_kind, 'admin');
      assert.equal(row.actor_id, world.adminA);
      assert.equal(row.reason_code, 'other');
      assert.equal(row.reason_note, 'A synthetic note.');
      assert.deepEqual(row.counts, result.counts);
      assert.ok(row.started_at instanceof Date);
      assert.equal(row.finished_at, null);
      assert.doesNotMatch(JSON.stringify(row), TEXT_LEAKS);
      assert.ok(!JSON.stringify(row).includes(String(seeded.fileId)), 'the raw source key is not stored');
    });

    test('identity edits, deletes and truncates of the audit table are refused; rag_purge_audit_finish sets the finish columns', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      const { audit_id: auditId } = await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      for (const column of ['tenant_key', 'lineage_id', 'actor_id']) {
        const value = column === 'tenant_key' ? world.otherModeKey : crypto.randomUUID();
        const refused = await errorOf(() => world.db.query(`UPDATE rag_purge_audit SET ${column} = $2 WHERE id = $1`, [auditId, value]));
        assert.match(refused.message, /append-only|immutable|violates check/);
      }
      assert.match((await errorOf(() => world.db.query('DELETE FROM rag_purge_audit WHERE id = $1', [auditId]))).message, /append-only/);
      assert.match((await errorOf(() => world.db.exec('TRUNCATE rag_purge_audit'))).message, /append-only/);
      // Setting the finish flag by hand does not open identity columns.
      const forced = await errorOf(() =>
        world.db.transaction(async (tx) => {
          await tx.query("SELECT set_config('rag.purge_audit_finish', 'on', true)");
          await tx.query('UPDATE rag_purge_audit SET actor_id = $2 WHERE id = $1', [auditId, crypto.randomUUID()]);
        }),
      );
      assert.match(forced.message, /immutable/);

      const verification = { stores: { documents: 0 } };
      await world.db.query('SELECT public.rag_purge_audit_finish($1, $2::jsonb, $3::text[], $4::jsonb, $5)', [
        auditId,
        JSON.stringify({ originals: 4 }),
        ['pending/path/one'],
        JSON.stringify(verification),
        'pending',
      ]);
      await world.db.query('SELECT public.rag_purge_audit_finish($1, $2::jsonb, $3::text[], NULL, $4)', [
        auditId,
        JSON.stringify({ images: 0 }),
        [],
        'verified',
      ]);
      const finished = (await rows(world.db, 'SELECT * FROM rag_purge_audit WHERE id = $1', [auditId]))[0];
      assert.deepEqual(finished?.object_counts, { originals: 4, images: 0 });
      assert.deepEqual(finished?.pending_object_paths, []);
      assert.deepEqual(finished?.verification, verification);
      assert.ok(finished?.verification_checked_at instanceof Date);
      assert.ok(finished?.finished_at instanceof Date);
      assert.equal(finished?.result, 'verified');
      assert.equal(finished?.tenant_key, world.tenantA.key);
      const unknown = await errorOf(() => world.db.query("SELECT public.rag_purge_audit_finish($1, '{}'::jsonb, NULL, NULL, NULL)", [crypto.randomUUID()]));
      assert.match(unknown.message, /not_found/);
    });

    test('reason rules: "other" needs a note, notes over 500 characters and the system code are refused for an admin; verify without a purge is not_found', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      const actor = adminActor(world.adminA);
      for (const why of [reason('other'), reason('owner_request', 'x'.repeat(501)), reason('source_deleted'), reason('unknown_code'), '{}']) {
        const refused = await errorOf(() => purge(world.db, world.tenantA.key, seeded.lineageId, actor, why));
        assert.equal(refused.code, '22023', why);
      }
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 2, 'nothing purged by a refused call');
      assert.match((await errorOf(() => verify(world.db, world.tenantA.key, seeded.lineageId))).message, /not_found/);
      await purge(world.db, world.tenantA.key, seeded.lineageId, actor, reason('retention_ended'));
      assert.ok((await verify(world.db, world.tenantA.key, seeded.lineageId)).every((row) => row.remaining === 0));
    });
  });
}
