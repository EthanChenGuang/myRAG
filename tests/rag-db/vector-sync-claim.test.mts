import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

interface Row {
  id: number;
  target: string;
  entity: string;
  entity_id: string;
  tenant_key: string | null;
  profile_id: string | null;
  attempts: number;
  status: string;
  lease_until: Date | null;
  last_error: string | null;
  cursor: string | null;
}

const FUNCTIONS: [name: string, call: string][] = [
  ['rag_vector_sync_claim(integer, integer)', 'SELECT * FROM public.rag_vector_sync_claim(1, 60)'],
  ['rag_vector_sync_complete(bigint[])', "SELECT public.rag_vector_sync_complete('{}'::bigint[])"],
  ['rag_vector_sync_fail(bigint, text)', "SELECT public.rag_vector_sync_fail(1, 'code')"],
  ['rag_vector_sync_checkpoint(bigint, text)', "SELECT public.rag_vector_sync_checkpoint(1, 'c')"],
  ['rag_vector_sync_expand(bigint, integer)', 'SELECT * FROM public.rag_vector_sync_expand(1, 10)'],
  ['rag_vector_sync_requeue_dead(text)', "SELECT public.rag_vector_sync_requeue_dead('qdrant')"],
  ['rag_vector_sync_set_target(text, boolean, text)', "SELECT public.rag_vector_sync_set_target('qdrant', false, 'role-test')"],
];

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;
}

async function insertRow(db: PGlite, values: { target?: string; entity?: string; entityId: string; tenantKey?: string | null; profileId?: string | null; ageSeconds?: number }): Promise<number> {
  const r = await db.query<{ id: number }>(
    `INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key, profile_id, enqueued_at)
     VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6::int)) RETURNING id`,
    [values.target ?? 'qdrant', values.entity ?? 'document', values.entityId, values.tenantKey === undefined ? 's:default' : values.tenantKey, values.profileId ?? null, values.ageSeconds ?? 0],
  );
  return Number(r.rows[0]!.id);
}

async function claim(db: PGlite, limit: number, lease = 120): Promise<Row[]> {
  return (await db.query<Row>('SELECT * FROM public.rag_vector_sync_claim($1, $2)', [limit, lease])).rows.map((r) => ({ ...r, id: Number(r.id) }));
}

async function rowById(db: PGlite, id: number): Promise<Row> {
  const r = (await db.query<Row>('SELECT * FROM public.vector_sync_outbox WHERE id = $1', [id])).rows[0]!;
  return { ...r, id: Number(r.id) };
}

async function expireLease(db: PGlite, id: number): Promise<void> {
  await db.query("UPDATE public.vector_sync_outbox SET lease_until = now() - interval '1 second' WHERE id = $1", [id]);
}

function secondsFromNow(at: Date | null): number {
  assert.ok(at, 'lease_until is set');
  return (new Date(at).getTime() - Date.now()) / 1000;
}

async function expectDenied(db: PGlite, role: 'anon' | 'authenticated', sql: string, fn: string): Promise<void> {
  await db.exec(`SET ROLE ${role}`);
  try {
    await assert.rejects(
      () => db.query(sql),
      (error: unknown) => (error as { code?: string }).code === '42501',
      `${role} must be refused ${fn}`,
    );
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function createOrgDocument(db: PGlite): Promise<{ orgId: string; docId: string }> {
  const orgId = crypto.randomUUID();
  const docId = crypto.randomUUID();
  await db.query('INSERT INTO public.organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [orgId, 'Claim Org', `claim-${orgId}`, FIXTURE_USER_ID]);
  await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id, organization_id) VALUES ($1, 'org.txt', 'org', '{}'::jsonb, $2, $3)", [
    docId,
    FIXTURE_USER_ID,
    orgId,
  ]);
  return { orgId, docId };
}

for (const mode of MODES) {
  describe(`vector sync claim RPCs 0703 (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    const tenant = tenantFor(mode);

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      db = fixture.db;
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await db.exec("UPDATE public.rag_vector_sync_targets SET enabled = false; DELETE FROM public.vector_sync_outbox; DELETE FROM public.rag_backend_index_state;");
      for (const [fn] of FUNCTIONS) {
        const found = (await db.query<{ ok: boolean }>('SELECT to_regprocedure($1) IS NOT NULL AS ok', [`public.${fn}`])).rows[0]!.ok;
        assert.equal(found, true, `public.${fn} is missing`);
      }
    });

    test('claim returns at most p_limit rows oldest first and leases them', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 12; i += 1) ids.push(await insertRow(db, { entityId: `doc-${i}`, tenantKey: tenant, ageSeconds: 100 - i }));
      const rows = await claim(db, 10, 120);
      assert.deepEqual(rows.map((r) => r.id), ids.slice(0, 10));
      for (const row of rows) {
        assert.equal(row.status, 'leased');
        assert.equal(row.attempts, 1);
        const s = secondsFromNow(row.lease_until);
        assert.ok(s > 100 && s <= 121, `lease about 120 s, got ${s}`);
      }
    });

    test('a second claim skips rows and entities that hold a live lease', async () => {
      const a = await insertRow(db, { entityId: 'doc-a', tenantKey: tenant, ageSeconds: 50 });
      assert.deepEqual((await claim(db, 10)).map((r) => r.id), [a]);
      const b = await insertRow(db, { entityId: 'doc-a', tenantKey: tenant, ageSeconds: 40 });
      const other = await insertRow(db, { entityId: 'doc-b', tenantKey: tenant, ageSeconds: 30 });
      const otherTarget = await insertRow(db, { target: 'weaviate', entityId: 'doc-a', tenantKey: tenant, ageSeconds: 20 });
      assert.deepEqual((await claim(db, 10)).map((r) => r.id), [other, otherTarget], 'live lease on qdrant/document/doc-a holds back its pending row');
      assert.equal((await rowById(db, b)).status, 'pending');
      assert.equal(await db.query('SELECT public.rag_vector_sync_complete($1::bigint[])', [[a]]).then((r) => (r.rows[0] as { rag_vector_sync_complete: number }).rag_vector_sync_complete), 1);
      assert.deepEqual((await claim(db, 10)).map((r) => r.id), [b]);
    });

    test('a row whose lease expired is claimable again and counts a second attempt', async () => {
      const a = await insertRow(db, { entityId: 'doc-x', tenantKey: tenant });
      await claim(db, 5);
      assert.deepEqual(await claim(db, 5), []);
      await expireLease(db, a);
      const again = await claim(db, 5);
      assert.deepEqual(again.map((r) => [r.id, r.attempts, r.status]), [[a, 2, 'leased']]);
    });

    test('fail backs off through lease_until and marks the row dead at 8 attempts', async () => {
      const a = await insertRow(db, { entityId: 'doc-f', tenantKey: tenant });
      await claim(db, 1);
      const status = (await db.query<{ s: string }>("SELECT public.rag_vector_sync_fail($1, 'backend_error:503') AS s", [a])).rows[0]!.s;
      assert.equal(status, 'pending');
      let row = await rowById(db, a);
      assert.equal(row.status, 'pending');
      assert.equal(row.attempts, 1);
      assert.equal(row.last_error, 'backend_error:503');
      const s = secondsFromNow(row.lease_until);
      assert.ok(s > 0 && s <= 2.5, `backoff 2^1 s, got ${s}`);
      assert.deepEqual(await claim(db, 5), [], 'a row in backoff is not claimable');
      await expireLease(db, a);
      assert.equal((await claim(db, 5)).length, 1);
      await db.query('SELECT public.rag_vector_sync_fail($1, $2)', [a, 'Chunk text with spaces and content!']);
      row = await rowById(db, a);
      assert.equal(row.last_error, 'invalid_error_code', 'only codes are stored, never content');
      assert.ok(secondsFromNow(row.lease_until) > 2.5, 'backoff grows with attempts');

      await db.query("UPDATE public.vector_sync_outbox SET attempts = 7, lease_until = NULL WHERE id = $1", [a]);
      const last = await claim(db, 1);
      assert.equal(last[0]?.attempts, 8);
      assert.equal((await db.query<{ s: string }>("SELECT public.rag_vector_sync_fail($1, 'timeout') AS s", [a])).rows[0]!.s, 'dead');
      row = await rowById(db, a);
      assert.equal(row.status, 'dead');
      assert.equal(row.lease_until, null);
      assert.deepEqual(await claim(db, 5), []);
    });

    test('the longest backoff before the dead line is 2^7 s', async () => {
      const a = await insertRow(db, { entityId: 'doc-cap', tenantKey: tenant });
      await db.query('UPDATE public.vector_sync_outbox SET attempts = 6 WHERE id = $1', [a]);
      assert.equal((await claim(db, 1))[0]?.attempts, 7);
      assert.equal((await db.query<{ s: string }>("SELECT public.rag_vector_sync_fail($1, 'x') AS s", [a])).rows[0]!.s, 'pending');
      const s = secondsFromNow((await rowById(db, a)).lease_until);
      assert.ok(s > 120 && s <= 129, `2^7 s, got ${s}`);
    });

    test('complete marks leased rows done; checkpoint stores a cursor and releases the lease without counting an attempt', async () => {
      const a = await insertRow(db, { entityId: 'doc-c1', tenantKey: tenant });
      const b = await insertRow(db, { entityId: 'doc-c2', tenantKey: tenant });
      await claim(db, 2);
      const done = (await db.query<{ n: number }>('SELECT public.rag_vector_sync_complete($1::bigint[]) AS n', [[a]])).rows[0]!.n;
      assert.equal(done, 1);
      assert.equal((await rowById(db, a)).status, 'done');
      const before = await rowById(db, b);
      assert.equal(before.attempts, 1);
      const ok = (await db.query<{ ok: boolean }>("SELECT public.rag_vector_sync_checkpoint($1, 'cursor-1') AS ok", [b])).rows[0]!.ok;
      assert.equal(ok, true);
      const after = await rowById(db, b);
      assert.deepEqual([after.status, after.lease_until, after.cursor, after.attempts], ['pending', null, 'cursor-1', 0]);
      const reclaimed = await claim(db, 5);
      assert.deepEqual(reclaimed.map((r) => [r.id, r.attempts, r.cursor]), [[b, 1, 'cursor-1']]);
    });

    test('expand pages a tenant row into document rows with a cursor', async () => {
      await db.query("UPDATE public.rag_vector_sync_targets SET enabled = true WHERE target = 'qdrant'");
      const docs = (await db.query<{ id: string }>('SELECT id::text AS id FROM public.documents WHERE tenant_key = $1 AND is_current ORDER BY id', [tenant])).rows.map((r) => r.id);
      assert.ok(docs.length >= 3, 'the fixture has several current documents');
      const t = await insertRow(db, { entity: 'tenant', entityId: tenant, tenantKey: tenant });
      await claim(db, 1);
      const first = (await db.query<{ enqueued: number; next_cursor: string; has_more: boolean }>('SELECT * FROM public.rag_vector_sync_expand($1, 2)', [t])).rows[0]!;
      assert.deepEqual([first.enqueued, first.next_cursor, first.has_more], [2, docs[1], true]);
      assert.equal((await rowById(db, t)).cursor, docs[1]);
      let all = { enqueued: 0, next_cursor: '', has_more: true };
      while (all.has_more) {
        all = (await db.query<typeof all>('SELECT * FROM public.rag_vector_sync_expand($1, 1000)', [t])).rows[0]!;
      }
      const queued = (await db.query<{ entity_id: string; target: string; tenant_key: string; profile_id: string | null }>(
        "SELECT entity_id, target, tenant_key, profile_id FROM public.vector_sync_outbox WHERE entity = 'document' ORDER BY entity_id",
      )).rows;
      assert.deepEqual(queued.map((r) => r.entity_id), docs);
      for (const r of queued) assert.deepEqual([r.target, r.tenant_key, r.profile_id], ['qdrant', tenant, null]);
    });

    test('expand of a profile row covers every tenant and keeps the profile id', async () => {
      await db.query("UPDATE public.rag_vector_sync_targets SET enabled = true WHERE target IN ('qdrant', 'weaviate')");
      let tenants = [tenant];
      if (mode === 'multi-tenant') {
        const { orgId } = await createOrgDocument(db);
        tenants = [tenant, `o:${orgId}`];
      }
      await db.exec('DELETE FROM public.vector_sync_outbox');
      const p = await insertRow(db, { target: 'weaviate', entity: 'profile', entityId: 'embedding:voyage-4-large-1024', tenantKey: null, profileId: 'voyage-4-large-1024' });
      await claim(db, 1);
      const r = (await db.query<{ enqueued: number; has_more: boolean }>('SELECT * FROM public.rag_vector_sync_expand($1, 10000)', [p])).rows[0]!;
      assert.equal(r.has_more, false);
      const current = Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.documents WHERE is_current')).rows[0]!.n);
      assert.equal(r.enqueued, current);
      const rows = (await db.query<{ tenant_key: string; target: string; profile_id: string }>("SELECT DISTINCT tenant_key, target, profile_id FROM public.vector_sync_outbox WHERE entity = 'document' ORDER BY 1")).rows;
      assert.deepEqual(rows.map((x) => x.tenant_key), [...tenants].sort());
      for (const row of rows) assert.deepEqual([row.target, row.profile_id], ['weaviate', 'voyage-4-large-1024']);
    });

    test('expand refuses a document row and a row that is not leased', async () => {
      const d = await insertRow(db, { entityId: 'doc-e', tenantKey: tenant });
      await claim(db, 1);
      await assert.rejects(() => db.query('SELECT * FROM public.rag_vector_sync_expand($1, 10)', [d]), (e: unknown) => (e as { code?: string }).code === '22023');
      const t = await insertRow(db, { entity: 'tenant', entityId: tenant, tenantKey: tenant });
      await assert.rejects(() => db.query('SELECT * FROM public.rag_vector_sync_expand($1, 10)', [t]), (e: unknown) => (e as { code?: string }).code === '22023');
    });

    test('requeue_dead returns dead rows of one target to pending with attempts 0', async () => {
      const q = await insertRow(db, { entityId: 'doc-d1', tenantKey: tenant });
      const w = await insertRow(db, { target: 'weaviate', entityId: 'doc-d2', tenantKey: tenant });
      await db.query("UPDATE public.vector_sync_outbox SET status = 'dead', attempts = 8");
      const n = (await db.query<{ n: number }>("SELECT public.rag_vector_sync_requeue_dead('qdrant') AS n")).rows[0]!.n;
      assert.equal(n, 1);
      const rq = await rowById(db, q);
      assert.deepEqual([rq.status, rq.attempts, rq.lease_until], ['pending', 0, null]);
      assert.equal((await rowById(db, w)).status, 'dead');
      await assert.rejects(() => db.query("SELECT public.rag_vector_sync_requeue_dead('pinecone')"), (e: unknown) => (e as { code?: string }).code === '22023');
    });

    test('set_target enables a backend, enqueues one tenant row per tenant with current documents and marks index state building', async () => {
      if (mode === 'multi-tenant') await createOrgDocument(db);
      const tenants = (await db.query<{ k: string }>('SELECT DISTINCT tenant_key AS k FROM public.documents WHERE is_current ORDER BY 1')).rows.map((r) => r.k);
      assert.ok(tenants.includes(tenant));
      if (mode === 'single-tenant') assert.deepEqual(tenants, ['s:default']);
      if (mode === 'multi-tenant') assert.ok(tenants.length >= 2, 'a personal and an organisation tenant');
      await db.query("UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = 'voyage-4-large-1024'");
      await db.exec('DELETE FROM public.vector_sync_outbox');
      const n = (await db.query<{ n: number }>("SELECT public.rag_vector_sync_set_target('qdrant', true, 'ops@example.invalid') AS n")).rows[0]!.n;
      assert.equal(n, tenants.length);
      const target = (await db.query<{ enabled: boolean; updated_by: string }>("SELECT enabled, updated_by FROM public.rag_vector_sync_targets WHERE target = 'qdrant'")).rows[0]!;
      assert.deepEqual([target.enabled, target.updated_by], [true, 'ops@example.invalid']);
      const rows = (await db.query<Row>("SELECT * FROM public.vector_sync_outbox ORDER BY entity_id")).rows;
      assert.deepEqual(
        rows.map((r) => [r.target, r.entity, r.entity_id, r.tenant_key, r.profile_id]),
        tenants.map((t) => ['qdrant', 'tenant', t, t, null]),
      );
      const state = (await db.query<{ profile_id: string; tenant_key: string; state: string }>(
        "SELECT profile_id, tenant_key, state FROM public.rag_backend_index_state WHERE target = 'qdrant' ORDER BY profile_id, tenant_key",
      )).rows;
      const expected = ['openai-3-small-1536', 'voyage-4-large-1024'].flatMap((p) => [...tenants].sort().map((t) => ({ profile_id: p, tenant_key: t, state: 'building' })));
      assert.deepEqual(state, expected);
      await db.query("UPDATE public.embedding_profiles SET status = 'available' WHERE id = 'voyage-4-large-1024'");

      await db.exec('DELETE FROM public.vector_sync_outbox');
      const off = (await db.query<{ n: number }>("SELECT public.rag_vector_sync_set_target('qdrant', false, 'ops@example.invalid') AS n")).rows[0]!.n;
      assert.equal(off, 0);
      assert.equal((await db.query<{ e: boolean }>("SELECT enabled AS e FROM public.rag_vector_sync_targets WHERE target = 'qdrant'")).rows[0]!.e, false);
      assert.equal(Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.vector_sync_outbox')).rows[0]!.n), 0);
    });

    test('set_target validates its target and actor', async () => {
      for (const sql of [
        "SELECT public.rag_vector_sync_set_target('pinecone', true, 'ops')",
        "SELECT public.rag_vector_sync_set_target('qdrant', true, '  ')",
        "SELECT public.rag_vector_sync_set_target('qdrant', NULL, 'ops')",
      ]) {
        await assert.rejects(() => db.query(sql), (e: unknown) => (e as { code?: string }).code === '22023', sql);
      }
    });

    test('claim validates its limits', async () => {
      for (const [limit, lease] of [[0, 60], [1001, 60], [10, 0], [10, 3601]]) {
        await assert.rejects(() => db.query('SELECT * FROM public.rag_vector_sync_claim($1, $2)', [limit, lease]), (e: unknown) => (e as { code?: string }).code === '22023');
      }
    });

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501 on every vector sync function`, async () => {
        for (const [fn, sql] of FUNCTIONS) await expectDenied(db, role, sql, fn);
        for (const fn of ['rag_vector_sync_enqueue(text, text[], text[], text[], text)']) {
          await expectDenied(db, role, "SELECT public.rag_vector_sync_enqueue('document', ARRAY['x'], ARRAY['s:default'], ARRAY[NULL::text], NULL)", fn);
        }
      });
    }

    test('every vector sync function is service-role only with a pinned search_path', async () => {
      const r = await db.query<{ sig: string; config: string[] | null; anon: boolean; auth: boolean; pub: boolean; svc: boolean }>(
        `SELECT p.oid::regprocedure::text AS sig, p.proconfig AS config,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS pub,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rag_vector_sync_%' ORDER BY 1`,
      );
      assert.ok(r.rows.length >= 18, `expected the 0702 and 0703 functions, got ${r.rows.length}`);
      for (const row of r.rows) {
        assert.deepEqual([row.anon, row.auth, row.pub, row.svc], [false, false, false, true], row.sig);
        assert.deepEqual(row.config, ['search_path=""'], `${row.sig} search_path`);
      }
    });

    test('service_role can run the claim cycle', async () => {
      const a = await insertRow(db, { entityId: 'doc-svc', tenantKey: tenant });
      await db.exec('SET ROLE service_role');
      try {
        const rows = (await db.query<Row>('SELECT * FROM public.rag_vector_sync_claim(5, 60)')).rows;
        assert.equal(rows.length, 1);
        await db.query('SELECT public.rag_vector_sync_complete($1::bigint[])', [[a]]);
      } finally {
        await db.exec('RESET ROLE');
      }
      assert.equal((await rowById(db, a)).status, 'done');
    });
  });
}
