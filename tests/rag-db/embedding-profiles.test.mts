import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { assertNoClientCallableRagFunctions } from '../helpers/rag-client-grants.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const LEGACY = 'openai-3-small-1536';
const HALFVEC_PROFILES = ['voyage-4-large-2048', 'voyage-4-large-1024', 'qwen3-8b-2048', 'qwen3-8b-1024'];
const SERVICE_TABLES = ['embedding_profiles', 'chunk_embeddings', 'embedding_backfill_runs', 'embedding_backfill_gaps'];
/** Scoped domain candidates seeded by 0440 (Phase 3.1.1); they never take part in the Phase 3 global registry behaviour. */
const SCOPED_PROFILES = ['voyage-4-large-1024-domain', 'voyage-finance-2-1024', 'voyage-law-2-1024'];
/** Unscoped open-source fallback seeded by 0811 (Phase 3.2.1, EMB-11, D-25). */
const BGE_M3 = 'bge-m3-1024';
const MIGRATION_0811 = path.join(REPO_ROOT, 'supabase/migrations/0811_bge_m3_profile.sql');
const FINETUNE_SLOTS = ['ft-a-1024', 'ft-b-1024'];

function halfvecLiteral(dims: number, value = 0.1): string {
  return `[${Array.from({ length: dims }, () => value).join(',')}]`;
}

function idFor(prefix: number, n: number): string {
  return `00000000-0000-4000-8000-${String(prefix * 1000 + n).padStart(12, '0')}`;
}

async function tryQuery(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function relationExists(db: PGlite, name: string): Promise<boolean> {
  const result = await db.query<{ found: boolean }>("SELECT to_regclass($1) IS NOT NULL AS found", [`public.${name}`]);
  return result.rows[0]?.found === true;
}

async function functionExists(db: PGlite, name: string): Promise<boolean> {
  const result = await db.query<{ found: boolean }>('SELECT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = $1::regnamespace AND proname = $2) AS found', [
    'public',
    name,
  ]);
  return result.rows[0]?.found === true;
}

async function requireSchema(db: PGlite): Promise<void> {
  for (const table of SERVICE_TABLES) assert.equal(await relationExists(db, table), true, `${table} table is missing`);
}

async function insertDocumentWithChunk(db: PGlite, mode: DeploymentMode, userId: string, documentId: string, chunkId: string): Promise<void> {
  if (mode === 'multi-tenant') {
    await db.query('INSERT INTO documents (id, filename, content, metadata, user_id) VALUES ($1, $2, $3, $4::jsonb, $5)', [
      documentId,
      `profiles-${documentId.slice(-4)}.md`,
      'profile storage fixture',
      '{}',
      userId,
    ]);
  } else {
    await db.query('INSERT INTO documents (id, filename, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [
      documentId,
      `profiles-${documentId.slice(-4)}.md`,
      'profile storage fixture',
      '{}',
    ]);
  }
  await db.query('INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, 0, $4::jsonb)', [
    chunkId,
    documentId,
    'profile storage chunk',
    '{}',
  ]);
}

async function insertEmbedding(db: PGlite, chunkId: string, profileId: string, dims: number, model = 'test-model'): Promise<void> {
  await db.query(
    `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
     SELECT c.id, $2, c.tenant_key, $3::halfvec, $4, $5 FROM document_chunks c WHERE c.id = $1`,
    [chunkId, profileId, halfvecLiteral(dims), model, dims],
  );
}

for (const mode of MODES) {
  describe(`embedding profiles and chunk_embeddings (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, supabaseGrants: true });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('the registry holds the legacy profile active with today thresholds and five more profiles available', async () => {
      const { db } = fixture;
      await requireSchema(db);
      const result = await db.query<{
        id: string;
        provider: string;
        model: string;
        dims: number;
        storage: string;
        status: string;
        score_calibration: Record<string, number>;
        query_instruction: string | null;
      }>('SELECT id, provider, model, dims, storage, status, score_calibration, query_instruction FROM embedding_profiles ORDER BY id');
      const byId = new Map(result.rows.map((row) => [row.id, row]));
      assert.deepEqual([...byId.keys()].sort(), [LEGACY, ...HALFVEC_PROFILES, ...SCOPED_PROFILES, BGE_M3, ...FINETUNE_SLOTS].sort());

      const legacy = byId.get(LEGACY);
      assert.equal(legacy?.provider, 'openai');
      assert.equal(legacy?.model, 'text-embedding-3-small');
      assert.equal(legacy?.dims, 1536);
      assert.equal(legacy?.storage, 'legacy_column');
      assert.equal(legacy?.status, 'active');
      const calibration = legacy?.score_calibration ?? {};
      assert.deepEqual(Object.values(calibration).sort(), [0.25, 0.28, 0.65, 0.7]);

      for (const id of HALFVEC_PROFILES) {
        const row = byId.get(id);
        assert.equal(row?.storage, 'halfvec', id);
        assert.equal(row?.status, 'available', id);
        assert.equal(row?.dims, Number(id.slice(-4)), id);
      }
      assert.equal(byId.get('voyage-4-large-2048')?.provider, 'voyage');
      assert.equal(byId.get('voyage-4-large-2048')?.model, 'voyage-4-large');
      assert.equal(byId.get('qwen3-8b-1024')?.provider, 'qwen3');
      assert.equal(byId.get('qwen3-8b-1024')?.model, 'Qwen/Qwen3-Embedding-8B');
      assert.match(byId.get('qwen3-8b-2048')?.query_instruction ?? '', /retrieve relevant passages/);
    });

    test('exactly one profile can be active and the registry rules hold in the table', async () => {
      const { db } = fixture;
      await requireSchema(db);
      const second = await tryQuery(db, "UPDATE embedding_profiles SET status = 'active' WHERE id = 'voyage-4-large-2048'");
      assert.match(second ?? '', /embedding_profiles_single_active|duplicate key/);
      assert.equal(
        (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM embedding_profiles WHERE status = 'active'")).rows[0]?.n,
        1,
      );

      const tooWide = await tryQuery(
        db,
        "INSERT INTO embedding_profiles (id, provider, model, dims, storage) VALUES ('too-wide', 'voyage', 'm', 4001, 'halfvec')",
      );
      assert.match(tooWide ?? 'accepted', /embedding_profiles_dims_check|violates check/);
      const wideLegacy = await tryQuery(
        db,
        "INSERT INTO embedding_profiles (id, provider, model, dims, storage) VALUES ('wide-legacy', 'voyage', 'm', 2048, 'legacy_column')",
      );
      assert.match(wideLegacy ?? 'accepted', /embedding_profiles_legacy_dims|violates check/);
      const badStatus = await tryQuery(db, "UPDATE embedding_profiles SET status = 'enabled' WHERE id = 'qwen3-8b-1024'");
      assert.match(badStatus ?? 'accepted', /violates check/);
    });

    test('every halfvec profile has its own partial expression HNSW index with m 64 and ef_construction 200', async () => {
      const { db } = fixture;
      await requireSchema(db);
      const result = await db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'chunk_embeddings' AND indexdef LIKE '%USING hnsw%'",
      );
      assert.ok(result.rows.length >= 4, `expected at least 4 HNSW indexes, found ${result.rows.length}`);
      for (const id of HALFVEC_PROFILES) {
        const dims = Number(id.slice(-4));
        const match = result.rows.find((row) => row.indexdef.includes(`'${id}'`));
        assert.ok(match, `no HNSW index for ${id}`);
        assert.match(match.indexdef, new RegExp(`halfvec\\(${dims}\\)`));
        assert.match(match.indexdef, /halfvec_cosine_ops/);
        assert.match(match.indexdef, /m='?64'?/);
        assert.match(match.indexdef, /ef_construction='?200'?/);
      }
    });

    test('a vector of the wrong length for a profile is rejected, the right length is stored', async () => {
      const { db } = fixture;
      await requireSchema(db);
      const documentId = idFor(1, 1);
      const chunkId = idFor(1, 2);
      await insertDocumentWithChunk(db, mode, fixture.fixtureUserId, documentId, chunkId);

      await insertEmbedding(db, chunkId, 'voyage-4-large-2048', 2048);
      const stored = await db.query<{ dims: number; vector_dims: number }>(
        "SELECT dims, vector_dims(embedding) FROM chunk_embeddings WHERE chunk_id = $1 AND profile_id = 'voyage-4-large-2048'",
        [chunkId],
      );
      assert.deepEqual(stored.rows, [{ dims: 2048, vector_dims: 2048 }]);

      const wrong = await tryQuery(
        db,
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         SELECT c.id, 'qwen3-8b-2048', c.tenant_key, $2::halfvec, 'm', 1024 FROM document_chunks c WHERE c.id = $1`,
        [chunkId, halfvecLiteral(1024)],
      );
      assert.match(wrong ?? 'accepted', /expected 2048 dimensions/);
    });

    test('a chunk holds one row per profile and deleting the chunk cascades all of them', async () => {
      const { db } = fixture;
      await requireSchema(db);
      const documentId = idFor(2, 1);
      const chunkId = idFor(2, 2);
      await insertDocumentWithChunk(db, mode, fixture.fixtureUserId, documentId, chunkId);
      await insertEmbedding(db, chunkId, 'voyage-4-large-1024', 1024);
      await insertEmbedding(db, chunkId, 'qwen3-8b-1024', 1024);
      const duplicate = await tryQuery(
        db,
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         SELECT c.id, 'qwen3-8b-1024', c.tenant_key, $2::halfvec, 'm', 1024 FROM document_chunks c WHERE c.id = $1`,
        [chunkId, halfvecLiteral(1024)],
      );
      assert.match(duplicate ?? 'accepted', /duplicate key/);
      const count = async (): Promise<number> =>
        (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM chunk_embeddings WHERE chunk_id = $1', [chunkId])).rows[0]?.n ?? -1;
      assert.equal(await count(), 2);
      await db.query('DELETE FROM document_chunks WHERE id = $1', [chunkId]);
      assert.equal(await count(), 0);
    });

    test('a stored row always carries its chunk tenant_key and its true vector length', async () => {
      const { db } = fixture;
      await requireSchema(db);
      const documentId = idFor(3, 1);
      const chunkId = idFor(3, 2);
      await insertDocumentWithChunk(db, mode, fixture.fixtureUserId, documentId, chunkId);
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         VALUES ($1, 'voyage-4-large-1024', 'o:00000000-0000-4000-8000-000000000999', $2::halfvec, 'm', 7)`,
        [chunkId, halfvecLiteral(1024)],
      );
      const row = await db.query<{ tenant_key: string; chunk_tenant: string; dims: number }>(
        `SELECT e.tenant_key, c.tenant_key AS chunk_tenant, e.dims FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id
         WHERE e.chunk_id = $1`,
        [chunkId],
      );
      assert.equal(row.rows[0]?.tenant_key, row.rows[0]?.chunk_tenant);
      assert.notEqual(row.rows[0]?.tenant_key, 'o:00000000-0000-4000-8000-000000000999');
      assert.equal(row.rows[0]?.dims, 1024);
    });

    test('the new tables are closed to anon and authenticated, open to service_role, with RLS on', async () => {
      const { db } = fixture;
      await requireSchema(db);
      for (const table of SERVICE_TABLES) {
        const privileges = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; rls: boolean }>(
          `SELECT has_table_privilege('anon', $1, 'SELECT') OR has_table_privilege('anon', $1, 'INSERT')
                    OR has_table_privilege('anon', $1, 'UPDATE') OR has_table_privilege('anon', $1, 'DELETE') AS anon,
                  has_table_privilege('authenticated', $1, 'SELECT') OR has_table_privilege('authenticated', $1, 'INSERT')
                    OR has_table_privilege('authenticated', $1, 'UPDATE') OR has_table_privilege('authenticated', $1, 'DELETE') AS authenticated,
                  has_table_privilege('service_role', $1, 'SELECT,INSERT,UPDATE,DELETE') AS service,
                  (SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass) AS rls`,
          [`public.${table}`],
        );
        assert.deepEqual(privileges.rows[0], { anon: false, authenticated: false, service: true, rls: true }, table);
      }
      const policies = await db.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)", [SERVICE_TABLES]);
      assert.equal(policies.rows.length, 0);
    });

    test('backfill runs and gaps have the columns the re-embed job and the gate read', async () => {
      const { db } = fixture;
      await requireSchema(db);
      const columns = async (table: string): Promise<string[]> =>
        (
          await db.query<{ column_name: string }>(
            "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
            [table],
          )
        ).rows.map((row) => row.column_name);
      const runs = new Set(await columns('embedding_backfill_runs'));
      for (const name of [
        'id',
        'profile_id',
        'tenant_key',
        'cursor_chunk_id',
        'chunks_total',
        'chunks_done',
        'tokens',
        'status',
        'started_at',
        'updated_at',
        'derived_from',
      ]) {
        assert.ok(runs.has(name), `embedding_backfill_runs.${name} is missing`);
      }
      const gaps = new Set(await columns('embedding_backfill_gaps'));
      for (const name of ['run_id', 'chunk_id', 'profile_id', 'reason', 'recorded_at']) {
        assert.ok(gaps.has(name), `embedding_backfill_gaps.${name} is missing`);
      }

      const runId = (
        await db.query<{ id: string }>("INSERT INTO embedding_backfill_runs (profile_id) VALUES ('qwen3-8b-1024') RETURNING id")
      ).rows[0]?.id;
      assert.ok(runId);
      const documentId = idFor(4, 1);
      const chunkId = idFor(4, 2);
      await insertDocumentWithChunk(db, mode, fixture.fixtureUserId, documentId, chunkId);
      assert.equal(
        await tryQuery(db, "INSERT INTO embedding_backfill_gaps (run_id, chunk_id, profile_id, reason) VALUES ($1, $2, 'qwen3-8b-1024', 'provider_failed')", [
          runId,
          chunkId,
        ]),
        null,
      );
      const badRun = await tryQuery(db, "INSERT INTO embedding_backfill_runs (profile_id, status) VALUES ('qwen3-8b-1024', 'paused-forever')");
      assert.match(badRun ?? 'accepted', /violates check/);
    });

    test('rag_list_embedding_profiles hides evidence bodies and rag_set_embedding_profile_status never activates', async () => {
      const { db } = fixture;
      await requireSchema(db);
      assert.equal(await functionExists(db, 'rag_list_embedding_profiles'), true, 'rag_list_embedding_profiles is missing');
      assert.equal(await functionExists(db, 'rag_set_embedding_profile_status'), true, 'rag_set_embedding_profile_status is missing');

      await db.query("UPDATE embedding_profiles SET eval_evidence = '{\"gate_passed\": true}'::jsonb WHERE id = 'voyage-4-large-1024'");
      const list = await db.query<Record<string, unknown>>('SELECT * FROM rag_list_embedding_profiles()');
      assert.equal(list.rows.length, 5 + SCOPED_PROFILES.length + 1 + FINETUNE_SLOTS.length);
      assert.ok(!('eval_evidence' in (list.rows[0] ?? {})), 'the list must not return evidence bodies');
      const withEvidence = list.rows.filter((row) => row.has_evidence === true).map((row) => row.id);
      assert.deepEqual(withEvidence, ['voyage-4-large-1024']);
      await db.query("UPDATE embedding_profiles SET eval_evidence = NULL WHERE id = 'voyage-4-large-1024'");

      const set = async (id: string, status: string): Promise<string | null> =>
        tryQuery(db, 'SELECT * FROM rag_set_embedding_profile_status($1, $2, $3)', [id, status, 'operator-test']);
      assert.equal(await set('qwen3-8b-2048', 'backfilling'), null);
      assert.equal((await db.query<{ status: string }>("SELECT status FROM embedding_profiles WHERE id = 'qwen3-8b-2048'")).rows[0]?.status, 'backfilling');
      assert.equal(await set('qwen3-8b-2048', 'retired'), null);
      assert.equal(await set('qwen3-8b-2048', 'available'), null);

      assert.match((await set('qwen3-8b-2048', 'active')) ?? 'accepted', /profile_status_refused: use_activation_gate/);
      assert.match((await set(LEGACY, 'retired')) ?? 'accepted', /profile_status_refused: profile_is_active/);
      assert.match((await set('no-such-profile', 'available')) ?? 'accepted', /profile_status_refused: unknown_profile/);
      assert.match((await set('qwen3-8b-2048', 'enabled')) ?? 'accepted', /profile_status_refused: invalid_status/);
      assert.match(
        (await tryQuery(db, "SELECT * FROM rag_set_embedding_profile_status('qwen3-8b-2048', 'available', '  ')")) ?? 'accepted',
        /profile_status_refused: actor_required/,
      );
      assert.equal((await db.query<{ id: string }>("SELECT id FROM embedding_profiles WHERE status = 'active'")).rows[0]?.id, LEGACY);
    });

    test('no rag_ function and no match_chunks_by_profile is executable by anon or authenticated', async () => {
      const { db } = fixture;
      await requireSchema(db);
      const defined = await db.query<{ proname: string }>(
        "SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('rag_list_embedding_profiles', 'rag_set_embedding_profile_status', 'rag_chunk_embeddings_guard')",
      );
      assert.equal(defined.rows.length, 3, 'expected the three Phase 3 profile functions');
      await assertNoClientCallableRagFunctions(db);
      const service = await db.query<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('rag_list_embedding_profiles', 'rag_set_embedding_profile_status') AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')`,
      );
      assert.deepEqual(service.rows, []);
    });
  });
}

async function hnswIndexFor(db: PGlite, table: string, profileId: string): Promise<string | undefined> {
  const result = await db.query<{ indexdef: string }>(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1 AND indexdef LIKE '%USING hnsw%'",
    [table],
  );
  return result.rows.find((row) => row.indexdef.includes(`'${profileId}'`))?.indexdef;
}

for (const mode of MODES) {
  describe(`0811 BGE-M3 profile (${mode})`, () => {
    let fixture: FixtureDatabase;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS, supabaseGrants: true });
    });

    after(async () => {
      await fixture.db.close();
    });

    test('seeds bge-m3-1024 available, unscoped, halfvec 1024, with no query instruction and no evidence', async () => {
      const { db } = fixture;
      const result = await db.query<Record<string, unknown>>(
        `SELECT provider, model, dims, storage, status, doc_types, query_instruction, score_calibration, eval_evidence,
                activated_at, activated_by, previous_active_id
           FROM public.embedding_profiles WHERE id = $1`,
        [BGE_M3],
      );
      assert.deepEqual(result.rows, [
        {
          provider: 'bge-m3',
          model: 'BAAI/bge-m3',
          dims: 1024,
          storage: 'halfvec',
          status: 'available',
          doc_types: null,
          query_instruction: null,
          score_calibration: {},
          eval_evidence: null,
          activated_at: null,
          activated_by: null,
          previous_active_id: null,
        },
      ]);
    });

    test('activates nothing: the legacy profile stays the one active profile', async () => {
      const { db } = fixture;
      const active = await db.query<{ id: string }>("SELECT id FROM public.embedding_profiles WHERE status = 'active'");
      assert.deepEqual(active.rows, [{ id: LEGACY }]);
    });

    test('has a partial HNSW index over halfvec(1024) with m 64 and ef_construction 200 on both vector tables', async () => {
      const { db } = fixture;
      for (const table of ['chunk_embeddings', 'chunk_translation_embeddings']) {
        const indexdef = await hnswIndexFor(db, table, BGE_M3);
        assert.ok(indexdef, `no HNSW index for ${BGE_M3} on ${table}`);
        assert.match(indexdef, /halfvec\(1024\)/);
        assert.match(indexdef, /halfvec_cosine_ops/);
        assert.match(indexdef, /m='?64'?/);
        assert.match(indexdef, /ef_construction='?200'?/);
        assert.match(indexdef, /WHERE \(+profile_id = 'bge-m3-1024'::text\)+/);
      }
    });

    test('the unchanged activation gate refuses it without completeness, then without evidence', async () => {
      const { db } = fixture;
      const attempt = async (): Promise<string> => {
        await db.exec('SAVEPOINT bge_activate');
        try {
          await db.query('SELECT * FROM rag_activate_embedding_profile($1, $2)', [BGE_M3, 'operator-test']);
          await db.exec('RELEASE SAVEPOINT bge_activate');
          return 'accepted';
        } catch (error) {
          await db.exec('ROLLBACK TO SAVEPOINT bge_activate');
          return error instanceof Error ? error.message : String(error);
        }
      };
      await db.exec('BEGIN');
      try {
        assert.match(await attempt(), /activation_refused: incomplete/);
        await db.query(
          `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
           SELECT c.id, $1, c.tenant_key, array_fill(0.1::float4, ARRAY[1024])::halfvec, 'BAAI/bge-m3', 1024
           FROM document_chunks c WHERE c.is_current AND c.status = 'ready'`,
          [BGE_M3],
        );
        assert.match(await attempt(), /activation_refused: eval_missing/);
        const status = await db.query<{ id: string; status: string }>(
          "SELECT id, status FROM public.embedding_profiles WHERE id = $1 OR status = 'active' ORDER BY id",
          [BGE_M3],
        );
        assert.deepEqual(status.rows, [
          { id: BGE_M3, status: 'available' },
          { id: LEGACY, status: 'active' },
        ]);
      } finally {
        await db.exec('ROLLBACK');
      }
    });

    test('stores 1024-dimension vectors, refuses another length, and holds rows from two embedding hosts', async () => {
      const { db } = fixture;
      const documentId = idFor(811, 1);
      const chunks = [idFor(811, 2), idFor(811, 3), idFor(811, 4)];
      await insertDocumentWithChunk(db, mode, fixture.fixtureUserId, documentId, chunks[0]);
      for (const [offset, chunkId] of chunks.slice(1).entries()) {
        await db.query('INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)', [
          chunkId,
          documentId,
          `further profile storage chunk ${offset}`,
          offset + 1,
          '{}',
        ]);
      }
      for (const [index, host] of ['deepinfra', 'sidecar'].entries()) {
        await db.query(
          `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedding_host)
           SELECT c.id, $2, c.tenant_key, $3::halfvec, 'BAAI/bge-m3', 1024, $4 FROM document_chunks c WHERE c.id = $1`,
          [chunks[index], BGE_M3, halfvecLiteral(1024), host],
        );
      }
      const stored = await db.query<{ hosts: string[] }>(
        'SELECT array_agg(DISTINCT embedding_host ORDER BY embedding_host) AS hosts FROM chunk_embeddings WHERE profile_id = $1',
        [BGE_M3],
      );
      assert.deepEqual(stored.rows[0]?.hosts, ['deepinfra', 'sidecar']);
      const wrong = await tryQuery(
        db,
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         SELECT c.id, $2, c.tenant_key, $3::halfvec, 'BAAI/bge-m3', 768 FROM document_chunks c WHERE c.id = $1`,
        [chunks[2], BGE_M3, halfvecLiteral(768)],
      );
      assert.match(wrong ?? 'accepted', /expected 1024 dimensions/);
    });

    test('applying 0811 a second time changes nothing', async () => {
      const { db } = fixture;
      const snapshot = async () => ({
        profiles: (await db.query('SELECT * FROM public.embedding_profiles ORDER BY id')).rows,
        indexes: (
          await db.query(
            "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE '%bge-m3-1024%' ORDER BY indexname",
          )
        ).rows,
      });
      const before = await snapshot();
      await db.exec(fs.readFileSync(MIGRATION_0811, 'utf8'));
      assert.deepEqual(await snapshot(), before);
      assert.equal(before.indexes.length, 2);
    });
  });
}
