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

    const rpc = async (apikey: string) => {
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
  });
}