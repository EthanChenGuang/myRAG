import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants';
import {
  MODES,
  adminActor,
  asRole,
  count,
  createConnection,
  createWorld,
  errorOf,
  purge,
  reason,
  rows,
  seedLineage,
  syncActor,
  verify,
  type PurgeWorld,
} from '../helpers/purge-fixture.mts';

const NEW_FUNCTIONS: Array<[string, string, unknown[]]> = [
  ['rag_purge_lineage(text, uuid, jsonb, jsonb)', 'SELECT * FROM public.rag_purge_lineage($1, $2::uuid, $3::jsonb, $4::jsonb)', ['s:default', crypto.randomUUID(), '{}', '{}']],
  ['rag_purge_verify(text, uuid)', 'SELECT * FROM public.rag_purge_verify($1, $2::uuid)', ['s:default', crypto.randomUUID()]],
  ['rag_purge_audit_finish(uuid, jsonb, text[], jsonb, text)', "SELECT public.rag_purge_audit_finish($1::uuid, '{}'::jsonb, NULL, NULL, NULL)", [crypto.randomUUID()]],
  ['rag_purge_admin_target(uuid, uuid)', 'SELECT * FROM public.rag_purge_admin_target($1::uuid, $2::uuid)', [crypto.randomUUID(), crypto.randomUUID()]],
  ['rag_purge_audit_list(uuid, integer, integer)', 'SELECT * FROM public.rag_purge_audit_list($1::uuid, 10, 0)', [crypto.randomUUID()]],
  ['rag_purge_audit_get(uuid, uuid)', 'SELECT * FROM public.rag_purge_audit_get($1::uuid, $2::uuid)', [crypto.randomUUID(), crypto.randomUUID()]],
  ['rag_purge_audit_pending(integer)', 'SELECT * FROM public.rag_purge_audit_pending(10)', []],
  ['rag_purge_tombstone_exists(text, text, text)', "SELECT public.rag_purge_tombstone_exists('s:default', 'conn', 'file')", []],
];

for (const mode of MODES) {
  describe(`purge actor, tenant and grant checks (${mode})`, () => {
    let world: PurgeWorld;

    before(async () => {
      world = await createWorld(mode);
    });

    after(async () => {
      await world?.db.close();
    });

    test('an unknown lineage and an other tenant lineage answer the same not_found and purge nothing', async () => {
      const unknown = await errorOf(() => purge(world.db, world.tenantA.key, crypto.randomUUID(), adminActor(world.adminA)));
      assert.equal(unknown.message, 'not_found');
      if (world.tenantB) {
        const foreign = await seedLineage(world, world.tenantB);
        const refused = await errorOf(() => purge(world.db, world.tenantA.key, foreign.lineageId, adminActor(world.adminA)));
        assert.deepEqual(refused, unknown);
        assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [foreign.lineageId]), 2);
        assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_purge_audit WHERE lineage_id = $1', [foreign.lineageId]), 0);
        const verifyRefused = await errorOf(() => verify(world.db, world.tenantA.key, foreign.lineageId));
        assert.equal(verifyRefused.message, 'not_found');
      }
    });

    test('an admin who does not administer the tenant gets not_found', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      const refused = await errorOf(() => purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.outsider)));
      assert.equal(refused.message, 'not_found');
      const unknownActor = await errorOf(() => purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(crypto.randomUUID())));
      assert.equal(unknownActor.message, 'not_found');
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 2);
    });

    test('a source_sync actor purges only nango versions of its own connection', async () => {
      // Connector documents live in the owner's workspace (nangoOwnerScope): u:<owner> in multi-tenant mode, s:default in single.
      const ownerTenant = mode === 'multi-tenant' ? { key: `u:${world.tenantA.userId}`, userId: world.tenantA.userId, orgId: null } : world.tenantA;
      const own = await createConnection(world, ownerTenant);
      const other = await createConnection(world, ownerTenant);
      const fileId = `file-${crypto.randomUUID().slice(0, 8)}`;
      const seeded = await seedLineage(world, ownerTenant, { nango: { ...own, fileId } });
      const upload = await seedLineage(world, ownerTenant);
      const sync = reason('source_deleted');
      assert.equal((await errorOf(() => purge(world.db, ownerTenant.key, seeded.lineageId, syncActor(other.connectionUuid), sync))).message, 'not_found');
      assert.equal((await errorOf(() => purge(world.db, ownerTenant.key, seeded.lineageId, syncActor(crypto.randomUUID()), sync))).message, 'not_found');
      assert.equal((await errorOf(() => purge(world.db, ownerTenant.key, upload.lineageId, syncActor(own.connectionUuid), sync))).message, 'not_found');
      assert.equal((await errorOf(() => purge(world.db, ownerTenant.key, seeded.lineageId, syncActor(own.connectionUuid), reason('owner_request')))).code, '22023');
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 2);

      const result = await purge(world.db, ownerTenant.key, seeded.lineageId, syncActor(own.connectionUuid), sync);
      assert.equal(result.counts.documents, 2);
      assert.equal(result.counts.sync_records, 1);
      const audit = (await rows(world.db, 'SELECT actor_kind, actor_id, reason_code FROM rag_purge_audit WHERE id = $1', [result.audit_id]))[0];
      assert.deepEqual(audit, { actor_kind: 'source_sync', actor_id: own.connectionUuid, reason_code: 'source_deleted' });
    });

    test('a source_sync actor cannot purge in a tenant other than its connection owner tenant (06.3-SECURITY W3)', async (t) => {
      if (mode !== 'multi-tenant') {
        t.skip('single-tenant: every connection owner tenant is s:default');
        return;
      }
      // The app resolves the owner tenant before it calls; this is the SQL-layer second check. Nango rows of the connection
      // written into an organization tenant (the owner's u:<owner> is the only allowed one) must not be purged by its sync.
      const own = await createConnection(world, world.tenantA);
      const fileId = `file-${crypto.randomUUID().slice(0, 8)}`;
      const seeded = await seedLineage(world, world.tenantA, { nango: { ...own, fileId } });
      const refused = await errorOf(() => purge(world.db, world.tenantA.key, seeded.lineageId, syncActor(own.connectionUuid), reason('source_deleted')));
      assert.equal(refused.message, 'not_found');
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 2);
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM rag_purge_audit WHERE lineage_id = $1', [seeded.lineageId]), 0);
    });

    test('a key of the other deployment mode is refused by the tenant guard', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      for (const run of [
        () => purge(world.db, world.otherModeKey, seeded.lineageId, adminActor(world.adminA)),
        () => verify(world.db, world.otherModeKey, seeded.lineageId),
        () => world.db.query('SELECT public.rag_purge_tombstone_exists($1, $2, $3)', [world.otherModeKey, 'conn', 'file']),
      ]) {
        const refused = await errorOf(run);
        assert.equal(refused.code, '22023');
        assert.match(refused.message, /invalid_tenant_key/);
      }
    });

    test('rag_purge_admin_target answers tenant, lineage and connector flag for an administered document only', async () => {
      const connection = await createConnection(world, world.tenantA);
      const seeded = await seedLineage(world, world.tenantA, { nango: { ...connection, fileId: `file-${crypto.randomUUID().slice(0, 8)}` } });
      const upload = await seedLineage(world, world.tenantA);
      const target = await rows(world.db, 'SELECT * FROM public.rag_purge_admin_target($1::uuid, $2::uuid)', [seeded.versionIds[0], world.adminA]);
      assert.deepEqual(target, [{ tenant_key: world.tenantA.key, lineage_id: seeded.lineageId, is_connector: true }]);
      const plain = await rows(world.db, 'SELECT is_connector FROM public.rag_purge_admin_target($1::uuid, $2::uuid)', [upload.versionIds[1], world.adminA]);
      assert.deepEqual(plain, [{ is_connector: false }]);
      const unknown = await errorOf(() => world.db.query('SELECT * FROM public.rag_purge_admin_target($1::uuid, $2::uuid)', [crypto.randomUUID(), world.adminA]));
      const outsider = await errorOf(() => world.db.query('SELECT * FROM public.rag_purge_admin_target($1::uuid, $2::uuid)', [seeded.versionIds[1], world.outsider]));
      assert.equal(unknown.message, 'not_found');
      assert.deepEqual(outsider, unknown);
      if (world.tenantB) {
        const foreign = await seedLineage(world, world.tenantB);
        assert.deepEqual(
          await errorOf(() => world.db.query('SELECT * FROM public.rag_purge_admin_target($1::uuid, $2::uuid)', [foreign.versionIds[1], world.adminA])),
          unknown,
        );
      }
    });

    test('audit list and get show only administered tenants, with the provider of a source-sync connection; pending lists open records', async () => {
      const connection = await createConnection(world, world.tenantA);
      const synced = await seedLineage(world, world.tenantA, { nango: { ...connection, fileId: `file-${crypto.randomUUID().slice(0, 8)}` } });
      const syncPurge = await purge(world.db, world.tenantA.key, synced.lineageId, syncActor(connection.connectionUuid), reason('source_deleted'));
      const adminPurge = await purge(world.db, world.tenantA.key, (await seedLineage(world, world.tenantA)).lineageId, adminActor(world.adminA));
      let foreignAudit: string | null = null;
      if (world.tenantB) {
        foreignAudit = (await purge(world.db, world.tenantB.key, (await seedLineage(world, world.tenantB)).lineageId, adminActor(world.outsider))).audit_id;
      }
      const listed = await rows(world.db, 'SELECT * FROM public.rag_purge_audit_list($1::uuid, 200, 0)', [world.adminA]);
      const ids = listed.map((row) => row.id);
      assert.ok(ids.includes(syncPurge.audit_id) && ids.includes(adminPurge.audit_id));
      if (foreignAudit) assert.ok(!ids.includes(foreignAudit));
      for (const row of listed) assert.equal(row.tenant_key, world.tenantA.key);
      const syncRow = listed.find((row) => row.id === syncPurge.audit_id);
      assert.match(String(syncRow?.connection_provider), /^provider-/);
      assert.equal(listed.find((row) => row.id === adminPurge.audit_id)?.connection_provider, null);
      const paged = await rows(world.db, 'SELECT id FROM public.rag_purge_audit_list($1::uuid, 1, 1)', [world.adminA]);
      assert.equal(paged.length, 1);
      assert.equal(paged[0]?.id, listed[1]?.id);

      const got = await rows(world.db, 'SELECT id, reason_code FROM public.rag_purge_audit_get($1::uuid, $2::uuid)', [world.adminA, adminPurge.audit_id]);
      assert.deepEqual(got, [{ id: adminPurge.audit_id, reason_code: 'added_in_error' }]);
      const missing = await errorOf(() => world.db.query('SELECT * FROM public.rag_purge_audit_get($1::uuid, $2::uuid)', [world.adminA, crypto.randomUUID()]));
      assert.equal(missing.message, 'not_found');
      if (foreignAudit) {
        assert.deepEqual(await errorOf(() => world.db.query('SELECT * FROM public.rag_purge_audit_get($1::uuid, $2::uuid)', [world.adminA, foreignAudit])), missing);
      }

      await world.db.query("SELECT public.rag_purge_audit_finish($1::uuid, '{}'::jsonb, $2::text[], NULL, 'pending')", [syncPurge.audit_id, ['a/b/c']]);
      const pending = await rows(world.db, 'SELECT id, pending_object_paths FROM public.rag_purge_audit_pending(1000)');
      assert.deepEqual(pending.find((row) => row.id === syncPurge.audit_id)?.pending_object_paths, ['a/b/c']);
      assert.ok(!pending.some((row) => row.id === adminPurge.audit_id), 'an unfinished record with no pending path is not listed');
    });

    test('a tombstone exists only for an admin purge of that tenant, connection and source key', async () => {
      const connection = await createConnection(world, world.tenantA);
      const fileId = `file-${crypto.randomUUID().slice(0, 8)}`;
      const adminPurged = await seedLineage(world, world.tenantA, { nango: { ...connection, fileId } });
      const syncFile = `file-${crypto.randomUUID().slice(0, 8)}`;
      const syncPurged = await seedLineage(world, world.tenantA, { nango: { ...connection, fileId: syncFile } });
      const tombstone = async (key: string, conn: string, file: string) =>
        (await rows(world.db, 'SELECT public.rag_purge_tombstone_exists($1, $2, $3) AS t', [key, conn, file]))[0]?.t;
      assert.equal(await tombstone(world.tenantA.key, connection.connectionId, fileId), false);
      await purge(world.db, world.tenantA.key, adminPurged.lineageId, adminActor(world.adminA));
      await purge(world.db, world.tenantA.key, syncPurged.lineageId, syncActor(connection.connectionUuid), reason('source_deleted'));
      assert.equal(await tombstone(world.tenantA.key, connection.connectionId, fileId), true);
      assert.equal(await tombstone(world.tenantA.key, connection.connectionId, syncFile), false);
      assert.equal(await tombstone(world.tenantA.key, 'conn-other', fileId), false);
      assert.equal(await tombstone(world.tenantA.key, connection.connectionId, 'file-other'), false);
      if (world.tenantB) assert.equal(await tombstone(world.tenantB.key, connection.connectionId, fileId), false);
    });

    test('a job of the lineage in parsing cannot write the lineage back after the purge', async () => {
      const seeded = await seedLineage(world, world.tenantA);
      const pendingDoc = crypto.randomUUID();
      const fields = world.mode === 'multi-tenant' ? ', user_id, organization_id' : '';
      const values = world.mode === 'multi-tenant' ? ', $5, $6' : '';
      await world.db.query(
        `INSERT INTO documents (id, filename, content, metadata, lineage_id, version, is_current, status, source_key${fields})
         VALUES ($1, $2, '', '{}'::jsonb, $3, 3, false, 'processing', $4${values})`,
        world.mode === 'multi-tenant'
          ? [pendingDoc, 'pending.md', seeded.lineageId, seeded.sourceKey, world.tenantA.userId, world.tenantA.orgId]
          : [pendingDoc, 'pending.md', seeded.lineageId, seeded.sourceKey],
      );
      const job = (
        await rows(
          world.db,
          `INSERT INTO ingestion_jobs (tenant_key, kind, status, stage, source, source_key, lineage_id, document_id, version, locked_by, lease_until)
           VALUES ($1, 'ingest', 'parsing', 'parse', 'config_upload', $2, $3, $4, 3, 'worker-1', now() + interval '10 minutes') RETURNING id`,
          [world.tenantA.key, seeded.sourceKey, seeded.lineageId, pendingDoc],
        )
      )[0]?.id;
      const result = await purge(world.db, world.tenantA.key, seeded.lineageId, adminActor(world.adminA));
      assert.equal(result.counts.documents, 3);

      const write = await errorOf(() =>
        world.db.query("SELECT * FROM public.rag_write_chunks($1::uuid, $2, $3::jsonb, NULL, true, 1)", [
          pendingDoc,
          world.tenantA.key,
          JSON.stringify([{ content: 'Synthetic late chunk.', chunk_index: 0 }]),
        ]),
      );
      assert.match(write.message, /tenant_mismatch|not_found/);
      const publish = await errorOf(() => world.db.query('SELECT * FROM public.rag_publish_document_version($1::uuid, $2)', [pendingDoc, world.tenantA.key]));
      assert.match(publish.message, /tenant_mismatch|not_found/);
      const advance = await errorOf(() =>
        world.db.query("SELECT public.rag_advance_ingestion_job($1::uuid, 'worker-1', 'chunk', public.rag_ingest_job_status_for_stage('chunk'))", [job]),
      );
      assert.match(advance.message, /job_not_found/);
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM documents WHERE lineage_id = $1', [seeded.lineageId]), 0);
      assert.equal(await count(world.db, 'SELECT count(*) AS n FROM document_chunks WHERE document_id = $1', [pendingDoc]), 0);
      assert.ok((await verify(world.db, world.tenantA.key, seeded.lineageId)).every((row) => row.remaining === 0));
    });

    test('anon and authenticated cannot execute the new functions or read the audit table', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        for (const [signature, sql, params] of NEW_FUNCTIONS) {
          const refused = await errorOf(() => asRole(world.db, role, world.adminA, () => world.db.query(sql, params)));
          assert.equal(refused.code, '42501', `${role} ${signature}`);
        }
        const table = await errorOf(() => asRole(world.db, role, world.adminA, () => world.db.query('SELECT * FROM public.rag_purge_audit')));
        assert.equal(table.code, '42501', `${role} rag_purge_audit`);
      }
      const insert = await errorOf(() =>
        asRole(world.db, 'service_role', null, () =>
          world.db.query("INSERT INTO public.rag_purge_audit (tenant_key, lineage_id, actor_kind, actor_id, reason_code) VALUES ('s:default', $1, 'admin', $1, 'other')", [
            crypto.randomUUID(),
          ]),
        ),
      );
      assert.equal(insert.code, '42501', 'service_role cannot write the audit table directly');
      await assertNoClientCallableRagFunctions(world.db);
    });
  });
}
