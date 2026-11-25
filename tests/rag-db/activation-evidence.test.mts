import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const LEGACY = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-2048';
const RECORD_FN = 'rag_record_eval_evidence(text,jsonb,text)';

async function requireRecorder(db: PGlite): Promise<void> {
  const found = await db.query<{ exists: boolean }>('SELECT to_regprocedure($1) IS NOT NULL AS exists', [RECORD_FN]);
  assert.equal(found.rows[0]?.exists, true, 'rag_record_eval_evidence is missing');
}

async function fillProfile(db: PGlite, profileId: string, dims: number, model: string): Promise<void> {
  await db.query(
    `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims, embedded_at)
     SELECT c.id, $1, c.tenant_key, array_fill(0.1::float4, ARRAY[$2::int])::halfvec, $3, $2::int, now() - interval '2 hours'
     FROM document_chunks c WHERE c.is_current AND c.status = 'ready'`,
    [profileId, dims, model],
  );
}

async function recordRun(db: PGlite, profileId: string): Promise<string> {
  const result = await db.query<{ id: string }>("INSERT INTO embedding_backfill_runs (profile_id, status) VALUES ($1, 'completed') RETURNING id", [profileId]);
  return result.rows[0]!.id;
}

describe('rag_record_eval_evidence and activation', () => {
  let fixture: FixtureDatabase;
  let db: PGlite;
  let edge: FakeEdge;
  let cli: typeof import('@/lib/rag/embeddings/cli');
  let activeProfile: typeof import('@/lib/rag/embeddings/active-profile');

  before(async () => {
    fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: path.join('eval/fixtures/corpus') });
    db = fixture.db;
    edge = await startFakeEdge({ db });
    Object.assign(process.env, fixtureProcessEnv(edge.url));
    process.env.RAG_EMBEDDING_PROFILES = 'on';
    cli = await import('@/lib/rag/embeddings/cli');
    activeProfile = await import('@/lib/rag/embeddings/active-profile');
    activeProfile.resetActiveProfileForTests();
  });

  after(async () => {
    activeProfile?.resetActiveProfileForTests();
    await edge?.close();
    await db?.close();
  });

  test('refuses evidence on the active profile', async () => {
    await requireRecorder(db);
    const evidence = {
      target_profile: LEGACY,
      baseline_profile: LEGACY,
      gate_passed: true,
      pre_migration: { passed: true, n: 1 },
      backfill_run_id: await recordRun(db, VOYAGE),
      recorded_at: new Date().toISOString(),
    };
    await assert.rejects(
      () => db.query('SELECT * FROM rag_record_eval_evidence($1, $2::jsonb, $3)', [LEGACY, JSON.stringify(evidence), 'operator']),
      /evidence_refused: profile_is_active/,
    );
  });

  test('record-evidence writes passing evidence and activation accepts it', async () => {
    await requireRecorder(db);
    await fillProfile(db, VOYAGE, 2048, 'voyage-4-large');
    const runId = await recordRun(db, VOYAGE);
    const comparison = {
      schema_version: 1,
      baseline_profile: LEGACY,
      active_profile: LEGACY,
      profiles: [],
      pre_migration: { n: 4, passed: true, recall_at_5: { value: 0.5, n: 4 }, recall_at_10: { value: 0.5, n: 4 }, mrr: { value: 0.25, n: 4 } },
      gate_passed: true,
      backfill_run_id: runId,
      notes: [],
    };
    const file = path.join(os.tmpdir(), `comparison-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(comparison));
    const code = await cli.main(['record-evidence', file, '--target', VOYAGE]);
    assert.equal(code, 0);
    const activated = await cli.main(['activate', VOYAGE]);
    assert.equal(activated, 0);
  });

  test('activation refuses regressing evidence', async () => {
    await db.query('DELETE FROM chunk_embeddings WHERE profile_id = $1', [VOYAGE]);
    await db.query("UPDATE embedding_profiles SET status = 'available', eval_evidence = NULL");
    await db.query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [LEGACY]);
    await fillProfile(db, VOYAGE, 2048, 'voyage-4-large');
    const runId = await recordRun(db, VOYAGE);
    const evidence = {
      target_profile: VOYAGE,
      baseline_profile: LEGACY,
      gate_passed: false,
      pre_migration: { passed: true, n: 2 },
      backfill_run_id: runId,
      recorded_at: new Date().toISOString(),
    };
    await db.query('SELECT * FROM rag_record_eval_evidence($1, $2::jsonb, $3)', [VOYAGE, JSON.stringify(evidence), 'operator']);
    const code = await cli.main(['activate', VOYAGE]);
    assert.equal(code, 1);
  });

  test('activation refuses stale evidence', async () => {
    await db.query('DELETE FROM chunk_embeddings WHERE profile_id = $1', [VOYAGE]);
    await db.query("UPDATE embedding_profiles SET status = 'available', eval_evidence = NULL");
    await db.query("UPDATE embedding_profiles SET status = 'active' WHERE id = $1", [LEGACY]);
    await fillProfile(db, VOYAGE, 2048, 'voyage-4-large');
    const runId = await recordRun(db, VOYAGE);
    const stale = {
      target_profile: VOYAGE,
      baseline_profile: LEGACY,
      gate_passed: true,
      pre_migration: { passed: true, n: 2 },
      backfill_run_id: runId,
      recorded_at: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
    };
    await db.query('SELECT * FROM rag_record_eval_evidence($1, $2::jsonb, $3)', [VOYAGE, JSON.stringify(stale), 'operator']);
    const code = await cli.main(['activate', VOYAGE]);
    assert.equal(code, 1);
  });
});