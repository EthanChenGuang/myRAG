import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';

// Neutral synthetic questions: one about a fixture document, one about a topic no fixture document covers.
const ANSWERABLE = 'What were the launch rules of the Marrowfield Rocketry Club in 2025?';
const OFF_DOMAIN = 'Qzxv wyrmple jothbrack fenquiddle?';

interface TraceBody {
  refused: boolean;
  refusal_reason: string | null;
  candidates: unknown[];
  stage_status: Record<string, string>;
  scope_gate?: { label: string; score: number | null; reason: string; centroid_count: number };
}

let prepared: InProcessEval;
let depsModule: typeof import('../../src/lib/rag/deps.ts');
let calibration: typeof import('../../src/lib/rag/scope/calibration.ts');
let profileId: string;

async function postEval(query: string): Promise<TraceBody> {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({ schema_version: 1, query, rag_mode: 'strict', options: {} }),
  });
  const res = await prepared.POST(req);
  assert.equal(res.status, 200);
  return (await res.json()) as TraceBody;
}

before(async () => {
  prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: 'single-tenant',
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_QUERY_LAYER: 'true' },
  });
  const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
  const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
  depsModule = await import('../../src/lib/rag/deps.ts');
  calibration = await import('../../src/lib/rag/scope/calibration.ts');
  const configModule = await import('../../src/lib/rag/config.ts');
  const { LEGACY_PROFILE } = await import('../../src/lib/rag/embeddings/active-profile.ts');
  const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
  const { rebuildScopeCentroids } = await import('../../src/lib/rag/scope/build.ts');
  const { refreshCentroidSnapshot } = await import('../../src/lib/rag/scope/centroids.ts');
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  await verifyV2Startup();

  // RAG_SCOPE_GATE reaches the config through the deps reader only once 06.2-32 wires it; the test adds it on the same seam.
  const baseEnv = depsModule.getRagDeps().ragEnv;
  depsModule.setRagDepsForTests({ ragEnv: () => ({ ...baseEnv(), RAG_SCOPE_GATE: 'true' }) });
  configModule.resetRagConfigForTests();

  const scope = mintScope('single', null, null);
  profileId = LEGACY_PROFILE.id;
  await rebuildScopeCentroids(scope, { profile: LEGACY_PROFILE });
  const snapshot = await refreshCentroidSnapshot(scope, profileId);
  assert.ok(snapshot && snapshot.centroids.length > 0, 'the fixture tenant has centroids');
});

after(async () => {
  calibration?.resetScopeGateCalibrationForTests();
  depsModule?.resetRagDepsForTests();
  await prepared?.close();
});

describe('Phase 6.2 scope gate through the eval route (D-26, D-27, D-29)', () => {
  let answerableScore = 0;
  let offDomainScore = 0;

  test('with an empty calibration both questions retrieve and the score is traced', async () => {
    calibration.setScopeGateCalibrationForTests({ schema_version: 1, recorded_at: '2026-11-27T00:00:00Z', source: 'fixture', cells: [] });
    const answerable = await postEval(ANSWERABLE);
    const offDomain = await postEval(OFF_DOMAIN);
    for (const trace of [answerable, offDomain]) {
      assert.ok(trace.scope_gate, 'scope_gate on the trace');
      assert.equal(trace.scope_gate.label, 'unsure');
      assert.equal(trace.scope_gate.reason, 'uncalibrated');
      assert.equal(typeof trace.scope_gate.score, 'number');
      assert.equal(trace.stage_status.scope_gate, 'ok');
      assert.equal(trace.stage_status.search, 'ok');
      assert.notEqual(trace.refusal_reason, 'out_of_scope');
    }
    answerableScore = answerable.scope_gate!.score!;
    offDomainScore = offDomain.scope_gate!.score!;
    assert.ok(answerableScore > offDomainScore, `answerable ${answerableScore} above off-domain ${offDomainScore}`);
  });

  test('with a calibration between the two scores the off-domain question is refused as out_of_scope', async () => {
    const gap = answerableScore - offDomainScore;
    const threshold = offDomainScore + gap * 0.75;
    const margin = gap * 0.25;
    calibration.setScopeGateCalibrationForTests({
      schema_version: 1,
      recorded_at: '2026-11-27T00:00:00Z',
      source: 'fixture',
      cells: [
        {
          embedding_profile_id: profileId,
          rag_mode: 'strict',
          threshold,
          margin,
          false_refusal_rate: 0,
          false_refusal_n: 1,
          correct_refusal_rate: 1,
          correct_refusal_n: 1,
          status: 'calibrated',
        },
      ],
    });
    const offDomain = await postEval(OFF_DOMAIN);
    assert.equal(offDomain.scope_gate?.label, 'out_of_scope');
    assert.equal(offDomain.refused, true);
    assert.equal(offDomain.refusal_reason, 'out_of_scope');
    assert.deepEqual(offDomain.candidates, []);
    assert.equal(offDomain.stage_status.search, undefined, 'search did not run');
  });

  test('the answerable question is still retrieved under the same calibration', async () => {
    const answerable = await postEval(ANSWERABLE);
    assert.equal(answerable.scope_gate?.label, 'in_scope');
    assert.equal(answerable.stage_status.search, 'ok');
    assert.notEqual(answerable.refusal_reason, 'out_of_scope');
    assert.ok(answerable.candidates.length > 0);
  });
});
