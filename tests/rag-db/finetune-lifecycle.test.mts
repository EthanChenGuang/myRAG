import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { FIXTURE_USER_ID, createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';
import {
  LEGACY,
  QUERY_PROMPT,
  REPO_ROOT,
  SLOT_A,
  corpusTenant,
  grantRegisterBind,
  installFixtureProductionModel,
  modelCard,
  resetFinetuneState,
  rowsOf,
  runIdOf,
  runProfileComparison,
  startHarness,
  writeJson,
  type Harness,
} from '../helpers/finetune-lifecycle.mts';

// 06.1-17 Task 1 (D-20, D-22..D-25, D-29): bind → re-embed → evidence → activate → serve → rollback on the real SQL and TS paths.
const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const VERSION = 'ft-neutral-model-v1';
const VERSION_2 = 'ft-neutral-model-v2';
const QUERY = 'express carrier cut-off for same-day dispatch';

let harness: Harness;

before(async () => {
  harness = await startHarness();
});

after(async () => {
  await harness?.close();
});

for (const mode of MODES) {
  describe(`fine-tune slot lifecycle (${mode})`, () => {
    let db: PGlite;
    const tenant = corpusTenant(mode);

    before(async () => {
      db =
        mode === 'multi-tenant'
          ? (await createTwoTenantDatabase()).db
          : (await createFixtureDatabase({ deploymentMode: mode, corpusDir: path.join(REPO_ROOT, 'eval/fixtures/corpus') })).db;
      await installFixtureProductionModel(db);
      await harness.use(db, mode);
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await harness.use(db, mode);
      await resetFinetuneState(db);
      harness.setFinetune(true);
      harness.setProfilesSwitch('on');
      harness.env.RAG_FT_SLOT_A_MODEL = VERSION;
      harness.endpoints.setFtSalt('');
      harness.endpoints.calls.length = 0;
    });

    const scope = async () => {
      const resolved = await harness.rag.resolveTenantScope({
        deploymentMode: mode,
        getUser: async () => ({ id: FIXTURE_USER_ID }),
        signal: new AbortController().signal,
      });
      assert.ok(resolved.ok && resolved.scope);
      return resolved.scope;
    };

    const retrieve = async (embeddingProfile?: string) =>
      harness.rag.runRetrieval({
        scope: await scope(),
        query: QUERY,
        profile: 'eval',
        options: { maxResults: 25, fallbackToLowerThreshold: true, ...(embeddingProfile ? { embeddingProfile } : {}) },
        signal: new AbortController().signal,
      });

    const activeId = async () => (await rowsOf(db, "SELECT id FROM embedding_profiles WHERE status = 'active'"))[0]?.id;
    const slotVectors = async (tenantKey?: string) =>
      Number(
        (await rowsOf(db, 'SELECT count(*)::int AS n FROM chunk_embeddings WHERE profile_id = $1 AND ($2::text IS NULL OR tenant_key = $2)', [SLOT_A, tenantKey ?? null]))[0]
          ?.n,
      );
    const currentChunks = async () => Number((await rowsOf(db, "SELECT count(*)::int AS n FROM document_chunks WHERE is_current AND status = 'ready'"))[0]?.n);
    const queryCalls = () => harness.endpoints.callsFor('ft').filter((call) => (call.body.input as string[]).some((input) => input === `${QUERY_PROMPT}${QUERY}`));

    async function reembedSlot(): Promise<string> {
      const result = await harness.reembed('--profile', SLOT_A, '--batch-size', '64');
      assert.equal(result.code, 0, result.text);
      assert.equal(await slotVectors(), await currentChunks(), 'every current ready chunk has a slot vector');
      return runIdOf(result.text);
    }

    async function recordEvidence(runId: string): Promise<Record<string, unknown>> {
      const { file, comparison } = await runProfileComparison(harness, db, await scope(), SLOT_A, runId);
      const recorded = await harness.embedding('record-evidence', file, '--target', SLOT_A);
      assert.equal(recorded.code, 0, recorded.text);
      return comparison;
    }

    async function activateSlot(): Promise<void> {
      const activated = await harness.embedding('activate', SLOT_A);
      assert.equal(activated.code, 0, activated.text);
      assert.equal(await activeId(), SLOT_A);
    }

    test('bind, ft-check, re-embed, evidence, activate, serve through the slot, rollback', async () => {
      await grantRegisterBind(harness, tenant, VERSION);
      const check = await harness.embedding('ft-check', SLOT_A);
      assert.equal(check.code, 0, check.text);

      const dry = await harness.reembed('--profile', SLOT_A, '--dry-run');
      assert.equal(dry.code, 0, dry.text);
      assert.match(dry.text, /total: chunks \d+, tokens \d+, estimated cost 0\.000000 USD/);
      assert.match(dry.text, /no list price/);

      const runId = await reembedSlot();
      const models = (await rowsOf(db, 'SELECT DISTINCT embedding_model FROM chunk_embeddings WHERE profile_id = $1', [SLOT_A])).map((row) => row.embedding_model);
      assert.deepEqual(models, [VERSION], 'every slot vector names the bound version');

      const comparison = await recordEvidence(runId);
      assert.equal(comparison.gate_passed, true, JSON.stringify(comparison).slice(0, 2000));
      assert.equal(comparison.backfill_run_id, runId);

      const activated = await harness.embedding('activate', SLOT_A);
      assert.equal(activated.code, 0, activated.text);
      assert.equal(await activeId(), SLOT_A);
      assert.equal((await harness.activeProfile.getActiveProfile()).id, SLOT_A);

      harness.endpoints.calls.length = 0;
      harness.edge.calls.length = 0;
      const served = await retrieve();
      assert.equal(served.status, 'ok', served.reason);
      assert.equal(queryCalls().length, 1, 'the query was embedded once by the slot endpoint with the query prompt');
      assert.ok(harness.edge.calls.some((call) => call.path.endsWith('/rpc/match_chunks_by_profile')), 'the slot vectors were searched');

      const rolled = await harness.embedding('rollback');
      assert.equal(rolled.code, 0, rolled.text);
      assert.equal(await activeId(), LEGACY);
      harness.endpoints.calls.length = 0;
      const legacy = await retrieve();
      assert.equal(legacy.status, 'ok', legacy.reason);
      assert.equal(queryCalls().length, 0, 'after the rollback the slot endpoint is not called');
    });

    test('mixed vectors are impossible: non-empty slot bind, model change after activation, weights change before any vector', async () => {
      await grantRegisterBind(harness, tenant, VERSION);
      assert.equal((await harness.embedding('ft-models', 'register', writeJson(harness.workDir, VERSION_2, modelCard(VERSION_2, [tenant])))).code, 0);

      harness.endpoints.setFtSalt('other weights behind the same url');
      harness.slot.resetFinetuneProbeCacheForTests();
      harness.endpoints.calls.length = 0;
      const refused = await harness.reembed('--profile', SLOT_A, '--batch-size', '64');
      assert.equal(refused.code, 1, refused.text);
      assert.equal(await slotVectors(), 0, 'the probe failed before any vector was written');
      const documentCalls = harness.endpoints.callsFor('ft').filter((call) => (call.body.input as string[]).some((input) => !input.includes('neutral probe sentence')));
      assert.deepEqual(documentCalls, [], 'no chunk text reached the endpoint');
      const failedRun = /--resume ([0-9a-f-]{36})/.exec(refused.text)?.[1];
      assert.ok(failedRun, refused.text);

      harness.endpoints.setFtSalt('');
      harness.slot.resetFinetuneProbeCacheForTests();
      const resumed = await harness.reembed('--resume', failedRun, '--batch-size', '64');
      assert.equal(resumed.code, 0, resumed.text);
      assert.equal(await slotVectors(), await currentChunks());

      const rebind = await harness.embedding('ft-bind', SLOT_A, VERSION_2);
      assert.equal(rebind.code, 1, rebind.text);
      assert.match(rebind.text, /bind_refused: slot_not_empty/);
      assert.equal((await rowsOf(db, 'SELECT model FROM embedding_profiles WHERE id = $1', [SLOT_A]))[0]?.model, VERSION);

      await recordEvidence(failedRun);
      await activateSlot();

      harness.env.RAG_FT_SLOT_A_MODEL = VERSION_2;
      harness.resetCaches();
      const verdict = await harness.activeProfile.verifyActiveEmbeddingProfileAtStartup({ timeoutMs: 10_000 });
      assert.equal(verdict.status, 'mismatch');
      assert.equal(verdict.status === 'mismatch' ? verdict.reason : null, 'model_mismatch');
      harness.endpoints.calls.length = 0;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const failed = await retrieve();
        assert.equal(failed.status, 'error', `query ${attempt} fails loudly, never as an empty answer`);
      }
      assert.equal(queryCalls().length, 0, 'no query vector came from the changed model');

      harness.env.RAG_FT_SLOT_A_MODEL = VERSION;
      harness.resetCaches();
      assert.equal((await retrieve()).status, 'ok');
    });

    test('revocation: before activation it drops the evidence; after activation it reports active_tainted and the printed rollback works', async () => {
      await grantRegisterBind(harness, tenant, VERSION);
      const runId = await reembedSlot();
      await recordEvidence(runId);
      const revoked = await harness.embedding('ft-consent', 'revoke', tenant);
      assert.equal(revoked.code, 0, revoked.text);
      const refused = await harness.embedding('activate', SLOT_A);
      assert.notEqual(refused.code, 0);
      assert.match(refused.text, /activation_refused: eval_missing/);
      assert.equal(await activeId(), LEGACY);

      await resetFinetuneState(db);
      harness.resetCaches();
      await grantRegisterBind(harness, tenant, VERSION);
      const second = await reembedSlot();
      await recordEvidence(second);
      await activateSlot();
      const tainted = await harness.embedding('ft-consent', 'revoke', tenant);
      assert.equal(tainted.code, 0, tainted.text);
      assert.match(tainted.text, /active_tainted|ACTIVE/);
      const rollbackLine = tainted.text.split('\n').find((line) => line.includes('npm run rag:embedding -- rollback'));
      assert.ok(rollbackLine, tainted.text);
      const rolled = await harness.embedding('rollback');
      assert.equal(rolled.code, 0, rolled.text);
      assert.equal(await activeId(), LEGACY);
      const clear = await harness.embedding('ft-release-rollback', '--ack', 'drop-rollback');
      assert.equal(clear.code, 0, clear.text);
      assert.equal((await harness.embedding('ft-clear', SLOT_A)).code, 0);
      assert.equal(await slotVectors(), 0);
    });
  });
}
