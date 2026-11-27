import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// 04.3-12 (SEC-13, D-23, D-24, A-05, A-06): rag_cache_check serves an entry only to callers who can see every source document, a caller who
// cannot see one gets a miss that leaves the entry in place, and a relabel of a source document empties the tenant's cache. Neutral data.

const GROUP_A = '00000000-0000-4000-8000-00000000c1a1';
const GROUP_B = '00000000-0000-4000-8000-00000000c1b1';
const MEMBER_A_KEYS = ['all', `g:${GROUP_A}`];
const OUTSIDER_KEYS = ['all', `g:${GROUP_B}`];
const KEY_HASH = 'c'.repeat(64);
const OTHER_KEY_HASH = 'd'.repeat(64);
const ANSWER = { text: 'placeholder answer', citations: [] };
const BASE = '[1,0,0,0]';
const CHECK_SQL = 'SELECT * FROM public.rag_cache_check($1, $2, $3, $4::halfvec, $5, $6::text[], $7)';

interface CheckRow {
  hit: boolean;
  entry_id: string | null;
  distance: number | null;
  answer: unknown;
  is_refusal: boolean | null;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function asService<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.exec('SET ROLE service_role');
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function insertDoc(db: PGlite, mode: DeploymentMode, groups: string[]): Promise<string> {
  const id = crypto.randomUUID();
  if (mode === 'multi-tenant') {
    await db.query(
      `INSERT INTO documents (id, filename, content, metadata, user_id, lineage_id, source_key, status, is_current, version, access_groups)
       VALUES ($1, $2, 'placeholder', '{}'::jsonb, $3, $1, $4, 'ready', true, 1, $5::text[])`,
      [id, `doc-${id}.md`, FIXTURE_USER_ID, `legacy:${id}`, groups],
    );
  } else {
    await db.query(
      `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key, status, is_current, version, access_groups)
       VALUES ($1, $2, 'placeholder', '{}'::jsonb, $1, $3, 'ready', true, 1, $4::text[])`,
      [id, `doc-${id}.md`, `legacy:${id}`, groups],
    );
  }
  return id;
}

async function store(db: PGlite, tenant: string, sources: string[], options: { keyHash?: string; isRefusal?: boolean } = {}): Promise<string> {
  const result = await asService(db, () =>
    db.query<{ id: string }>('SELECT public.rag_cache_store($1, $2, $3, $4::halfvec, $5, $6::jsonb, $7::jsonb, $8, $9) AS id', [
      tenant,
      options.keyHash ?? KEY_HASH,
      'p1',
      BASE,
      'masked query placeholder',
      JSON.stringify(ANSWER),
      JSON.stringify(sources.map((id) => ({ document_id: id, version: 1 }))),
      options.isRefusal ?? false,
      3600,
    ]),
  );
  return result.rows[0]!.id;
}

async function check(
  db: PGlite,
  tenant: string,
  access: { keys: string[] | null; all?: boolean },
  keyHash = KEY_HASH,
): Promise<CheckRow> {
  const result = await asService(db, () => db.query<CheckRow>(CHECK_SQL, [tenant, keyHash, 'p1', BASE, 0.05, access.keys, access.all ?? false]));
  assert.equal(result.rows.length, 1);
  return result.rows[0]!;
}

async function rowCount(db: PGlite, tenant: string): Promise<number> {
  const result = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE tenant_key = $1', [tenant]);
  return result.rows[0]!.n;
}

async function setEnforced(db: PGlite, enforced: boolean): Promise<void> {
  await db.query('UPDATE public.rag_access_group_settings SET enforced = $1 WHERE id', [enforced]);
}

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';

  describe(`semantic cache under access groups (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
    });

    after(async () => {
      await db?.close();
    });

    test('exactly one rag_cache_check overload exists, service_role only, with the two access parameters last', async () => {
      const result = await db.query<{ args: string; anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'rag_cache_check'`,
      );
      assert.equal(result.rows.length, 1);
      assert.match(result.rows[0]!.args, /p_access_keys text\[\], p_access_all boolean$/);
      assert.deepEqual(
        { anon: result.rows[0]!.anon, authenticated: result.rows[0]!.authenticated, service: result.rows[0]!.service },
        { anon: false, authenticated: false, service: true },
      );
    });

    test('a member of the source group hits; an outsider misses and the entry stays', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const docId = await insertDoc(db, mode, [`g:${GROUP_A}`]);
      const id = await store(db, tenant, [docId]);

      const member = await check(db, tenant, { keys: MEMBER_A_KEYS });
      assert.equal(member.hit, true);
      assert.equal(member.entry_id, id);
      assert.deepEqual(member.answer, ANSWER);

      const outsider = await check(db, tenant, { keys: OUTSIDER_KEYS });
      assert.equal(outsider.hit, false);
      assert.equal(outsider.answer, null);
      assert.equal(outsider.entry_id, null);
      assert.equal(outsider.distance, null, 'a not-visible entry reports no distance');
      assert.equal(await rowCount(db, tenant), 1, "the outsider's lookup does not delete the member's entry");

      assert.equal((await check(db, tenant, { keys: MEMBER_A_KEYS })).hit, true, 'the member still hits after the outsider');
    });

    test('an entry with several sources is served only when every source is visible', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const open = await insertDoc(db, mode, ['all']);
      const restricted = await insertDoc(db, mode, [`g:${GROUP_A}`]);
      await store(db, tenant, [open, restricted]);
      assert.equal((await check(db, tenant, { keys: ['all'] })).hit, false);
      assert.equal((await check(db, tenant, { keys: MEMBER_A_KEYS })).hit, true);
      assert.equal(await rowCount(db, tenant), 1);
    });

    test('an admin (p_access_all) and a caller without keys while enforcement is off both hit', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const docId = await insertDoc(db, mode, [`g:${GROUP_A}`]);
      await store(db, tenant, [docId]);
      assert.equal((await check(db, tenant, { keys: ['all'], all: true })).hit, true);
      assert.equal((await check(db, tenant, { keys: null })).hit, true, 'switch off: today behaviour');
    });

    test('no keys while enforcement is on raises access_scope_required; an empty key array raises access_keys_empty', async () => {
      await setEnforced(db, true);
      try {
        await assert.rejects(
          () => check(db, tenant, { keys: null }),
          (error: unknown) => codeOf(error) === '42501' && /access_scope_required/.test(String((error as Error).message)),
        );
      } finally {
        await setEnforced(db, false);
      }
      await assert.rejects(() => check(db, tenant, { keys: [] }), (error: unknown) => codeOf(error) === '22023');
      await assert.rejects(() => check(db, tenant, { keys: ['all', null as unknown as string] }), (error: unknown) => codeOf(error) === '22023');
    });

    test('a refusal entry (no sources) is served only for its own key hash', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const id = await store(db, tenant, [], { isRefusal: true });
      const same = await check(db, tenant, { keys: OUTSIDER_KEYS });
      assert.equal(same.hit, true);
      assert.equal(same.entry_id, id);
      assert.equal(same.is_refusal, true);
      assert.equal((await check(db, tenant, { keys: OUTSIDER_KEYS }, OTHER_KEY_HASH)).hit, false);
      assert.equal((await check(db, tenant, { keys: MEMBER_A_KEYS }, OTHER_KEY_HASH)).hit, false);
    });

    test('a source that is no longer current is still deleted on lookup', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const docId = await insertDoc(db, mode, [`g:${GROUP_A}`]);
      await store(db, tenant, [docId]);
      await db.query('ALTER TABLE public.documents DISABLE TRIGGER USER');
      try {
        await db.query("UPDATE public.documents SET status = 'processing' WHERE id = $1", [docId]);
      } finally {
        await db.query('ALTER TABLE public.documents ENABLE TRIGGER USER');
      }
      assert.equal(await rowCount(db, tenant), 1, 'triggers were disabled, so the row is still there');
      assert.equal((await check(db, tenant, { keys: OUTSIDER_KEYS })).hit, false);
      assert.equal(await rowCount(db, tenant), 0, 'the stale row is deleted even on an outsider lookup');
    });

    test('a service-role relabel of a source document deletes the tenant cache rows', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const docId = await insertDoc(db, mode, [`g:${GROUP_A}`]);
      const other = await insertDoc(db, mode, ['all']);
      await store(db, tenant, [docId]);
      await store(db, tenant, [other], { keyHash: OTHER_KEY_HASH });
      assert.equal(await rowCount(db, tenant), 2);
      await asService(db, () => db.query('UPDATE public.documents SET access_groups = $2::text[] WHERE id = $1', [docId, [`g:${GROUP_B}`]]));
      assert.equal(await rowCount(db, tenant), 0, 'a relabel empties the tenant cache');
    });

    test('an update that leaves access_groups unchanged keeps the cache', async () => {
      await db.query('DELETE FROM public.rag_semantic_cache');
      const docId = await insertDoc(db, mode, [`g:${GROUP_A}`]);
      await store(db, tenant, [docId]);
      await asService(db, () => db.query("UPDATE public.documents SET metadata = '{\"note\":\"neutral\"}'::jsonb WHERE id = $1", [docId]));
      await asService(db, () => db.query('UPDATE public.documents SET access_groups = access_groups WHERE id = $1', [docId]));
      assert.equal(await rowCount(db, tenant), 1);
    });

    test('the Phase 6 update trigger is kept beside the access trigger', async () => {
      const result = await db.query<{ name: string; fn: string }>(
        `SELECT t.tgname AS name, t.tgfoid::regproc::text AS fn FROM pg_trigger t
         WHERE t.tgrelid = 'public.documents'::regclass AND t.tgname IN ('rag_semantic_cache_documents_update', 'rag_access_semantic_cache_update')
         ORDER BY 1`,
      );
      assert.deepEqual(result.rows, [
        { name: 'rag_access_semantic_cache_update', fn: 'rag_semantic_cache_on_access_update' },
        { name: 'rag_semantic_cache_documents_update', fn: 'rag_semantic_cache_on_documents_update' },
      ]);
      const fn = await db.query<{ definer: boolean; config: string[] | null; anon: boolean; authenticated: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
         FROM pg_proc p WHERE p.oid = 'public.rag_semantic_cache_on_access_update()'::regprocedure`,
      );
      assert.deepEqual(fn.rows[0], { definer: true, config: ['search_path=""'], anon: false, authenticated: false });
    });
  });
}
