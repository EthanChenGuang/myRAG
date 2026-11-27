import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import type { PGlite } from '@electric-sql/pglite';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MIGRATION = path.join(REPO_ROOT, 'supabase/migrations/0740_vector_sync_purge.sql');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const ACTOR = 'purge-flow:test';
const REASON = 'lineage_deleted';

const FUNCTIONS: [signature: string, call: string][] = [
  [
    'rag_vector_sync_enqueue_purge(text, uuid, uuid[], text, text)',
    `SELECT public.rag_vector_sync_enqueue_purge('s:default', gen_random_uuid(), ARRAY[gen_random_uuid()], 'a', 'b')`,
  ],
  ['rag_vector_sync_purge_row(uuid)', 'SELECT * FROM public.rag_vector_sync_purge_row(gen_random_uuid())'],
  ['rag_vector_sync_purge_complete(uuid, text, integer, bigint)', "SELECT public.rag_vector_sync_purge_complete(gen_random_uuid(), 'qdrant', 0, 0)"],
  ['rag_vector_sync_purge_status(text, uuid)', "SELECT * FROM public.rag_vector_sync_purge_status('s:default', gen_random_uuid())"],
  [
    'rag_vector_sync_purged_documents(text, text, uuid, integer)',
    "SELECT * FROM public.rag_vector_sync_purged_documents('qdrant', 's:default', NULL, 10)",
  ],
  ['rag_vector_sync_purge_reopen(uuid, text)', "SELECT public.rag_vector_sync_purge_reopen(gen_random_uuid(), 'qdrant')"],
  ['rag_vector_sync_enqueue_stale(text, text, uuid[])', "SELECT public.rag_vector_sync_enqueue_stale('qdrant', 's:default', ARRAY[gen_random_uuid()])"],
];
const TABLES = ['vector_sync_purges', 'vector_sync_purge_targets'];

interface StatusRow {
  target: string;
  state: string;
  collections_checked: number | null;
  points_deleted: string | number | null;
}

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;
}

function otherModeKey(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
}

async function insertDocument(db: PGlite, mode: DeploymentMode, opts: { lineageId?: string; version?: number; userId?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  const userId = mode === 'multi-tenant' ? (opts.userId ?? FIXTURE_USER_ID) : null;
  if (opts.lineageId) {
    await db.query(
      "INSERT INTO public.documents (id, filename, content, metadata, user_id, lineage_id, version, is_current) VALUES ($1, $2, 'purge fixture', '{}'::jsonb, $3::uuid, $4, $5, false)",
      [id, `purge-${id}.txt`, userId, opts.lineageId, opts.version ?? 2],
    );
  } else {
    await db.query("INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, 'purge fixture', '{}'::jsonb, $3::uuid)", [
      id,
      `purge-${id}.txt`,
      userId,
    ]);
  }
  return id;
}

/** A lineage of `versions` documents; the first id is the lineage id. */
async function createLineage(db: PGlite, mode: DeploymentMode, versions: number): Promise<{ lineageId: string; ids: string[] }> {
  const first = await insertDocument(db, mode);
  const ids = [first];
  for (let v = 2; v <= versions; v += 1) ids.push(await insertDocument(db, mode, { lineageId: first, version: v }));
  return { lineageId: first, ids };
}

async function enqueue(db: PGlite, tenantKey: string, lineageId: string, ids: string[], actor: string | null = ACTOR, reason: string = REASON): Promise<string | null> {
  const r = await db.query<{ id: string | null }>('SELECT public.rag_vector_sync_enqueue_purge($1, $2::uuid, $3::uuid[], $4, $5) AS id', [
    tenantKey,
    lineageId,
    ids,
    actor,
    reason,
  ]);
  return r.rows[0]!.id;
}

async function enable(db: PGlite, target: 'qdrant' | 'weaviate'): Promise<void> {
  await db.query('UPDATE public.rag_vector_sync_targets SET enabled = true WHERE target = $1', [target]);
}

async function addIndexState(db: PGlite, target: 'qdrant' | 'weaviate', tenantKey: string): Promise<void> {
  await db.query("INSERT INTO public.rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ($1, 'openai-3-small-1536', $2, 'ready')", [target, tenantKey]);
}

async function counts(db: PGlite): Promise<{ purges: number; targets: number; outbox: number }> {
  const r = await db.query<{ purges: number; targets: number; outbox: number }>(
    `SELECT (SELECT count(*)::int FROM public.vector_sync_purges) AS purges,
            (SELECT count(*)::int FROM public.vector_sync_purge_targets) AS targets,
            (SELECT count(*)::int FROM public.vector_sync_outbox) AS outbox`,
  );
  return r.rows[0]!;
}

async function status(db: PGlite, tenantKey: string, lineageId: string): Promise<Record<string, StatusRow>> {
  const rows = (await db.query<StatusRow>('SELECT * FROM public.rag_vector_sync_purge_status($1, $2::uuid)', [tenantKey, lineageId])).rows;
  return Object.fromEntries(rows.map((r) => [r.target, r]));
}

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const e = error as { code?: string; message?: string };
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (message) assert.match(e.message ?? '', message);
    return true;
  });
}

async function catalogSnapshot(db: PGlite): Promise<string> {
  const r = await db.query<{ s: string }>(
    `SELECT jsonb_build_object(
       'constraints', (SELECT jsonb_agg(c.conname || ':' || pg_get_constraintdef(c.oid) ORDER BY c.conname) FROM pg_constraint c
                        WHERE c.conrelid IN ('public.vector_sync_outbox'::regclass, 'public.vector_sync_purges'::regclass, 'public.vector_sync_purge_targets'::regclass)),
       'functions', (SELECT jsonb_agg(p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proacl, ','), '') ORDER BY 1)
                       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rag_vector_sync_%'),
       'tables', (SELECT jsonb_agg(c.relname || ':' || c.relrowsecurity || ':' || coalesce(array_to_string(c.relacl, ','), '') ORDER BY c.relname) FROM pg_class c
                    WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('vector_sync_purges', 'vector_sync_purge_targets', 'vector_sync_outbox')),
       'indexes', (SELECT jsonb_agg(i.indexname || ':' || i.indexdef ORDER BY i.indexname) FROM pg_indexes i
                     WHERE i.schemaname = 'public' AND i.tablename IN ('vector_sync_purges', 'vector_sync_purge_targets', 'vector_sync_outbox'))
     )::text AS s`,
  );
  return r.rows[0]!.s;
}

for (const mode of MODES) {
  describe(`vector sync purges 0740 (${mode})`, () => {
    let db: PGlite;
    const tenant = tenantFor(mode);

    before(async () => {
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS })).db;
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await db.exec(
        'UPDATE public.rag_vector_sync_targets SET enabled = false; DELETE FROM public.vector_sync_outbox; DELETE FROM public.rag_backend_index_state; DELETE FROM public.vector_sync_purges;',
      );
    });

    test('with qdrant enabled one purge is one ledger row, one target row and one outbox row that claim, row, complete and status follow', async () => {
      await enable(db, 'qdrant');
      const { lineageId, ids } = await createLineage(db, mode, 2);
      const purgeId = await enqueue(db, tenant, lineageId, ids);
      assert.ok(purgeId);
      const ledger = (await db.query<{ tenant_key: string; lineage_id: string; document_ids: string[]; requested_by: string; reason_code: string }>(
        'SELECT tenant_key, lineage_id, document_ids, requested_by, reason_code FROM public.vector_sync_purges',
      )).rows;
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]!.tenant_key, tenant);
      assert.equal(ledger[0]!.lineage_id, lineageId);
      assert.deepEqual([...ledger[0]!.document_ids].sort(), [...ids].sort());
      assert.equal(ledger[0]!.requested_by, ACTOR);
      assert.equal(ledger[0]!.reason_code, REASON);
      const targets = (await db.query<{ target: string; status: string }>('SELECT target, status FROM public.vector_sync_purge_targets')).rows;
      assert.deepEqual(targets, [{ target: 'qdrant', status: 'pending' }]);
      const outbox = (await db.query<{ target: string; entity: string; entity_id: string; tenant_key: string; profile_id: string | null }>(
        'SELECT target, entity, entity_id, tenant_key, profile_id FROM public.vector_sync_outbox',
      )).rows;
      assert.deepEqual(outbox, [{ target: 'qdrant', entity: 'purge', entity_id: purgeId, tenant_key: tenant, profile_id: null }]);
      assert.equal((await status(db, tenant, lineageId)).qdrant!.state, 'pending');

      const claimed = (await db.query<{ id: number; entity: string; entity_id: string }>('SELECT * FROM public.rag_vector_sync_claim(10, 60)')).rows;
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0]!.entity, 'purge');
      const row = (await db.query<{ purge_id: string; tenant_key: string; lineage_id: string; document_ids: string[] }>(
        'SELECT * FROM public.rag_vector_sync_purge_row($1::uuid)',
        [claimed[0]!.entity_id],
      )).rows;
      assert.equal(row.length, 1);
      assert.equal(row[0]!.tenant_key, tenant);
      assert.equal(row[0]!.lineage_id, lineageId);
      assert.deepEqual([...row[0]!.document_ids].sort(), [...ids].sort());

      const done = await db.query<{ ok: boolean }>("SELECT public.rag_vector_sync_purge_complete($1::uuid, 'qdrant', 3, 17) AS ok", [purgeId]);
      assert.equal(done.rows[0]!.ok, true);
      await db.query('SELECT public.rag_vector_sync_complete($1::bigint[])', [[Number(claimed[0]!.id)]]);
      const st = await status(db, tenant, lineageId);
      assert.equal(st.qdrant!.state, 'done');
      assert.equal(st.qdrant!.collections_checked, 3);
      assert.equal(Number(st.qdrant!.points_deleted), 17);
      assert.equal(st.weaviate!.state, 'not_applicable');
    });

    test('a disabled weaviate that still holds index state for the tenant gets its own target row and outbox row', async () => {
      await enable(db, 'qdrant');
      await addIndexState(db, 'weaviate', tenant);
      const { lineageId, ids } = await createLineage(db, mode, 1);
      const purgeId = await enqueue(db, tenant, lineageId, ids);
      const targets = (await db.query<{ target: string }>('SELECT target FROM public.vector_sync_purge_targets ORDER BY target')).rows.map((r) => r.target);
      assert.deepEqual(targets, ['qdrant', 'weaviate']);
      const outbox = (await db.query<{ target: string; entity_id: string }>("SELECT target, entity_id FROM public.vector_sync_outbox WHERE entity = 'purge' ORDER BY target")).rows;
      assert.deepEqual(outbox, [
        { target: 'qdrant', entity_id: purgeId },
        { target: 'weaviate', entity_id: purgeId },
      ]);
    });

    test('index state of another tenant does not make a disabled target applicable', async () => {
      await addIndexState(db, 'weaviate', 'o:00000000-0000-4000-8000-0000000000e9');
      const { lineageId, ids } = await createLineage(db, mode, 1);
      assert.equal(await enqueue(db, tenant, lineageId, ids), null);
      assert.deepEqual(await counts(db), { purges: 0, targets: 0, outbox: 0 });
    });

    test('returns NULL and writes nothing with no enabled target and no index state (a default install stays empty)', async () => {
      const { lineageId, ids } = await createLineage(db, mode, 2);
      assert.equal(await enqueue(db, tenant, lineageId, ids), null);
      assert.deepEqual(await counts(db), { purges: 0, targets: 0, outbox: 0 });
      const st = await status(db, tenant, lineageId);
      assert.equal(st.qdrant!.state, 'not_applicable');
      assert.equal(st.weaviate!.state, 'not_applicable');
    });

    test('a second enqueue for the same lineage keeps the purge id, stores the union of ids and re-opens a done target', async () => {
      await enable(db, 'qdrant');
      const { lineageId, ids } = await createLineage(db, mode, 2);
      const first = await enqueue(db, tenant, lineageId, [ids[0]!]);
      const claimed = (await db.query<{ id: number }>('SELECT * FROM public.rag_vector_sync_claim(10, 60)')).rows;
      await db.query("SELECT public.rag_vector_sync_purge_complete($1::uuid, 'qdrant', 1, 1)", [first]);
      await db.query('SELECT public.rag_vector_sync_complete($1::bigint[])', [[Number(claimed[0]!.id)]]);
      assert.equal((await status(db, tenant, lineageId)).qdrant!.state, 'done');

      const second = await enqueue(db, tenant, lineageId, [ids[0]!, ids[1]!]);
      assert.equal(second, first);
      const ledger = (await db.query<{ document_ids: string[] }>('SELECT document_ids FROM public.vector_sync_purges')).rows;
      assert.equal(ledger.length, 1);
      assert.deepEqual([...ledger[0]!.document_ids].sort(), [...ids].sort());
      const target = (await db.query<{ status: string; completed_at: Date | null }>('SELECT status, completed_at FROM public.vector_sync_purge_targets')).rows[0]!;
      assert.equal(target.status, 'pending');
      assert.equal(target.completed_at, null);
      const pending = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.vector_sync_outbox WHERE entity = 'purge' AND status = 'pending'")).rows[0]!.n;
      assert.equal(pending, 1);
      assert.equal((await status(db, tenant, lineageId)).qdrant!.state, 'pending');

      assert.equal(await enqueue(db, tenant, lineageId, [ids[1]!]), first, 'a repeated call while a row waits untried adds no outbox row');
      assert.equal((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.vector_sync_outbox WHERE entity = 'purge' AND status = 'pending'")).rows[0]!.n, 1);
    });

    test('a purge outbox row that reached dead is reported dead for its target', async () => {
      await enable(db, 'qdrant');
      const { lineageId, ids } = await createLineage(db, mode, 1);
      await enqueue(db, tenant, lineageId, ids);
      await db.query("UPDATE public.vector_sync_outbox SET status = 'dead', attempts = 8, last_error = 'backend_error:503' WHERE entity = 'purge'");
      assert.equal((await status(db, tenant, lineageId)).qdrant!.state, 'dead');
      await db.query("SELECT public.rag_vector_sync_requeue_dead('qdrant')");
      assert.equal((await status(db, tenant, lineageId)).qdrant!.state, 'pending');
    });

    test('the entity CHECK accepts chunk, document, profile, tenant and purge and nothing else', async () => {
      for (const entity of ['chunk', 'document', 'profile', 'tenant', 'purge']) {
        await db.query("INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key) VALUES ('qdrant', $1, 'x', $2)", [entity, tenant]);
      }
      await expectCode(db.query("INSERT INTO public.vector_sync_outbox (target, entity, entity_id, tenant_key) VALUES ('qdrant', 'lineage', 'x', $1)", [tenant]), '23514');
    });

    test('re-applying 0740 leaves the catalog unchanged', async () => {
      const beforeSnapshot = await catalogSnapshot(db);
      await db.exec(fs.readFileSync(MIGRATION, 'utf8'));
      assert.equal(await catalogSnapshot(db), beforeSnapshot);
    });

    test('a malformed, upper-case or other-mode tenant key raises the tenant guard and writes nothing', async () => {
      await enable(db, 'qdrant');
      const { lineageId, ids } = await createLineage(db, mode, 1);
      await expectCode(enqueue(db, 'tenant-x', lineageId, ids), '22023', /malformed tenant key/);
      await expectCode(enqueue(db, tenant.toUpperCase(), lineageId, ids), '22023', /malformed tenant key/);
      await expectCode(enqueue(db, otherModeKey(mode), lineageId, ids), '22023', /not valid for this deployment mode/);
      await expectCode(db.query('SELECT * FROM public.rag_vector_sync_purge_status($1, $2::uuid)', [otherModeKey(mode), lineageId]), '22023');
      await expectCode(db.query("SELECT * FROM public.rag_vector_sync_purged_documents('qdrant', $1, NULL, 10)", [otherModeKey(mode)]), '22023');
      await expectCode(db.query("SELECT public.rag_vector_sync_enqueue_stale('qdrant', $1, ARRAY[gen_random_uuid()])", [otherModeKey(mode)]), '22023');
      assert.deepEqual(await counts(db), { purges: 0, targets: 0, outbox: 0 });
    });

    test('lineage_mismatch: a document of another lineage of the same tenant is refused; an id with no row is accepted', async () => {
      await enable(db, 'qdrant');
      const a = await createLineage(db, mode, 1);
      const b = await createLineage(db, mode, 1);
      await expectCode(enqueue(db, tenant, a.lineageId, [a.ids[0]!, b.ids[0]!]), '22023', /vector_sync_refused: lineage_mismatch/);
      assert.deepEqual(await counts(db), { purges: 0, targets: 0, outbox: 0 });
      const gone = crypto.randomUUID();
      assert.ok(await enqueue(db, tenant, a.lineageId, [a.ids[0]!, gone]));
    });

    test('bounds: more than 1000 ids, an empty array, a NULL actor or a reason code with a space raise 22023 and write nothing', async () => {
      await enable(db, 'qdrant');
      const { lineageId, ids } = await createLineage(db, mode, 1);
      const many = Array.from({ length: 1001 }, () => crypto.randomUUID());
      await expectCode(enqueue(db, tenant, lineageId, many), '22023');
      await expectCode(enqueue(db, tenant, lineageId, []), '22023');
      await expectCode(enqueue(db, tenant, lineageId, ids, null), '22023');
      await expectCode(enqueue(db, tenant, lineageId, ids, 'two words'), '22023');
      await expectCode(enqueue(db, tenant, lineageId, ids, ACTOR, 'lineage deleted'), '22023');
      await expectCode(
        db.query('SELECT public.rag_vector_sync_enqueue_purge($1, NULL::uuid, $2::uuid[], $3, $4)', [tenant, ids, ACTOR, REASON]),
        '22023',
      );
      assert.deepEqual(await counts(db), { purges: 0, targets: 0, outbox: 0 });
    });

    test('the union of ids above 1000 raises 22023 and keeps the ledger row as it was', async () => {
      await enable(db, 'qdrant');
      const { lineageId } = await createLineage(db, mode, 1);
      const firstIds = Array.from({ length: 600 }, () => crypto.randomUUID());
      const secondIds = Array.from({ length: 600 }, () => crypto.randomUUID());
      await enqueue(db, tenant, lineageId, firstIds);
      await expectCode(enqueue(db, tenant, lineageId, secondIds), '22023');
      const n = (await db.query<{ n: number }>('SELECT cardinality(document_ids) AS n FROM public.vector_sync_purges')).rows[0]!.n;
      assert.equal(n, 600);
    });

    test('anon and authenticated are refused every 0740 function and both tables; service_role can call them', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          for (const [fn, sql] of FUNCTIONS) {
            await expectCode(db.query(sql), '42501').catch((error: unknown) => {
              throw new Error(`${role} must be refused ${fn}: ${(error as Error).message}`);
            });
          }
          for (const table of TABLES) await expectCode(db.query(`SELECT * FROM public.${table}`), '42501');
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      const acl = (await db.query<{ fn: string; anon: boolean; auth: boolean; pub: boolean; svc: boolean; definer: boolean; config: string[] | null }>(
        `SELECT p.oid::regprocedure::text AS fn,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0)) AS pub,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
                p.prosecdef AS definer, p.proconfig AS config
           FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[])`,
        [FUNCTIONS.map(([fn]) => `public.${fn}`)],
      )).rows;
      assert.equal(acl.length, FUNCTIONS.length);
      for (const row of acl) {
        assert.deepEqual([row.anon, row.auth, row.pub, row.svc, row.definer], [false, false, false, true, false], row.fn);
        assert.deepEqual(row.config, ['search_path=""'], row.fn);
      }
      const { lineageId } = await createLineage(db, mode, 1);
      await db.exec('SET ROLE service_role');
      try {
        const rows = (await db.query('SELECT * FROM public.rag_vector_sync_purge_status($1, $2::uuid)', [tenant, lineageId])).rows;
        assert.equal(rows.length, 2);
        await db.query("SELECT * FROM public.rag_vector_sync_purged_documents('qdrant', $1, NULL, 10)", [tenant]);
      } finally {
        await db.exec('RESET ROLE');
      }
    });

    test('purged_documents pages the must-be-absent ids of one target and tenant in document id order', async () => {
      await enable(db, 'qdrant');
      const a = await createLineage(db, mode, 2);
      const b = await createLineage(db, mode, 1);
      const pa = await enqueue(db, tenant, a.lineageId, a.ids);
      const pb = await enqueue(db, tenant, b.lineageId, b.ids);
      const expected = [
        ...a.ids.map((id) => ({ document_id: id, purge_id: pa, lineage_id: a.lineageId })),
        ...b.ids.map((id) => ({ document_id: id, purge_id: pb, lineage_id: b.lineageId })),
      ].sort((x, y) => (x.document_id < y.document_id ? -1 : 1));
      const page = async (after: string | null, limit: number) =>
        (await db.query<{ document_id: string; purge_id: string; lineage_id: string }>(
          'SELECT * FROM public.rag_vector_sync_purged_documents($1, $2, $3::uuid, $4)',
          ['qdrant', tenant, after, limit],
        )).rows;
      const first = await page(null, 2);
      assert.deepEqual(first, expected.slice(0, 2));
      assert.deepEqual(await page(first[1]!.document_id, 2), expected.slice(2));
      assert.deepEqual(await page(null, 10), expected);
      assert.deepEqual((await db.query("SELECT * FROM public.rag_vector_sync_purged_documents('weaviate', $1, NULL, 10)", [tenant])).rows, []);
      await expectCode(page(null, 1001), '22023');
      await expectCode(db.query("SELECT * FROM public.rag_vector_sync_purged_documents('pinecone', $1, NULL, 10)", [tenant]), '22023');
    });

    test('purged_documents returns nothing for a tenant without purges', async () => {
      const rows = (await db.query("SELECT * FROM public.rag_vector_sync_purged_documents('qdrant', $1, NULL, 10)", [tenant])).rows;
      assert.deepEqual(rows, []);
    });

    test('reopen sets a done target back to pending with one new purge outbox row; a pending target is left alone', async () => {
      await enable(db, 'qdrant');
      const { lineageId, ids } = await createLineage(db, mode, 1);
      const purgeId = await enqueue(db, tenant, lineageId, ids);
      const reopen = async () => (await db.query<{ ok: boolean }>("SELECT public.rag_vector_sync_purge_reopen($1::uuid, 'qdrant') AS ok", [purgeId])).rows[0]!.ok;
      assert.equal(await reopen(), false, 'pending target');
      assert.equal((await counts(db)).outbox, 1);
      const claimed = (await db.query<{ id: number }>('SELECT * FROM public.rag_vector_sync_claim(10, 60)')).rows;
      await db.query("SELECT public.rag_vector_sync_purge_complete($1::uuid, 'qdrant', 1, 2)", [purgeId]);
      await db.query('SELECT public.rag_vector_sync_complete($1::bigint[])', [[Number(claimed[0]!.id)]]);
      await db.query("UPDATE public.rag_vector_sync_targets SET enabled = false WHERE target = 'qdrant'");
      assert.equal(await reopen(), true, 'a done target re-opens even while its backend is disabled');
      const outbox = (await db.query<{ entity: string; entity_id: string; status: string }>(
        "SELECT entity, entity_id, status FROM public.vector_sync_outbox WHERE status = 'pending'",
      )).rows;
      assert.deepEqual(outbox, [{ entity: 'purge', entity_id: purgeId, status: 'pending' }]);
      assert.equal((await status(db, tenant, lineageId)).qdrant!.state, 'pending');
      await expectCode(db.query("SELECT public.rag_vector_sync_purge_reopen(gen_random_uuid(), 'qdrant')"), '22023');
      await expectCode(db.query("SELECT public.rag_vector_sync_purge_reopen($1::uuid, 'weaviate')", [purgeId]), '22023');
      await expectCode(db.query("SELECT public.rag_vector_sync_purge_reopen($1::uuid, 'pinecone')", [purgeId]), '22023');
    });

    test('reopen applies the tenant guard to the ledger key', async () => {
      await enable(db, 'qdrant');
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO public.vector_sync_purges (id, tenant_key, lineage_id, document_ids, requested_by, reason_code) VALUES ($1, $2, gen_random_uuid(), ARRAY[gen_random_uuid()], 'a', 'b')",
        [id, otherModeKey(mode)],
      );
      await db.query("INSERT INTO public.vector_sync_purge_targets (purge_id, target, status) VALUES ($1, 'qdrant', 'done')", [id]);
      await expectCode(db.query("SELECT public.rag_vector_sync_purge_reopen($1::uuid, 'qdrant')", [id]), '22023', /not valid for this deployment mode/);
    });
  });
}

describe('vector sync purges 0740 across tenants (multi-tenant)', () => {
  let db: PGlite;
  const keyA = `u:${TWO_TENANT_IDS.userA}`;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
  });

  after(async () => {
    await db.close();
  });

  test('lineage_mismatch: tenant A cannot name a document that exists under tenant B', async () => {
    await db.query("UPDATE public.rag_vector_sync_targets SET enabled = true WHERE target = 'qdrant'");
    const lineageB = (await db.query<{ lineage_id: string }>('SELECT lineage_id FROM public.documents WHERE id = $1', [TWO_TENANT_IDS.docB])).rows[0]!.lineage_id;
    const lineageA = (await db.query<{ lineage_id: string }>('SELECT lineage_id FROM public.documents WHERE id = $1', [TWO_TENANT_IDS.docA])).rows[0]!.lineage_id;
    for (const lineage of [lineageB, lineageA]) {
      await expectCode(enqueue(db, keyA, lineage, [TWO_TENANT_IDS.docB]), '22023', /vector_sync_refused: lineage_mismatch/);
    }
    assert.deepEqual(await counts(db), { purges: 0, targets: 0, outbox: 0 });
  });

  test('purge status and must-be-absent rows of tenant B are not visible under tenant A', async () => {
    await db.query("UPDATE public.rag_vector_sync_targets SET enabled = true WHERE target = 'qdrant'");
    const keyB = `u:${TWO_TENANT_IDS.userB}`;
    const lineageB = (await db.query<{ lineage_id: string }>('SELECT lineage_id FROM public.documents WHERE id = $1', [TWO_TENANT_IDS.docB])).rows[0]!.lineage_id;
    assert.ok(await enqueue(db, keyB, lineageB, [TWO_TENANT_IDS.docB]));
    const st = await status(db, keyA, lineageB);
    assert.equal(st.qdrant!.state, 'not_applicable');
    assert.deepEqual((await db.query("SELECT * FROM public.rag_vector_sync_purged_documents('qdrant', $1, NULL, 10)", [keyA])).rows, []);
    assert.equal((await db.query("SELECT * FROM public.rag_vector_sync_purged_documents('qdrant', $1, NULL, 10)", [keyB])).rows.length, 1);
  });
});

describe('vector sync purge RPCs through the fake edge (multi-tenant)', () => {
  let db: PGlite;
  let edge: FakeEdge;
  let client: RpcClient;
  const key = `u:${TWO_TENANT_IDS.userA}`;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    edge = await startFakeEdge({ db });
    const env = fixtureProcessEnv(edge.url);
    client = createClient(edge.url, env.SUPABASE_SERVICE_ROLE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as RpcClient;
  });

  after(async () => {
    await edge?.close();
    await db?.close();
  });

  test('purge status answers with named arguments', async () => {
    const response = await client.rpc('rag_vector_sync_purge_status', { p_tenant_key: key, p_lineage_id: crypto.randomUUID() });
    assert.equal(response.error, null);
    const rows = response.data as StatusRow[];
    assert.deepEqual(rows.map((r) => [r.target, r.state]).sort(), [
      ['qdrant', 'not_applicable'],
      ['weaviate', 'not_applicable'],
    ]);
    const extra = await client.rpc('rag_vector_sync_purge_status', { p_tenant_key: key, p_lineage_id: crypto.randomUUID(), p_extra: 1 });
    assert.notEqual(extra.error, null);
  });

  test('a rag_ function created inside the test resolves without registering it in the fake edge', async () => {
    await db.exec(
      "CREATE OR REPLACE FUNCTION public.rag_test_probe_0740(p_value integer) RETURNS TABLE (next_value integer) LANGUAGE sql SET search_path = '' AS $$ SELECT p_value + 1 $$; GRANT EXECUTE ON FUNCTION public.rag_test_probe_0740(integer) TO service_role;",
    );
    try {
      const response = await client.rpc('rag_test_probe_0740', { p_value: 41 });
      assert.equal(response.error, null);
      assert.deepEqual(response.data, [{ next_value: 42 }]);
    } finally {
      await db.exec('DROP FUNCTION public.rag_test_probe_0740(integer)');
    }
  });
});
