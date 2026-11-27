import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * LEX-06 (D-31, D-32): every object of migrations 0900 to 0904 is closed to the client roles in both deployment modes. anon goes through
 * the fake PostgREST edge with the anon key; authenticated runs as PostgREST runs it, SET ROLE authenticated with the JWT claims of a user,
 * because the fake edge maps only the anon and service keys. The object list is exact: a new function of the phase fails the catalog test.
 */
const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';
const LEGACY = 'openai-3-small-1536';
const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const DOC_ID = '00000000-0000-4000-8000-0000000004a1';

// 0932 (train 35, 04.3) appended p_access_keys text[] and p_access_all boolean to the 0904 signature.
const BM25_SIGNATURE =
  'rag_bm25_search_chunks(text,text,vector,text[],integer,date,date,text[],uuid[],text[],text[],text[],text,numeric,numeric,text,jsonb,boolean,text[],boolean,date,jsonb,text[],double precision,double precision,integer,text[],boolean)';
const TRIGGER_FUNCTIONS = ['rag_lexstats_chunks_delete()', 'rag_lexstats_chunks_insert()', 'rag_lexstats_chunks_update()'];
/** The eleven callable functions of the phase: rag_lexical_dl (0900), the eight of 0902 (with the unguarded compaction body), the hook (0903), the search (0904). */
const RPC_SIGNATURES = [
  'rag_lexical_dl(tsvector)',
  'rag_lexstats_check(text)',
  'rag_lexstats_compact(text,integer)',
  'rag_lexstats_compact_all(integer)',
  'rag_lexstats_compact_tenant(text,integer)',
  'rag_lexstats_disable(text)',
  'rag_lexstats_enable(text)',
  'rag_lexstats_rebuild(text)',
  'rag_lexstats_status(text)',
  'rag_purge_hook_lexical_stats(text,uuid,uuid[])',
  BM25_SIGNATURE,
];
const EXPECTED_FUNCTIONS = [...RPC_SIGNATURES, ...TRIGGER_FUNCTIONS].sort();
const TABLES = ['rag_lexical_stats_state', 'rag_lexical_stats_pending', 'rag_lexical_df', 'rag_lexical_corpus'];
/** One statement per verb; the WHERE false bodies still need the privilege, so a refusal is the grant, never a row. */
const VERBS: Record<string, (table: string) => string> = {
  select: (table) => `SELECT 1 FROM public.${table} LIMIT 1`,
  insert: (table) => `INSERT INTO public.${table} (tenant_key) SELECT tenant_key FROM public.${table} WHERE false`,
  update: (table) => `UPDATE public.${table} SET tenant_key = tenant_key WHERE false`,
  delete: (table) => `DELETE FROM public.${table} WHERE false`,
};

/** RPC bodies in call order: enable before rebuild, rebuild before search, disable last. */
function rpcCalls(tenant: string): Array<{ fn: string; body: Record<string, unknown>; sql: string; params: unknown[] }> {
  return [
    { fn: 'rag_lexical_dl', body: { p_tsv: "'w1':1,3 'w2':2" }, sql: "SELECT public.rag_lexical_dl($1::tsvector)", params: ["'w1':1,3 'w2':2"] },
    { fn: 'rag_lexstats_enable', body: { p_tenant_key: tenant }, sql: 'SELECT public.rag_lexstats_enable($1)', params: [tenant] },
    { fn: 'rag_lexstats_rebuild', body: { p_tenant_key: tenant }, sql: 'SELECT public.rag_lexstats_rebuild($1)', params: [tenant] },
    {
      fn: 'rag_bm25_search_chunks',
      body: { p_tenant_key: tenant, p_profile_id: LEGACY, p_query_embedding: null, p_lexical_tokens: ['w1'], p_lexical_limit: 5 },
      sql: 'SELECT * FROM public.rag_bm25_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => NULL, p_lexical_tokens => $3::text[], p_lexical_limit => 5)',
      params: [tenant, LEGACY, ['w1']],
    },
    { fn: 'rag_lexstats_status', body: { p_tenant_key: tenant }, sql: 'SELECT public.rag_lexstats_status($1)', params: [tenant] },
    { fn: 'rag_lexstats_check', body: { p_tenant_key: tenant }, sql: 'SELECT public.rag_lexstats_check($1)', params: [tenant] },
    { fn: 'rag_lexstats_compact', body: { p_tenant_key: tenant, p_max_rows: 10 }, sql: 'SELECT public.rag_lexstats_compact($1, 10)', params: [tenant] },
    {
      fn: 'rag_lexstats_compact_tenant',
      body: { p_tenant_key: tenant, p_max_rows: 10 },
      sql: 'SELECT public.rag_lexstats_compact_tenant($1, 10)',
      params: [tenant],
    },
    { fn: 'rag_lexstats_compact_all', body: { p_max_rows: 10 }, sql: 'SELECT public.rag_lexstats_compact_all(10)', params: [] },
    {
      fn: 'rag_purge_hook_lexical_stats',
      body: { p_tenant_key: tenant, p_lineage_id: ZERO_UUID, p_document_ids: [] },
      sql: 'SELECT public.rag_purge_hook_lexical_stats($1, $2::uuid, ARRAY[]::uuid[])',
      params: [tenant, ZERO_UUID],
    },
    { fn: 'rag_lexstats_disable', body: { p_tenant_key: tenant }, sql: 'SELECT public.rag_lexstats_disable($1)', params: [tenant] },
  ];
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

/** Runs one statement as the client role inside a rolled-back transaction; authenticated carries the claims PostgREST sets. */
async function asRole(db: PGlite, role: 'anon' | 'authenticated', sql: string, params: unknown[] = []): Promise<unknown> {
  return db.transaction(async (tx) => {
    await tx.exec(`SET LOCAL ROLE ${role}`);
    if (role === 'authenticated') {
      await tx.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: FIXTURE_USER_ID, role: 'authenticated' })]);
    }
    try {
      return await tx.query(sql, params);
    } finally {
      await tx.rollback();
    }
  });
}

async function asService(db: PGlite, sql: string, params: unknown[] = []): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE service_role');
    await tx.query(sql, params);
    await tx.rollback();
  });
}

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  describe(`lexical statistics objects are closed to client roles (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;
    const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'single-tenant') {
        await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid')", [FIXTURE_USER_ID]);
      }
      await db.query(
        `INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type, language, is_current, status)
         VALUES ($1, 'grants-sample.txt', 'neutral sample', '{}'::jsonb, $2::uuid, 'general', 'en', true, 'ready')`,
        [DOC_ID, FIXTURE_USER_ID],
      );
      await db.query(
        `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index, lexical_text, language, doc_type, chunk_kind,
           chunking_profile_id, status, is_current)
         VALUES (gen_random_uuid(), $1, 'w1 w2 w3', '{}'::jsonb, 0, 'w1 w2 w3', 'en', 'general', 'text', 'legacy', 'ready', true)`,
        [DOC_ID],
      );
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    const post = async (apikey: string, fn: string, body: Record<string, unknown>) => {
      const res = await fetch(`${edge.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: { code?: string; message?: string } = {};
      try {
        parsed = JSON.parse(text) as { code?: string; message?: string };
      } catch {
        parsed = { message: text };
      }
      return { status: res.status, body: parsed };
    };

    test('the catalog holds exactly the expected functions; only the three trigger functions are definer; every one has an empty search_path', async () => {
      const rows = await db.query<{ sig: string; definer: boolean; config: string[] | null }>(
        `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer, p.proconfig AS config
           FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND (p.proname LIKE 'rag\\_lexstats\\_%' OR p.proname LIKE 'rag\\_bm25\\_%'
                 OR p.proname IN ('rag_lexical_dl', 'rag_purge_hook_lexical_stats')
                 OR p.proname ~ '^rag_lexical_(stats|df|corpus)')`,
      );
      const normalised = rows.rows.map((row) => ({ ...row, sig: row.sig.replace(/\bpublic\./g, '').replace(/\s*,\s*/g, ',') }));
      assert.deepEqual(normalised.map((row) => row.sig).sort(), EXPECTED_FUNCTIONS);
      for (const row of normalised) {
        assert.deepEqual(row.config, ['search_path=""'], `${row.sig}: proconfig`);
        assert.equal(row.definer, TRIGGER_FUNCTIONS.includes(row.sig), `${row.sig}: prosecdef`);
      }
    });

    test('anon and authenticated hold no EXECUTE, service_role does, and PUBLIC holds none on every function', async () => {
      for (const signature of EXPECTED_FUNCTIONS) {
        const qualified = `public.${signature.replace('(text,text,vector,', '(text,text,public.vector,')}`;
        const privileges = await db.query<{ role: string; allowed: boolean }>(
          `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS allowed
             FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
          [qualified],
        );
        assert.deepEqual(
          Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])),
          { anon: false, authenticated: false, service_role: true },
          signature,
        );
        const acl = await db.query<{ acl: string | null }>('SELECT proacl::text AS acl FROM pg_proc WHERE oid = $1::regprocedure', [qualified]);
        assert.ok(!/(^|[{,])=X/.test(acl.rows[0]?.acl ?? ''), `${signature}: no PUBLIC execute`);
      }
    });

    test('every RPC through the fake edge: the anon key is refused, the service key succeeds', async () => {
      const calls = rpcCalls(tenant);
      assert.equal(calls.length, RPC_SIGNATURES.length, 'one call per callable function');
      for (const call of calls) {
        const refused = await post(ANON_KEY, call.fn, call.body);
        assert.ok(refused.status === 403 || refused.status === 404, `${call.fn}: anon status ${refused.status}`);
        if (refused.status === 403) assert.equal(refused.body.code, '42501', `${call.fn}: anon code`);
        const served = await post(SERVICE_KEY, call.fn, call.body);
        assert.equal(served.status, 200, `${call.fn}: service status ${served.status} ${JSON.stringify(served.body)}`);
      }
    });

    test('every RPC as authenticated (with a user JWT) and as anon in SQL is refused with 42501', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        for (const call of rpcCalls(tenant)) {
          await assert.rejects(
            () => asRole(db, role, call.sql, call.params),
            (error: unknown) => codeOf(error) === '42501',
            `${role} ${call.fn}`,
          );
        }
      }
    });

    test('the four tables: select, insert, update and delete are refused for anon and authenticated; the service role succeeds', async () => {
      for (const table of TABLES) {
        for (const [verb, sql] of Object.entries(VERBS)) {
          for (const role of ['anon', 'authenticated'] as const) {
            await assert.rejects(
              () => asRole(db, role, sql(table)),
              (error: unknown) => codeOf(error) === '42501',
              `${role} ${verb} ${table}`,
            );
          }
          await asService(db, sql(table));
        }
      }
      const seq = await db.query<{ role: string; allowed: boolean }>(
        `SELECT r.role, has_sequence_privilege(r.role, 'public.rag_lexical_stats_pending_id_seq', 'USAGE') AS allowed
           FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
      );
      assert.deepEqual(Object.fromEntries(seq.rows.map((row) => [row.role, row.allowed])), { anon: false, authenticated: false, service_role: true });
    });

    test('the tables are not readable through the fake edge with the anon key', async () => {
      for (const table of TABLES) {
        const res = await fetch(`${edge.url}/rest/v1/${table}?select=tenant_key`, { headers: { apikey: ANON_KEY, authorization: `Bearer ${ANON_KEY}` } });
        assert.ok(res.status === 401 || res.status === 403 || res.status === 404, `${table}: anon read status ${res.status}`);
        await res.text();
      }
    });

    test('row level security is on for the four tables', async () => {
      const rows = await db.query<{ relname: string; rls: boolean }>(
        `SELECT c.relname, c.relrowsecurity AS rls FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
        [TABLES],
      );
      assert.equal(rows.rows.length, TABLES.length);
      for (const row of rows.rows) assert.equal(row.rls, true, `${row.relname}: rls`);
    });
  });
}
