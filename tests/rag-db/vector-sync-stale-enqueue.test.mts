import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

function tenantFor(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;
}

function otherModeKey(mode: DeploymentMode): string {
  return mode === 'single-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
}

async function stale(db: PGlite, target: string, tenantKey: string, ids: string[]): Promise<number> {
  const r = await db.query<{ n: number }>('SELECT public.rag_vector_sync_enqueue_stale($1, $2, $3::uuid[]) AS n', [target, tenantKey, ids]);
  return r.rows[0]!.n;
}

async function expectCode(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const e = error as { code?: string; message?: string };
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (message) assert.match(e.message ?? '', message);
    return true;
  });
}

async function outbox(db: PGlite): Promise<Array<{ target: string; entity: string; entity_id: string; tenant_key: string; profile_id: string | null }>> {
  return (await db.query<{ target: string; entity: string; entity_id: string; tenant_key: string; profile_id: string | null }>(
    'SELECT target, entity, entity_id, tenant_key, profile_id FROM public.vector_sync_outbox ORDER BY target, entity_id',
  )).rows;
}

for (const mode of MODES) {
  describe(`vector sync stale-repair enqueue 0740 (${mode})`, () => {
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
        "UPDATE public.rag_vector_sync_targets SET enabled = true; DELETE FROM public.vector_sync_outbox; DELETE FROM public.rag_backend_index_state;",
      );
    });

    test('writes one chunk row per id for the named target only, with the tenant key and no profile', async () => {
      const ids = [crypto.randomUUID(), crypto.randomUUID()].sort();
      assert.equal(await stale(db, 'qdrant', tenant, ids), 2);
      assert.deepEqual(
        await outbox(db),
        ids.map((id) => ({ target: 'qdrant', entity: 'chunk', entity_id: id, tenant_key: tenant, profile_id: null })),
      );
    });

    test('a repeated call writes nothing while the first rows are still untried', async () => {
      const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
      assert.equal(await stale(db, 'qdrant', tenant, ids), 3);
      assert.equal(await stale(db, 'qdrant', tenant, [...ids, ids[0]!]), 0);
      assert.equal((await outbox(db)).length, 3);
      await db.query('SELECT * FROM public.rag_vector_sync_claim(1, 60)');
      assert.equal(await stale(db, 'qdrant', tenant, ids), 1, 'only the id whose row a worker took is enqueued again');
    });

    test('never marks backend index state stale', async () => {
      await db.query("INSERT INTO public.rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ('qdrant', 'openai-3-small-1536', $1, 'ready')", [tenant]);
      await stale(db, 'qdrant', tenant, [crypto.randomUUID()]);
      const state = (await db.query<{ state: string }>('SELECT state FROM public.rag_backend_index_state')).rows[0]!.state;
      assert.equal(state, 'ready');
    });

    test('a disabled target writes nothing and returns 0', async () => {
      await db.query("UPDATE public.rag_vector_sync_targets SET enabled = false WHERE target = 'qdrant'");
      assert.equal(await stale(db, 'qdrant', tenant, [crypto.randomUUID()]), 0);
      assert.deepEqual(await outbox(db), []);
    });

    test('201 ids, an empty or NULL array and an unknown target raise 22023 and write nothing', async () => {
      await expectCode(stale(db, 'qdrant', tenant, Array.from({ length: 201 }, () => crypto.randomUUID())), '22023');
      await expectCode(stale(db, 'qdrant', tenant, []), '22023');
      await expectCode(db.query("SELECT public.rag_vector_sync_enqueue_stale('qdrant', $1, NULL::uuid[])", [tenant]), '22023');
      await expectCode(stale(db, 'pinecone', tenant, [crypto.randomUUID()]), '22023');
      await expectCode(db.query('SELECT public.rag_vector_sync_enqueue_stale(NULL, $1, ARRAY[gen_random_uuid()])', [tenant]), '22023');
      assert.equal(await stale(db, 'qdrant', tenant, Array.from({ length: 200 }, () => crypto.randomUUID())), 200);
    });

    test('a malformed or other-mode tenant key raises the tenant guard', async () => {
      await expectCode(stale(db, 'qdrant', otherModeKey(mode), [crypto.randomUUID()]), '22023', /not valid for this deployment mode/);
      await expectCode(stale(db, 'qdrant', tenant.toUpperCase(), [crypto.randomUUID()]), '22023', /malformed tenant key/);
      assert.deepEqual(await outbox(db), []);
    });

    test('anon and authenticated are refused', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          await expectCode(stale(db, 'qdrant', tenant, [crypto.randomUUID()]), '42501');
        } finally {
          await db.exec('RESET ROLE');
        }
      }
    });
  });
}

describe('vector sync stale-repair enqueue 0740 across tenants (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    await db.exec('UPDATE public.rag_vector_sync_targets SET enabled = true; DELETE FROM public.vector_sync_outbox;');
  });

  after(async () => {
    await db.close();
  });

  test('a chunk id that exists under another tenant is refused and nothing is written', async () => {
    const chunkB = (await db.query<{ id: string }>('SELECT id FROM public.document_chunks WHERE document_id = $1 LIMIT 1', [TWO_TENANT_IDS.docB])).rows[0]!.id;
    const chunkA = (await db.query<{ id: string }>('SELECT id FROM public.document_chunks WHERE document_id = $1 LIMIT 1', [TWO_TENANT_IDS.docA])).rows[0]!.id;
    await expectCode(stale(db, 'qdrant', `u:${TWO_TENANT_IDS.userA}`, [chunkA, chunkB]), '22023', /vector_sync_refused: tenant_mismatch/);
    assert.deepEqual(await outbox(db), []);
    assert.equal(await stale(db, 'qdrant', `u:${TWO_TENANT_IDS.userA}`, [chunkA]), 1);
  });
});
