import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { loadCorpus } from '../../eval/harness/corpus.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import {
  FIXTURE_USER_ID,
  createEmptyFixtureDatabase,
  createFixtureDatabase,
  latestLineageVersions,
  prechunkedWriter,
  runFixtureRelex,
  supersedeFixtureLineages,
  type DeploymentMode,
} from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import {
  REPO_ROOT,
  SLOT_A,
  SLOT_B,
  corpusTenant,
  grantRegisterBind,
  installFixtureProductionModel,
  resetFinetuneState,
  rowsOf,
  runIdOf,
  runProfileComparison,
  startHarness,
  type Harness,
} from '../helpers/finetune-lifecycle.mts';

// 06.1-17 Task 2: the slot never crosses tenants (D-28), and with RAG_FINETUNE=off nothing differs from a database without 065x (D-02).
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const FINETUNE_MIGRATION = /\/065\d_[a-z0-9_]+(\.(single|multi)-tenant)?\.sql$/;
const VERSION = 'ft-neutral-canary-v1';
const TENANT_A = `u:${TWO_TENANT_IDS.userA}`;
const TENANT_B = `u:${TWO_TENANT_IDS.userB}`;
const CANARY_TEXT = 'Neutral canary passage: the sample widget record lists seven numbered steps for the calibration routine.';
const CANARY_QUERY = 'how many numbered steps does the widget calibration routine list';

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness?.close();
});

describe('fine-tune slot two-tenant canary (multi-tenant)', () => {
  let db: PGlite;
  const chunksOf: Record<string, string[]> = {};

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    for (const [label, userId] of [['a', TWO_TENANT_IDS.userA], ['b', TWO_TENANT_IDS.userB]] as const) {
      const documentId = crypto.randomUUID();
      await db.query('INSERT INTO documents (id, filename, content, metadata, user_id) VALUES ($1, $2, $3, $4::jsonb, $5)', [
        documentId,
        'canary-identical.md',
        CANARY_TEXT,
        JSON.stringify({ relpath: `canary/${label}/canary-identical.md` }),
        userId,
      ]);
      for (let index = 0; index < 3; index += 1) {
        await db.query('INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)', [
          crypto.randomUUID(),
          documentId,
          `Document: canary-identical.md. Chunk ${index + 1} of 3. Content: ${CANARY_TEXT}`,
          index,
          '{}',
        ]);
      }
    }
    await installFixtureProductionModel(db);
    for (const tenant of [TENANT_A, TENANT_B]) {
      chunksOf[tenant] = (await rowsOf(db, 'SELECT id FROM document_chunks WHERE tenant_key = $1', [tenant])).map((row) => String(row.id));
    }
    await harness.use(db, 'multi-tenant');
    await resetFinetuneState(db);
    harness.setFinetune(true);
    harness.setProfilesSwitch('on');
    harness.env.RAG_FT_SLOT_A_MODEL = VERSION;
  });

  after(async () => {
    await db?.close();
  });

  const slotVectors = async (tenant: string) =>
    Number((await rowsOf(db, 'SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1 AND tenant_key = $2', [SLOT_A, tenant]))[0]?.n);

  async function scopeOf(userId: string) {
    const resolved = await harness.rag.resolveTenantScope({ deploymentMode: 'multi-tenant', getUser: async () => ({ id: userId }), signal: new AbortController().signal });
    assert.ok(resolved.ok && resolved.scope);
    return resolved.scope;
  }

  test('tenants with identical chunks: a tenant-limited re-embed writes no other vector, and the active slot answers each tenant only from its own chunks', async () => {
    assert.equal(chunksOf[TENANT_A]?.length, 4, 'tenant A: its fixture chunk and three identical canary chunks');
    assert.equal(chunksOf[TENANT_B]?.length, 4);
    await grantRegisterBind(harness, corpusTenant('multi-tenant'), VERSION);

    const limited = await harness.reembed('--profile', SLOT_A, '--tenant', TENANT_A, '--batch-size', '2');
    assert.equal(limited.code, 0, limited.text);
    assert.equal(await slotVectors(TENANT_A), 4);
    assert.equal(await slotVectors(TENANT_B), 0, 'the run limited to tenant A wrote no tenant B vector');
    const foreign = await rowsOf(db, 'SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1 AND tenant_key <> $2', [SLOT_A, TENANT_A]);
    assert.equal(foreign[0]?.n, 0);
    const mislabelled = await rowsOf(
      db,
      'SELECT count(*)::int AS n FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id WHERE e.profile_id = $1 AND e.tenant_key <> c.tenant_key',
      [SLOT_A],
    );
    assert.equal(mislabelled[0]?.n, 0, 'every slot vector carries its chunk tenant');

    const full = await harness.reembed('--profile', SLOT_A, '--batch-size', '64');
    assert.equal(full.code, 0, full.text);
    const { file } = await runProfileComparison(harness, db, await scopeOf(FIXTURE_USER_ID), SLOT_A, runIdOf(full.text));
    assert.equal((await harness.embedding('record-evidence', file, '--target', SLOT_A)).code, 0);
    const activated = await harness.embedding('activate', SLOT_A);
    assert.equal(activated.code, 0, activated.text);

    for (const [userId, own, other] of [
      [TWO_TENANT_IDS.userA, TENANT_A, TENANT_B],
      [TWO_TENANT_IDS.userB, TENANT_B, TENANT_A],
    ] as const) {
      harness.edge.calls.length = 0;
      const result = await harness.rag.runRetrieval({
        scope: await scopeOf(userId),
        query: CANARY_QUERY,
        profile: 'eval',
        options: { maxResults: 25, fallbackToLowerThreshold: true },
        signal: new AbortController().signal,
      });
      assert.equal(result.status, 'ok', result.reason);
      assert.ok(harness.edge.calls.some((call) => call.path.endsWith('/rpc/match_chunks_by_profile')), 'the slot answered');
      const ids = result.candidates.map((candidate) => candidate.chunk_id);
      assert.ok(ids.length > 0);
      assert.ok(ids.every((id) => chunksOf[own]!.includes(id)), `${own} sees only its own chunk ids`);
      assert.ok(!ids.some((id) => chunksOf[other]!.includes(id)), `${own} sees none of ${other}`);
    }
    assert.equal((await harness.embedding('rollback')).code, 0);
  });
});

interface StageCount {
  name: string;
  status: string;
  in: number | null;
  out: number | null;
}

interface Observation {
  status: string;
  reason: string;
  candidates: Array<[string, number]>;
  kept: string[];
  stages: StageCount[];
}

/** The corpus load of createFixtureDatabase, on a database whose migrations leave out the fine-tune block. The setup files fold 0651-0654
 * (06.1-18), so the reference starts from the frozen pre-Phase-3 setup and applies every other migration in loader order. */
async function databaseWithoutFinetune(mode: DeploymentMode): Promise<PGlite> {
  const files = migrationFiles(mode);
  const kept = files.filter((file) => !FINETUNE_MIGRATION.test(`/${file}`));
  assert.equal(files.length - kept.length, 4, 'migrations 0651-0654 are left out');
  const { db } = await createEmptyFixtureDatabase({
    deploymentMode: mode,
    migrations: false,
    setupSqlPath: `tests/fixtures/sql/pre-phase3-${mode}-setup.sql`,
  });
  await applyMigrationFiles(db, kept);
  if (mode === 'multi-tenant') await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [FIXTURE_USER_ID, 'fixture-user@example.invalid']);
  const corpus = loadCorpus(CORPUS_DIR);
  const writer = await prechunkedWriter(db, mode, latestLineageVersions(corpus.documents));
  for (const doc of corpus.documents) await writer(doc);
  await runFixtureRelex(db);
  await supersedeFixtureLineages(db, corpus.documents);
  return db;
}

function goldenQuestions(): Array<{ id: string; question: string }> {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: string; question: string });
}

for (const mode of ['multi-tenant', 'single-tenant'] as const) {
  describe(`RAG_FINETUNE=off parity with a database without the fine-tune migrations (${mode})`, () => {
    let withSlots: PGlite;
    let without: PGlite;

    before(async () => {
      withSlots = (await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS_DIR })).db;
      without = await databaseWithoutFinetune(mode);
      harness.likeForLike = false;
    });

    after(async () => {
      harness.likeForLike = true;
      await withSlots?.close();
      await without?.close();
    });

    async function scope() {
      const resolved = await harness.rag.resolveTenantScope({ deploymentMode: mode, getUser: async () => ({ id: FIXTURE_USER_ID }), signal: new AbortController().signal });
      assert.ok(resolved.ok && resolved.scope);
      return resolved.scope;
    }

    async function observe(db: PGlite, profilesSwitch: 'on' | 'off'): Promise<{ verdict: unknown; results: Record<string, Observation> }> {
      await harness.use(db, mode);
      harness.setFinetune(false);
      harness.setProfilesSwitch(profilesSwitch);
      const verdict: Record<string, unknown> = { ...(await harness.activeProfile.verifyActiveEmbeddingProfileAtStartup({ timeoutMs: 10_000 })) };
      delete verdict.checkedAt;
      const results: Record<string, Observation> = {};
      for (const item of goldenQuestions()) {
        const result = await harness.rag.runRetrieval({
          scope: await scope(),
          query: item.question,
          profile: 'eval',
          options: { maxResults: 25, fallbackToLowerThreshold: true },
          signal: new AbortController().signal,
        });
        results[item.id] = {
          status: result.status,
          reason: result.reason,
          candidates: result.candidates.map((candidate) => [candidate.chunk_id, Number(candidate.similarity.toFixed(6))]),
          kept: result.kept.map((chunk) => chunk.chunk_id),
          stages: result.stages.map((stage) => ({ name: stage.name, status: stage.status, in: stage.candidates_in, out: stage.candidates_out })),
        };
      }
      return { verdict, results };
    }

    test('the slot rows exist unbound and are never searched', async () => {
      const slots = await rowsOf(withSlots, "SELECT id, model, status FROM embedding_profiles WHERE id IN ($1, $2) ORDER BY id", [SLOT_A, SLOT_B]);
      assert.deepEqual(slots, [
        { id: SLOT_A, model: 'unbound', status: 'available' },
        { id: SLOT_B, model: 'unbound', status: 'available' },
      ]);
      assert.equal((await rowsOf(without, "SELECT count(*)::int AS n FROM embedding_profiles WHERE id LIKE 'ft-%'"))[0]?.n, 0);
      assert.equal((await rowsOf(without, "SELECT to_regclass('public.embedding_model_versions') IS NULL AS missing"))[0]?.missing, true);
    });

    for (const profilesSwitch of ['off', 'on'] as const) {
      test(`startup check and the fixture golden set give the same results and trace counts (RAG_EMBEDDING_PROFILES=${profilesSwitch})`, async () => {
        const reference = await observe(without, profilesSwitch);
        harness.edge.calls.length = 0;
        harness.endpoints.calls.length = 0;
        const observed = await observe(withSlots, profilesSwitch);
        assert.deepEqual(observed.verdict, reference.verdict);
        assert.equal(Object.keys(observed.results).length, goldenQuestions().length);
        assert.ok(Object.values(reference.results).some((result) => result.status === 'ok'), 'the fixture golden set retrieves something');
        for (const [id, result] of Object.entries(observed.results)) assert.deepEqual(result, reference.results[id], id);
        assert.deepEqual(harness.endpoints.callsFor('ft'), [], 'the slot endpoint was never called');
        assert.ok(!harness.edge.calls.some((call) => /rag_finetune_/.test(call.path)), 'no fine-tune function was called');
      });
    }
  });
}
