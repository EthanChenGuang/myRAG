import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { compactFixtureCorpus, removeCompactCorpus } from '../helpers/compact-corpus.mts';

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-1024';
const OTHER_TENANT = 'u:00000000-0000-4000-8000-0000000000f2';

async function inTransaction(db: PGlite, body: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await body();
  } finally {
    await db.exec('ROLLBACK');
    // Rolled-back vectors stay in the HNSW indexes as dead entries until a vacuum; without it every later insert walks them.
    await db.exec('VACUUM chunk_embeddings');
  }
}

async function outcome(db: PGlite, sql: string, params: unknown[] = []): Promise<string> {
  await db.exec('SAVEPOINT attempt');
  try {
    await db.query(sql, params);
    await db.exec('RELEASE SAVEPOINT attempt');
    return 'accepted';
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT attempt');
    return error instanceof Error ? error.message : String(error);
  }
}

const activate = (db: PGlite, target: string): Promise<string> => outcome(db, 'SELECT * FROM rag_activate_embedding_profile($1, $2)', [target, 'operator-test']);
const rollback = (db: PGlite): Promise<string> => outcome(db, 'SELECT * FROM rag_rollback_embedding_profile($1)', ['operator-test']);

async function activeProfile(db: PGlite): Promise<string | undefined> {
  return (await db.query<{ id: string }>("SELECT id FROM embedding_profiles WHERE status = 'active'")).rows[0]?.id;
}

/** A Voyage profile that passes every Phase 3 condition: a vector for each current ready chunk and fresh passing evidence. */
async function readyVoyage(db: PGlite): Promise<void> {
  await db.query(
    `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
     SELECT c.id, $1, c.tenant_key, array_fill(0.1::float4, ARRAY[1024])::halfvec, 'voyage-4-large', 1024, now() - interval '2 hours'
     FROM document_chunks c WHERE c.is_current AND c.status = 'ready'`,
    [VOYAGE],
  );
  const run = await db.query<{ id: string }>("INSERT INTO embedding_backfill_runs (profile_id, status) VALUES ($1, 'completed') RETURNING id", [VOYAGE]);
  const evidence = {
    target_profile: VOYAGE,
    baseline_profile: LEGACY,
    gate_passed: true,
    pre_migration: { passed: true, n: 12 },
    backfill_run_id: run.rows[0]?.id,
    recorded_at: new Date(Date.now() - 3600_000).toISOString(),
  };
  await db.query('UPDATE embedding_profiles SET eval_evidence = $2::jsonb WHERE id = $1', [VOYAGE, JSON.stringify(evidence)]);
}

async function enable(db: PGlite, target: 'qdrant' | 'weaviate', enabled = true): Promise<void> {
  await db.query('UPDATE rag_vector_sync_targets SET enabled = $2 WHERE target = $1', [target, enabled]);
}

async function setState(db: PGlite, target: 'qdrant' | 'weaviate', profileId: string, tenantKey: string, state: string): Promise<void> {
  await db.query(
    `INSERT INTO rag_backend_index_state (target, profile_id, tenant_key, state) VALUES ($1, $2, $3, $4)
     ON CONFLICT (target, profile_id, tenant_key) DO UPDATE SET state = EXCLUDED.state`,
    [target, profileId, tenantKey, state],
  );
}

async function tenants(db: PGlite): Promise<string[]> {
  const result = await db.query<{ tenant_key: string }>(
    "SELECT DISTINCT tenant_key FROM document_chunks WHERE is_current AND status = 'ready' AND tenant_key IS NOT NULL ORDER BY tenant_key",
  );
  return result.rows.map((row) => row.tenant_key);
}

/** Moves the chunks of one document to a second tenant (the chunk column only; documents.tenant_key is generated), so the corpus has two tenants with current ready documents. */
async function splitTenants(db: PGlite): Promise<void> {
  const doc = await db.query<{ document_id: string }>(
    "SELECT document_id FROM document_chunks WHERE is_current AND status = 'ready' ORDER BY document_id LIMIT 1",
  );
  const documentId = doc.rows[0]?.document_id;
  assert.ok(documentId);
  await db.query('UPDATE document_chunks SET tenant_key = $2 WHERE document_id = $1', [documentId, OTHER_TENANT]);
  assert.equal((await tenants(db)).length, 2);
}

for (const mode of MODES) {
  describe(`activation gate with external backends (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    let corpusDir: string | undefined;

    before(async () => {
      corpusDir = compactFixtureCorpus();
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir });
      db = fixture.db;
    });

    after(async () => {
      await db.close();
      removeCompactCorpus(corpusDir);
    });

    test('with no target enabled a profile that passes the Phase 3 gate activates as before', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        assert.equal(await activate(db, VOYAGE), 'accepted');
        assert.equal(await activeProfile(db), VOYAGE);
      });
    });

    test('an enabled target with no index state is not ready: activation names it and changes nothing', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'qdrant');
        assert.match(await activate(db, VOYAGE), /^external_not_ready:qdrant/);
        assert.equal(await activeProfile(db), LEGACY);
        const voyage = await db.query<{ status: string }>('SELECT status FROM embedding_profiles WHERE id = $1', [VOYAGE]);
        assert.notEqual(voyage.rows[0]?.status, 'active');
      });
    });

    test('a state that is building, stale or failed, or ready for another profile, is not ready', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'qdrant');
        const [tenant] = await tenants(db);
        assert.ok(tenant);
        for (const state of ['building', 'stale', 'failed']) {
          await setState(db, 'qdrant', VOYAGE, tenant, state);
          assert.match(await activate(db, VOYAGE), /^external_not_ready:qdrant/, state);
        }
        await db.query('DELETE FROM rag_backend_index_state');
        await setState(db, 'qdrant', LEGACY, tenant, 'ready');
        await setState(db, 'weaviate', VOYAGE, tenant, 'ready');
        assert.match(await activate(db, VOYAGE), /^external_not_ready:qdrant/);
        assert.equal(await activeProfile(db), LEGACY);
      });
    });

    if (mode === 'multi-tenant') {
      test('qdrant ready for one of two tenants only is not ready, whichever tenant is the ready one', async () => {
        await inTransaction(db, async () => {
          await splitTenants(db);
          await readyVoyage(db);
          await enable(db, 'qdrant');
          const [first, second] = await tenants(db);
          assert.ok(first && second);

          await setState(db, 'qdrant', VOYAGE, first, 'ready');
          assert.match(await activate(db, VOYAGE), /^external_not_ready:qdrant/);
          assert.equal(await activeProfile(db), LEGACY);

          await db.query('DELETE FROM rag_backend_index_state');
          await setState(db, 'qdrant', VOYAGE, second, 'ready');
          assert.match(await activate(db, VOYAGE), /^external_not_ready:qdrant/);
          assert.equal(await activeProfile(db), LEGACY);

          await setState(db, 'qdrant', VOYAGE, first, 'ready');
          assert.equal(await activate(db, VOYAGE), 'accepted');
        });
      });

      test('a tenant whose only chunks are quarantined or superseded needs no index state', async () => {
        await inTransaction(db, async () => {
          await splitTenants(db);
          const [first, second] = await tenants(db);
          assert.ok(first && second);
          await db.query("UPDATE document_chunks SET status = 'quarantined' WHERE tenant_key = $1", [second]);
          await readyVoyage(db);
          await enable(db, 'qdrant');
          await setState(db, 'qdrant', VOYAGE, first, 'ready');
          assert.equal(await activate(db, VOYAGE), 'accepted');
        });
      });
    }

    test('qdrant ready on every tenant but weaviate enabled without state is not ready on weaviate', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'qdrant');
        await enable(db, 'weaviate');
        for (const tenant of await tenants(db)) await setState(db, 'qdrant', VOYAGE, tenant, 'ready');
        assert.match(await activate(db, VOYAGE), /^external_not_ready:weaviate/);
        assert.equal(await activeProfile(db), LEGACY);
      });
    });

    test('qdrant is named first when both enabled targets are not ready', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'weaviate');
        await enable(db, 'qdrant');
        assert.match(await activate(db, VOYAGE), /^external_not_ready:qdrant/);
      });
    });

    test('a disabled target is not checked even when its state is missing', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'weaviate');
        await enable(db, 'qdrant', false);
        for (const tenant of await tenants(db)) await setState(db, 'weaviate', VOYAGE, tenant, 'ready');
        assert.equal(await activate(db, VOYAGE), 'accepted');
      });
    });

    test('every enabled target ready on every tenant: activation succeeds', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'qdrant');
        await enable(db, 'weaviate');
        for (const tenant of await tenants(db)) {
          await setState(db, 'qdrant', VOYAGE, tenant, 'ready');
          await setState(db, 'weaviate', VOYAGE, tenant, 'ready');
        }
        assert.equal(await activate(db, VOYAGE), 'accepted');
        assert.equal(await activeProfile(db), VOYAGE);
      });
    });

    test('rollback is never gated by external readiness', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        assert.equal(await activate(db, VOYAGE), 'accepted');
        await enable(db, 'qdrant');
        await enable(db, 'weaviate');
        assert.equal(await rollback(db), 'accepted');
        assert.equal(await activeProfile(db), LEGACY);
      });
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'qdrant');
        for (const tenant of await tenants(db)) await setState(db, 'qdrant', VOYAGE, tenant, 'ready');
        assert.equal(await activate(db, VOYAGE), 'accepted');
        for (const tenant of await tenants(db)) await setState(db, 'qdrant', VOYAGE, tenant, 'stale');
        assert.equal(await rollback(db), 'accepted');
        assert.equal(await activeProfile(db), LEGACY);
      });
    });

    test('the Phase 3 refusals still win while an enabled target is not ready', async () => {
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'qdrant');
        const chunk = await db.query<{ id: string }>("SELECT id FROM document_chunks WHERE is_current AND status = 'ready' ORDER BY id LIMIT 1");
        await db.query('DELETE FROM chunk_embeddings WHERE chunk_id = $1 AND profile_id = $2', [chunk.rows[0]?.id, VOYAGE]);
        assert.match(await activate(db, VOYAGE), /^activation_refused: incomplete/);
      });
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await enable(db, 'qdrant');
        await db.query("UPDATE embedding_profiles SET eval_evidence = eval_evidence || '{\"gate_passed\": false}'::jsonb WHERE id = $1", [VOYAGE]);
        assert.match(await activate(db, VOYAGE), /^activation_refused: eval_failed/);
        assert.match(await activate(db, 'no-such-profile'), /^activation_refused: unknown_profile/);
        assert.match(await activate(db, LEGACY), /^activation_refused: already_active/);
      });
    });

    test('anon and authenticated get 42501; service_role keeps EXECUTE', async () => {
      for (const role of ['anon', 'authenticated']) {
        await inTransaction(db, async () => {
          await db.exec(`SET LOCAL ROLE ${role}`);
          await db.exec('SAVEPOINT attempt');
          let code: string | undefined;
          try {
            await db.query('SELECT * FROM rag_activate_embedding_profile($1, $2)', [VOYAGE, 'operator-test']);
          } catch (error) {
            code = (error as { code?: string }).code;
          }
          assert.equal(code, '42501', role);
        });
      }
      const grants = await db.query<{ service: boolean; secdef: boolean; config: string[] | null }>(
        `SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') AS service, p.prosecdef AS secdef, p.proconfig AS config
         FROM pg_proc p WHERE p.oid = 'public.rag_activate_embedding_profile(text,text)'::regprocedure`,
      );
      assert.equal(grants.rows[0]?.service, true);
      assert.equal(grants.rows[0]?.secdef, true);
      assert.ok(grants.rows[0]?.config?.some((entry) => /^search_path=("")?$/.test(entry)), String(grants.rows[0]?.config));
    });
  });
}
