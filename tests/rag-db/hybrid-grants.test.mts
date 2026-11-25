import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_USER_ID, createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');

const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';
const LEGACY = 'openai-3-small-1536';
const SIGNATURE =
  'public.hybrid_search_chunks(text, text, public.vector, text[], integer, integer, date, date, text[], uuid[], text[], text[], text, integer, text[], text, numeric, numeric, text, jsonb, boolean)';
const CALL =
  'SELECT 1 FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[], p_dense_limit => 1, p_lexical_limit => 1, p_date_from => $5::date, p_date_to => $6::date, p_include_undated => true)';

function vec(): string {
  return `[${embedText('refund').join(',')}]`;
}

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  describe(`hybrid_search_chunks fake edge grants (${mode})`, () => {
    let edge: FakeEdge;
    let db: Awaited<ReturnType<typeof createFixtureDatabase>>['db'];

    before(async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      db = fixture.db;
      edge = await startFakeEdge({ db: fixture.db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';

    const rpc = async (apikey: string, extra: Record<string, unknown> = {}) => {
      const res = await fetch(`${edge.url}/rest/v1/rpc/hybrid_search_chunks`, {
        method: 'POST',
        headers: { apikey, 'content-type': 'application/json' },
        body: JSON.stringify({
          p_tenant_key: tenant,
          p_profile_id: LEGACY,
          p_query_embedding: vec(),
          p_lexical_tokens: ['refund'],
          p_dense_limit: 1,
          p_lexical_limit: 1,
          ...extra,
        }),
      });
      const body = (await res.json()) as { code?: string; message?: string };
      return { status: res.status, body };
    };

    test('anon apikey is refused with SQLSTATE 42501', async () => {
      const res = await rpc(ANON_KEY);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, '42501');
      assert.match(String(res.body.message ?? ''), /hybrid_search_chunks/);
    });

    test('service apikey returns rows', async () => {
      const res = await rpc(SERVICE_KEY);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    const undated = { p_date_from: '2024-01-01', p_date_to: '2024-12-31', p_include_undated: true };

    test('with p_include_undated the anon apikey is refused with SQLSTATE 42501', async () => {
      const res = await rpc(ANON_KEY, undated);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, '42501');
    });

    test('with p_include_undated the service apikey returns rows', async () => {
      const res = await rpc(SERVICE_KEY, undated);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    test('the 0602 signature is the only overload; only service_role may execute it', async () => {
      const overloads = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'hybrid_search_chunks'");
      assert.equal(overloads.rows[0]?.n, 1);
      const privileges = await db.query<{ role: string; allowed: boolean }>(
        `SELECT r.role, has_function_privilege(r.role, $1, 'EXECUTE') AS allowed
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)`,
        [SIGNATURE],
      );
      assert.deepEqual(
        Object.fromEntries(privileges.rows.map((row) => [row.role, row.allowed])),
        { anon: false, authenticated: false, service_role: true },
      );
      const acl = await db.query<{ acl: string | null }>('SELECT proacl::text AS acl FROM pg_proc WHERE oid = $1::regprocedure', [SIGNATURE]);
      assert.ok(!/(^|[{,])=X/.test(acl.rows[0]?.acl ?? ''), 'no PUBLIC execute');
    });

    test('SET ROLE anon and authenticated get 42501 on the 0602 signature; service_role succeeds', async () => {
      const params = [tenant, LEGACY, vec(), ['refund'], '2024-01-01', '2024-12-31'];
      for (const role of ['anon', 'authenticated'] as const) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await assert.rejects(
            () => db.query(CALL, params),
            (error: unknown) => (error as { code?: string }).code === '42501',
          );
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      await db.exec('SET ROLE service_role');
      try {
        await db.query(CALL, params);
      } finally {
        await db.exec('RESET ROLE');
      }
    });
  });
}