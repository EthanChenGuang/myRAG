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

const FOLLOW_UP = 'What accuracy does it have?';
const STANDALONE = 'What accuracy does the XR-5100 reference thermometer have?';
const CONVERSATION = [
  { role: 'user', content: 'Tell me about the XR-5100 reference thermometer.' },
  { role: 'assistant', content: 'The XR-5100 is a reference thermometer sold under SKU LV-81-0007.' },
];

interface TraceBody {
  query_plan: null | {
    original: string;
    standalone: string;
    framework: string;
    gate: { reasons: string[]; transforms: string[]; rewrite: boolean };
    variants: Array<{ kind: string; text: string; protected_ok: boolean }>;
    skipped: Array<{ transform: string; reason: string }>;
  };
  query_transforms: Array<{ kind: string; text: string; transform: string | null; status: string | null; reason: string | null }>;
  kept: Array<{ chunk_id: string; content: string }>;
  candidates: Array<{ chunk_id: string; content: string; legs?: Record<string, number> }>;
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
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_QUERY_LAYER: 'true' },
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

describe('query-layer tracer through the eval route', () => {
  test('a multi_turn follow-up is gated, condensed by the fake query LLM and both variants are searched', async () => {
    const { status, json } = await postEval({ query: FOLLOW_UP, conversation: CONVERSATION, item_id: 'en-multi-turn-001' });
    assert.equal(status, 200);

    const plan = json.query_plan;
    assert.ok(plan, 'expected a query_plan in the trace');
    assert.ok(
      plan.gate.reasons.includes('R1_PRONOUN') || plan.gate.reasons.includes('R5_ELLIPTICAL'),
      `gate reasons ${plan.gate.reasons.join(',')}`,
    );
    assert.ok(plan.gate.transforms.includes('condense_history'));
    assert.equal(plan.original, FOLLOW_UP);
    assert.equal(plan.standalone, STANDALONE);
    assert.equal(plan.framework, 'llamaindex');
    assert.deepEqual(
      plan.variants.map((variant) => variant.kind),
      ['original', 'condensed'],
    );
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(json.query_transforms, [{ kind: 'condensed', text: STANDALONE, transform: 'condense', status: 'ok', reason: null }]);

    assert.deepEqual(
      fake.calls.map((call) => call.transform),
      ['condense'],
    );
    assert.equal(json.stage_status.query_gate, 'ok');
    assert.equal(json.stage_status.condense, 'ok');
    assert.equal(json.stage_status.search, 'ok');

    const legs = new Set(json.candidates.flatMap((row) => Object.keys(row.legs ?? {})));
    assert.ok(legs.has('dense:0'), 'the original variant was searched');
    assert.ok(legs.has('dense:1'), 'the condensed variant was searched');

    const expected = json.kept.some((row) => row.content.includes('XR-5100') && row.content.includes('LV-81-0007'));
    assert.ok(expected, 'expected the XR-5100 specification chunk in kept');
  });

  test('a standalone question passes the gate without calling the query LLM', async () => {
    const { status, json } = await postEval({ query: 'What is SKU LV-RC-0030?', item_id: 'en-exact-term-002' });
    assert.equal(status, 200);
    const plan = json.query_plan;
    assert.ok(plan);
    assert.equal(plan.standalone, plan.original);
    assert.deepEqual(
      plan.variants.map((variant) => variant.kind),
      ['original'],
    );
    assert.deepEqual(json.query_transforms, []);
    assert.equal(fake.calls.length, 0);
    assert.equal(json.stage_status.query_gate, 'ok');
    assert.equal(json.stage_status.condense, undefined);
  });

  test('with RAG_QUERY_LAYER off the trace carries no plan and no query-layer stage', async () => {
    const previous = process.env.RAG_QUERY_LAYER;
    process.env.RAG_QUERY_LAYER = 'false';
    configModule.resetRagConfigForTests();
    try {
      const { status, json } = await postEval({ query: FOLLOW_UP, conversation: CONVERSATION, item_id: 'en-multi-turn-001' });
      assert.equal(status, 200);
      assert.equal(json.query_plan, null);
      assert.deepEqual(json.query_transforms, []);
      assert.equal(json.stage_status.query_gate, undefined);
      assert.equal(json.stage_status.condense, undefined);
      assert.equal(fake.calls.length, 0);
    } finally {
      process.env.RAG_QUERY_LAYER = previous;
      configModule.resetRagConfigForTests();
    }
  });
});
