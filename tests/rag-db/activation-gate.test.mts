import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-1024';
const QWEN = 'qwen3-8b-1024';
const QWEN_MODEL = 'Qwen/Qwen3-Embedding-8B';
const ACTIVATE_SIGNATURE = 'rag_activate_embedding_profile(text,text)';
const ROLLBACK_SIGNATURE = 'rag_rollback_embedding_profile(text)';

interface Evidence {
  target_profile?: string;
  baseline_profile?: string;
  gate_passed?: boolean;
  pre_migration?: { passed: boolean; n: number } | null;
  backfill_run_id?: string | null;
  recorded_at?: string;
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

async function requireGate(db: PGlite): Promise<void> {
  const found = await db.query<{ activate: boolean; rollback: boolean }>(
    'SELECT to_regprocedure($1) IS NOT NULL AS activate, to_regprocedure($2) IS NOT NULL AS rollback',
    [ACTIVATE_SIGNATURE, ROLLBACK_SIGNATURE],
  );
  assert.equal(found.rows[0]?.activate, true, 'rag_activate_embedding_profile is missing');
  assert.equal(found.rows[0]?.rollback, true, 'rag_rollback_embedding_profile is missing');
}

async function inTransaction(db: PGlite, body: () => Promise<void>): Promise<void> {
  await db.exec('BEGIN');
  try {
    await body();
  } finally {
    await db.exec('ROLLBACK');
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

async function fillProfile(db: PGlite, profileId: string, dims: number, model: string, options: { hoursAgo?: number } = {}): Promise<void> {
  await db.query(
    `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
     SELECT c.id, $1, c.tenant_key, array_fill(0.1::float4, ARRAY[$2::int])::halfvec, $3, $2::int, now() - make_interval(hours => $4::int)
     FROM document_chunks c WHERE c.is_current AND c.status = 'ready'`,
    [profileId, dims, model, options.hoursAgo ?? 2],
  );
}

async function recordRun(db: PGlite, profileId: string): Promise<string> {
  const result = await db.query<{ id: string }>("INSERT INTO embedding_backfill_runs (profile_id, status) VALUES ($1, 'completed') RETURNING id", [profileId]);
  const id = result.rows[0]?.id;
  assert.ok(id);
  return id;
}

async function writeEvidence(db: PGlite, profileId: string, evidence: Evidence): Promise<void> {
  await db.query('UPDATE embedding_profiles SET eval_evidence = $2::jsonb WHERE id = $1', [profileId, JSON.stringify(evidence)]);
}

async function goodEvidence(db: PGlite, target: string, baseline: string, overrides: Evidence = {}): Promise<Evidence> {
  const runId = await recordRun(db, target);
  const evidence: Evidence = {
    target_profile: target,
    baseline_profile: baseline,
    gate_passed: true,
    pre_migration: { passed: true, n: 12 },
    backfill_run_id: runId,
    recorded_at: hoursAgo(1),
    ...overrides,
  };
  await writeEvidence(db, target, evidence);
  return evidence;
}

async function readyVoyage(db: PGlite, overrides: Evidence = {}): Promise<void> {
  await fillProfile(db, VOYAGE, 1024, 'voyage-4-large');
  await goodEvidence(db, VOYAGE, LEGACY, overrides);
}

async function activeProfile(db: PGlite): Promise<string | undefined> {
  return (await db.query<{ id: string }>("SELECT id FROM embedding_profiles WHERE status = 'active'")).rows[0]?.id;
}

async function pickChunk(db: PGlite, offset = 0): Promise<string> {
  const result = await db.query<{ id: string }>('SELECT id FROM document_chunks WHERE is_current AND status = \'ready\' ORDER BY id LIMIT 1 OFFSET $1', [offset]);
  const id = result.rows[0]?.id;
  assert.ok(id);
  return id;
}

for (const mode of MODES) {
  describe(`embedding profile activation gate (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      db = fixture.db;
    });

    after(async () => {
      await db.close();
    });

    test('refuses with incomplete and the count when a current ready chunk lacks a row', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await db.query('DELETE FROM chunk_embeddings WHERE chunk_id = $1 AND profile_id = $2', [await pickChunk(db), VOYAGE]);
        const message = await activate(db, VOYAGE);
        assert.match(message, /activation_refused: incomplete/);
        assert.match(message, /\(1 /);
        assert.equal(await activeProfile(db), LEGACY);
      });
    });

    test('quarantined and superseded chunks without a vector do not count as missing', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await readyVoyage(db);
        const quarantined = await pickChunk(db, 0);
        const superseded = await pickChunk(db, 1);
        await db.query('DELETE FROM chunk_embeddings WHERE chunk_id = ANY($1) AND profile_id = $2', [[quarantined, superseded], VOYAGE]);
        await db.query("UPDATE document_chunks SET status = 'quarantined' WHERE id = $1", [quarantined]);
        await db.query('UPDATE document_chunks SET is_current = false WHERE id = $1', [superseded]);
        assert.equal(await activate(db, VOYAGE), 'accepted');
        assert.equal(await activeProfile(db), VOYAGE);
      });
    });

    test('refuses with model_mismatch when a target row has another model or another dims', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await readyVoyage(db);
        await db.query('UPDATE chunk_embeddings SET embedding_model = $3 WHERE chunk_id = $1 AND profile_id = $2', [await pickChunk(db), VOYAGE, 'voyage-3-lite']);
        assert.match(await activate(db, VOYAGE), /activation_refused: model_mismatch/);
        await db.query('UPDATE chunk_embeddings SET embedding_model = $3 WHERE chunk_id = $1 AND profile_id = $2', [await pickChunk(db), VOYAGE, 'voyage-4-large']);
        assert.equal(await outcome(db, 'ALTER TABLE chunk_embeddings DISABLE TRIGGER rag_chunk_embeddings_guard'), 'accepted');
        await db.query('UPDATE chunk_embeddings SET dims = 512 WHERE chunk_id = $1 AND profile_id = $2', [await pickChunk(db), VOYAGE]);
        assert.match(await activate(db, VOYAGE), /activation_refused: model_mismatch/);
        assert.equal(await activeProfile(db), LEGACY);
      });
    });

    test('refuses when the evidence is missing, failed, has no passing pre_migration slice, or belongs to another target', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await fillProfile(db, VOYAGE, 1024, 'voyage-4-large');
        assert.match(await activate(db, VOYAGE), /activation_refused: eval_missing/);

        await goodEvidence(db, VOYAGE, LEGACY, { gate_passed: false });
        assert.match(await activate(db, VOYAGE), /activation_refused: eval_failed/);

        await goodEvidence(db, VOYAGE, LEGACY, { pre_migration: { passed: false, n: 12 } });
        assert.match(await activate(db, VOYAGE), /activation_refused: pre_migration_missing/);
        await goodEvidence(db, VOYAGE, LEGACY, { pre_migration: null });
        assert.match(await activate(db, VOYAGE), /activation_refused: pre_migration_missing/);
        await goodEvidence(db, VOYAGE, LEGACY, { pre_migration: { passed: true, n: 0 } });
        assert.match(await activate(db, VOYAGE), /activation_refused: pre_migration_missing/);

        await goodEvidence(db, VOYAGE, LEGACY, { target_profile: QWEN });
        assert.match(await activate(db, VOYAGE), /activation_refused: eval_target_mismatch/);
        assert.equal(await activeProfile(db), LEGACY);
      });
    });

    test('refuses evidence older than the target data, with another baseline, or tied to another run', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await fillProfile(db, VOYAGE, 1024, 'voyage-4-large');
        await goodEvidence(db, VOYAGE, LEGACY, { recorded_at: hoursAgo(3) });
        assert.match(await activate(db, VOYAGE), /activation_refused: eval_stale/);

        await goodEvidence(db, VOYAGE, QWEN);
        assert.match(await activate(db, VOYAGE), /activation_refused: eval_baseline_mismatch/);

        await goodEvidence(db, VOYAGE, LEGACY, { backfill_run_id: '00000000-0000-4000-8000-000000000bad' });
        assert.match(await activate(db, VOYAGE), /activation_refused: eval_run_mismatch/);
        const otherRun = await recordRun(db, QWEN);
        await goodEvidence(db, VOYAGE, LEGACY, { backfill_run_id: otherRun });
        assert.match(await activate(db, VOYAGE), /activation_refused: eval_run_mismatch/);
        await goodEvidence(db, VOYAGE, LEGACY, { backfill_run_id: null });
        assert.match(await activate(db, VOYAGE), /activation_refused: eval_run_mismatch/);
        assert.equal(await activeProfile(db), LEGACY);
      });
    });

    test('a passing activation flips the pointer and records the previous profile in one step', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await readyVoyage(db);
        const result = await db.query<Record<string, unknown>>('SELECT * FROM rag_activate_embedding_profile($1, $2)', [VOYAGE, 'operator-test']);
        assert.equal(result.rows.length, 1);
        const rows = await db.query<{ id: string; status: string; previous_active_id: string | null; activated_by: string | null; activated: boolean }>(
          'SELECT id, status, previous_active_id, activated_by, activated_at IS NOT NULL AS activated FROM embedding_profiles WHERE id = ANY($1) ORDER BY id',
          [[LEGACY, VOYAGE]],
        );
        const byId = new Map(rows.rows.map((row) => [row.id, row]));
        assert.equal(byId.get(VOYAGE)?.status, 'active');
        assert.equal(byId.get(VOYAGE)?.previous_active_id, LEGACY);
        assert.equal(byId.get(VOYAGE)?.activated_by, 'operator-test');
        assert.equal(byId.get(VOYAGE)?.activated, true);
        assert.equal(byId.get(LEGACY)?.status, 'available');
        assert.equal((await db.query("SELECT 1 FROM embedding_profiles WHERE status = 'active'")).rows.length, 1);
        assert.match(await activate(db, VOYAGE), /activation_refused: already_active/);
        assert.match(await activate(db, 'no-such-profile'), /activation_refused: unknown_profile/);
      });
    });

    test('rollback restores the previous profile and cannot be repeated', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        assert.match(await rollback(db), /rollback_refused: no_previous/);
        await readyVoyage(db);
        assert.equal(await activate(db, VOYAGE), 'accepted');
        assert.equal(await rollback(db), 'accepted');
        assert.equal(await activeProfile(db), LEGACY);
        const voyage = await db.query<{ status: string }>('SELECT status FROM embedding_profiles WHERE id = $1', [VOYAGE]);
        assert.equal(voyage.rows[0]?.status, 'available');
        assert.equal((await db.query('SELECT 1 FROM chunk_embeddings WHERE profile_id = $1', [VOYAGE])).rows.length > 0, true);
        assert.match(await rollback(db), /rollback_refused: no_previous/);
      });
    });

    test('rollback to a halfvec profile that lacks a vector for a current ready chunk is refused', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await readyVoyage(db);
        assert.equal(await activate(db, VOYAGE), 'accepted');
        await fillProfile(db, QWEN, 1024, QWEN_MODEL);
        await goodEvidence(db, QWEN, VOYAGE);
        assert.equal(await activate(db, QWEN), 'accepted');
        await db.query('DELETE FROM chunk_embeddings WHERE chunk_id = $1 AND profile_id = $2', [await pickChunk(db), VOYAGE]);
        assert.match(await rollback(db), /rollback_refused: incomplete/);
        assert.equal(await activeProfile(db), QWEN);
      });
    });

    test('the legacy profile is checked on document_chunks.embedding, for rollback and for activation', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await readyVoyage(db);
        assert.equal(await activate(db, VOYAGE), 'accepted');
        const chunk = await pickChunk(db);
        const original = await db.query<{ embedding: string }>('SELECT embedding::text AS embedding FROM document_chunks WHERE id = $1', [chunk]);
        await db.query('UPDATE document_chunks SET embedding = NULL WHERE id = $1', [chunk]);
        assert.match(await rollback(db), /rollback_refused: incomplete/);
        assert.equal(await activeProfile(db), VOYAGE);

        await db.query('UPDATE document_chunks SET embedding = $2::vector WHERE id = $1', [chunk, original.rows[0]?.embedding]);
        await goodEvidence(db, LEGACY, VOYAGE, { backfill_run_id: null });
        assert.equal(await activate(db, LEGACY), 'accepted');
        assert.equal(await activeProfile(db), LEGACY);
      });
    });

    test('activating the legacy profile back refuses while a current ready chunk has no legacy vector', async () => {
      await requireGate(db);
      await inTransaction(db, async () => {
        await readyVoyage(db);
        assert.equal(await activate(db, VOYAGE), 'accepted');
        await goodEvidence(db, LEGACY, VOYAGE, { backfill_run_id: null });
        await db.query('UPDATE document_chunks SET embedding = NULL WHERE id = $1', [await pickChunk(db)]);
        assert.match(await activate(db, LEGACY), /activation_refused: incomplete/);
        assert.equal(await activeProfile(db), VOYAGE);
      });
    });

    test('both functions are callable by service_role only', async () => {
      await requireGate(db);
      const result = await db.query<{ signature: string; anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT s AS signature, has_function_privilege('anon', s, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', s, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', s, 'EXECUTE') AS service
         FROM unnest(ARRAY[$1, $2]) AS s`,
        [ACTIVATE_SIGNATURE, ROLLBACK_SIGNATURE],
      );
      assert.equal(result.rows.length, 2);
      for (const row of result.rows) assert.deepEqual({ anon: row.anon, authenticated: row.authenticated, service: row.service }, { anon: false, authenticated: false, service: true }, row.signature);
    });
  });
}
