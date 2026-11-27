import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import type { FakeQueryLlm } from '../../eval/harness/fake-query-llm.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';

// Synthetic comparison over a fixture document; the scripted decomposer keeps only the first year.
const QUESTION = 'How did the launch rules of the Marrowfield Rocketry Club differ between 2025 and 2026?';
const KEPT = 'What were the launch rules of the Marrowfield Rocketry Club in 2025?';
const CLONED = 'What were the launch rules of the Marrowfield Rocketry Club in 2026?';

interface TraceBody {
  query_plan: null | {
    gate: { reasons: string[]; transforms: string[] };
    variants: Array<{ kind: string; text: string; sub_question_index: number | null }>;
    sub_questions: string[];
    skipped: Array<{ transform: string; reason: string }>;
    completeness?: { required_count: number; missing_count: number; action: string };
  };
  candidates: Array<{ chunk_id: string; legs?: Record<string, number> }>;
  stage_status: Record<string, string>;
}

let prepared: InProcessEval;
let fake: FakeQueryLlm;
let depsModule: typeof import('../../src/lib/rag/deps.ts');
let configModule: typeof import('../../src/lib/rag/config.ts');
let fakeModule: typeof import('../../eval/harness/fake-query-llm.mts');

async function postEval(body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({ schema_version: 1, rag_mode: 'balanced', options: {}, ...body }),
  });
  const res = await prepared.POST(req);
  return { status: res.status, json: (await res.json()) as TraceBody };
}

before(async () => {
  prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: 'single-tenant',
    envOverrides: {
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'true',
      RAG_QUERY_LAYER: 'true',
      RAG_QUERY_DECOMPOSE: 'true',
      RAG_QUERY_DECOMPOSE_COMPLETENESS: 'true',
    },
  });
  const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
  const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
  depsModule = await import('../../src/lib/rag/deps.ts');
  configModule = await import('../../src/lib/rag/config.ts');
  fakeModule = await import('../../eval/harness/fake-query-llm.mts');
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  await verifyV2Startup();
});

beforeEach(() => {
  fake = fakeModule.createFakeQueryLlm();
  depsModule.setRagDepsForTests({ queryLlm: () => fake });
});

after(async () => {
  depsModule?.resetRagDepsForTests();
  await prepared?.close();
});

describe('Phase 6.2 tracer: decomposition completeness through the eval route', () => {
  test('a decomposition that drops one of two years is repaired, both parts are searched and the trace has counts only', async () => {
    const { status, json } = await postEval({ query: QUESTION });
    assert.equal(status, 200);

    const plan = json.query_plan;
    assert.ok(plan, 'expected a query_plan in the trace');
    assert.ok(plan.gate.reasons.includes('R3_COMPARISON'), `gate reasons ${plan.gate.reasons.join(',')}`);
    assert.ok(plan.gate.transforms.includes('decompose'));
    assert.ok(fake.calls.some((call) => call.transform === 'decompose'), 'the fake decomposer was called');

    assert.deepEqual(plan.sub_questions, [KEPT, CLONED]);
    assert.ok(plan.sub_questions.some((q) => q.includes('2025')));
    assert.ok(plan.sub_questions.some((q) => q.includes('2026')));

    assert.ok(plan.completeness, 'expected query_plan.completeness');
    assert.deepEqual(Object.keys(plan.completeness).sort(), ['action', 'missing_count', 'required_count']);
    assert.ok(plan.completeness.required_count >= 2, `required_count ${plan.completeness.required_count}`);
    assert.equal(plan.completeness.missing_count, 1);
    assert.equal(plan.completeness.action, 'added');
    assert.ok(!JSON.stringify(plan.completeness).includes('2026'), 'the completeness record carries no term');

    const subVariants = plan.variants.filter((variant) => variant.kind === 'sub_question');
    assert.deepEqual(
      subVariants.map((variant) => [variant.text, variant.sub_question_index]),
      [
        [KEPT, 0],
        [CLONED, 1],
      ],
    );
    const indexes = subVariants.map((variant) => plan.variants.indexOf(variant));
    const legs = new Set(json.candidates.flatMap((row) => Object.keys(row.legs ?? {})));
    for (const index of indexes) assert.ok(legs.has(`dense:${index}`), `sub-question variant ${index} was searched and fused`);

    assert.equal(json.stage_status.decompose, 'ok');
    assert.equal(json.stage_status.search, 'ok');
  });

  test('with the completeness switch off the same decomposition keeps the single sub-question and no completeness record', async () => {
    const previous = process.env.RAG_QUERY_DECOMPOSE_COMPLETENESS;
    process.env.RAG_QUERY_DECOMPOSE_COMPLETENESS = 'false';
    configModule.resetRagConfigForTests();
    try {
      const { status, json } = await postEval({ query: QUESTION });
      assert.equal(status, 200);
      const plan = json.query_plan;
      assert.ok(plan);
      assert.deepEqual(plan.sub_questions, [KEPT]);
      assert.equal(plan.completeness, undefined);
    } finally {
      process.env.RAG_QUERY_DECOMPOSE_COMPLETENESS = previous;
      configModule.resetRagConfigForTests();
    }
  });
});
