import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import type { FakeQueryLlm } from '../../eval/harness/fake-query-llm.mts';
import type { FakeLangChainChatModel, FakeLangChainTable } from '../../src/lib/rag/query/langchain/fake.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TABLE_PATH = path.join(REPO_ROOT, 'eval/fixtures/query-llm/transforms.json');
const ROUTE_PATH = '/api/internal/rag/run';

const FOLLOW_UP = 'What accuracy does it have?';
const STANDALONE = 'What accuracy does the XR-5100 reference thermometer have?';
const CONVERSATION = [
  { role: 'user', content: 'Tell me about the XR-5100 reference thermometer.' },
  { role: 'assistant', content: 'The XR-5100 is a reference thermometer sold under SKU LV-81-0007.' },
];

interface TraceBody {
  query_plan: null | { original: string; standalone: string; framework: string; variants: Array<{ kind: string }> };
  kept: Array<{ chunk_id: string; content: string }>;
  candidates: Array<{ chunk_id: string; legs?: Record<string, number> }>;
  stage_status: Record<string, string>;
  stage_counts?: Record<string, Record<string, number>>;
}

let prepared: InProcessEval;
let nativeFake: FakeQueryLlm;
let langchainFake: FakeLangChainChatModel;
let depsModule: typeof import('../../src/lib/rag/deps.ts');
let transformerModule: typeof import('../../src/lib/rag/query/transformer.ts');
let langchainFakeModule: typeof import('../../src/lib/rag/query/langchain/fake.ts');
let nativeFakeModule: typeof import('../../eval/harness/fake-query-llm.mts');
let table: FakeLangChainTable;

async function postEval(body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({ schema_version: 1, rag_mode: 'balanced', ...body }),
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
  const { readFile } = await import('node:fs/promises');
  depsModule = await import('../../src/lib/rag/deps.ts');
  transformerModule = await import('../../src/lib/rag/query/transformer.ts');
  langchainFakeModule = await import('../../src/lib/rag/query/langchain/fake.ts');
  nativeFakeModule = await import('../../eval/harness/fake-query-llm.mts');
  table = JSON.parse(await readFile(TABLE_PATH, 'utf8')) as FakeLangChainTable;
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  await verifyV2Startup();
});

beforeEach(() => {
  nativeFake = nativeFakeModule.createFakeQueryLlm();
  depsModule.setRagDepsForTests({ queryLlm: () => nativeFake });
  langchainFake = langchainFakeModule.createFakeLangChainChatModel({ table });
  transformerModule.setLangChainChatModelFactoryForTests(() => langchainFake);
});

after(async () => {
  transformerModule?.setLangChainChatModelFactoryForTests(null);
  depsModule?.resetRagDepsForTests();
  await prepared?.close();
});

describe('query layer with query_framework langchain through the eval route', () => {
  test('a multi_turn follow-up is condensed by LangChain, fused by EnsembleRetriever and finds the expected chunk', async () => {
    const { status, json } = await postEval({
      query: FOLLOW_UP,
      conversation: CONVERSATION,
      item_id: 'en-multi-turn-001',
      options: { query_framework: 'langchain' },
    });
    assert.equal(status, 200);

    const plan = json.query_plan;
    assert.ok(plan, 'expected a query_plan in the trace');
    assert.equal(plan.framework, 'langchain');
    assert.equal(plan.original, FOLLOW_UP);
    assert.equal(plan.standalone, STANDALONE);
    assert.deepEqual(
      plan.variants.map((variant) => variant.kind),
      ['original', 'condensed'],
    );

    assert.equal(nativeFake.calls.length, 0, 'the native query LLM is never called in langchain mode');
    assert.deepEqual(
      langchainFake.calls.map((call) => call.transform),
      ['condense'],
    );
    assert.equal(json.stage_status.framework_import, 'ok');
    assert.equal(json.stage_status.condense, 'ok');
    assert.equal(json.stage_status.search, 'ok');
    assert.equal(json.stage_counts?.fuse?.delegated, 1, 'the EnsembleRetriever delegate fused the variant lists');
    assert.equal(typeof json.stage_counts?.framework_import?.import_ms, 'number');

    const legs = new Set(json.candidates.flatMap((row) => Object.keys(row.legs ?? {})));
    assert.ok(legs.has('dense:0'), 'the original variant was searched through the port');
    assert.ok(legs.has('dense:1'), 'the condensed variant was searched through the port');

    const expected = json.kept.some((row) => row.content.includes('XR-5100') && row.content.includes('LV-81-0007'));
    assert.ok(expected, 'expected the XR-5100 specification chunk in kept');
  });

  test('the same request with the default framework keeps the native path and loads no framework', async () => {
    const { status, json } = await postEval({ query: FOLLOW_UP, conversation: CONVERSATION, item_id: 'en-multi-turn-001', options: {} });
    assert.equal(status, 200);
    assert.equal(json.query_plan?.framework, 'llamaindex');
    assert.equal(json.stage_status.framework_import, undefined);
    assert.equal(json.stage_counts?.fuse?.delegated, undefined);
    assert.equal(langchainFake.calls.length, 0);
    assert.deepEqual(
      nativeFake.calls.map((call) => call.transform),
      ['condense'],
    );
  });
});
