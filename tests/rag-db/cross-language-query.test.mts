import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import type { FakeQueryLlm, FakeQueryLlmEntry } from '../../eval/harness/fake-query-llm.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const SHARES_RPC = 'rag_tenant_language_shares';

// Questions about the scope clause of the zh-only maintenance contract fixture; the translations carry its zh terms
// because the fixture embedder is lexical, not cross-lingual (research P-13).
const QUESTION_EN = 'How often does the provider carry out the inspections, and when is the written report due?';
const QUESTION_IT = 'Ogni quanto il fornitore esegue le ispezioni e quando deve consegnare il rapporto scritto?';
const TRANSLATION_ZH = '乙方多久进行一次巡检，书面巡检报告何时提交？';
const EXPECTED_ZH_CHUNK = '第一条 服务范围';

const TRANSLATIONS: FakeQueryLlmEntry[] = [
  { transform: 'translate', query: QUESTION_EN, output: { text: TRANSLATION_ZH, target_language: 'zh' } },
  { transform: 'translate', query: QUESTION_IT, output: { text: TRANSLATION_ZH, target_language: 'zh' } },
];

interface TraceBody {
  query_plan: null | {
    gate: { reasons: string[]; transforms: string[] };
    variants: Array<{ kind: string; text: string; language: string }>;
    skipped?: Array<{ transform: string; reason: string }>;
  };
  kept: Array<{ chunk_id: string; content: string }>;
  candidates: Array<{ chunk_id: string; content: string; legs?: Record<string, number> }>;
  stage_status: Record<string, string>;
}

type RpcCall = { fn: string; args: Record<string, unknown> };
type Shares = Record<string, number> | 'database';

let prepared: InProcessEval;
let fake: FakeQueryLlm;
let depsModule: typeof import('../../src/lib/rag/deps.ts');
let configModule: typeof import('../../src/lib/rag/config.ts');
let kbModule: typeof import('../../src/lib/rag/query/kb-languages.ts');
let fakeModule: typeof import('../../eval/harness/fake-query-llm.mts');
let baseAdmin: () => unknown;
let rpcCalls: RpcCall[] = [];

/** Serves the shares a test names (a zh-heavy or an en-heavy tenant) and passes every other RPC to the PGlite client. */
function installShares(shares: Shares) {
  depsModule.setRagDepsForTests({
    adminClient: () => {
      const client = baseAdmin() as { rpc: (fn: string, args: Record<string, unknown>) => unknown };
      return new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== 'rpc') return Reflect.get(target, prop, receiver);
          return (fn: string, args: Record<string, unknown>) => {
            if (fn === SHARES_RPC) rpcCalls.push({ fn, args });
            if (fn !== SHARES_RPC || shares === 'database') return target.rpc(fn, args);
            const response = { data: Object.entries(shares).map(([language, share]) => ({ language, share, docs: 1 })), error: null };
            const request = {
              abortSignal: () => request,
              then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(response).then(resolve, reject),
            };
            return request;
          };
        },
      }) as never;
    },
  });
}

async function postEval(body: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({ schema_version: 1, rag_mode: 'balanced', options: {}, ...body }),
  });
  const res = await prepared.POST(req);
  return { status: res.status, json: (await res.json()) as TraceBody };
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  configModule.resetRagConfigForTests();
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    configModule.resetRagConfigForTests();
  }
}

function translatedIndex(json: TraceBody): number {
  return json.query_plan?.variants.findIndex((variant) => variant.kind === 'translated') ?? -1;
}

before(async () => {
  prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: 'single-tenant',
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_QUERY_LAYER: 'true', RAG_QUERY_TRANSLATE: 'true' },
  });
  const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
  const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
  depsModule = await import('../../src/lib/rag/deps.ts');
  configModule = await import('../../src/lib/rag/config.ts');
  kbModule = await import('../../src/lib/rag/query/kb-languages.ts');
  fakeModule = await import('../../eval/harness/fake-query-llm.mts');
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  await verifyV2Startup();
  const current = depsModule.getRagDeps();
  baseAdmin = current.adminClient.bind(current);
});

beforeEach(() => {
  rpcCalls = [];
  kbModule.resetKbLanguageCacheForTests();
  fake = fakeModule.createFakeQueryLlm({ table: { version: 1, entries: TRANSLATIONS } });
  depsModule.setRagDepsForTests({ queryLlm: () => fake });
});

after(async () => {
  depsModule?.resetRagDepsForTests();
  await prepared?.close();
});

describe('cross-language retrieval through the query-layer translate slot (XLG-01)', () => {
  for (const [label, question] of [
    ['English', QUESTION_EN],
    ['Italian', QUESTION_IT],
  ] as const) {
    test(`an ${label} question about a zh-only document finds the zh chunk through the translated variant`, async () => {
      installShares({ zh: 0.85, en: 0.1, it: 0.05 });
      const { status, json } = await postEval({ query: question });
      assert.equal(status, 200);

      assert.equal(rpcCalls.length, 1, 'the shares are read once, with the request scope key');
      assert.deepEqual(Object.keys(rpcCalls[0]!.args), ['p_tenant_key']);
      assert.deepEqual(
        fake.calls.filter((call) => call.transform === 'translate'),
        [{ transform: 'translate', input: question }],
      );

      const plan = json.query_plan;
      assert.ok(plan, 'expected a query_plan');
      assert.ok(plan.gate.reasons.includes('R8_LANGUAGE_MISMATCH'), `gate reasons ${plan.gate.reasons.join(',')}`);
      const index = translatedIndex(json);
      assert.ok(index > 0, 'expected a translated variant in the plan');
      assert.deepEqual(
        { text: plan.variants[index]!.text, language: plan.variants[index]!.language },
        { text: TRANSLATION_ZH, language: 'zh' },
      );
      assert.equal(json.stage_status.translate, 'ok');

      const hit = json.candidates.find((row) => row.content.includes(EXPECTED_ZH_CHUNK));
      assert.ok(hit, 'expected the zh scope-clause chunk among the candidates');
      const legs = Object.keys(hit.legs ?? {});
      assert.ok(
        legs.some((leg) => leg.endsWith(`:${index}`)),
        `the zh chunk is reached by the translated variant (legs ${legs.join(',')})`,
      );
      assert.ok(
        json.kept.some((row) => row.content.includes(EXPECTED_ZH_CHUNK)),
        'expected the zh scope-clause chunk in kept after RRF',
      );
    });
  }

  test('a tenant whose KB is mostly English does not translate the English question', async () => {
    installShares({ en: 0.8, zh: 0.1, it: 0.1 });
    const { status, json } = await postEval({ query: QUESTION_EN });
    assert.equal(status, 200);

    assert.equal(fake.calls.filter((call) => call.transform === 'translate').length, 0);
    assert.ok(json.query_plan);
    assert.ok(!json.query_plan.gate.reasons.includes('R8_LANGUAGE_MISMATCH'));
    assert.equal(translatedIndex(json), -1);
    assert.equal(json.stage_status.translate, 'disabled');
  });

  test('the fixture corpus, read through the real SQL function, is balanced, so nothing is translated', async () => {
    installShares('database');
    const { status, json } = await postEval({ query: QUESTION_EN });
    assert.equal(status, 200);

    assert.equal(rpcCalls.length, 1);
    assert.ok(json.query_plan);
    assert.ok(!(json.query_plan.skipped ?? []).some((entry) => entry.transform === 'translate'), 'the shares were readable');
    assert.equal(translatedIndex(json), -1);
    assert.equal(fake.calls.filter((call) => call.transform === 'translate').length, 0);
  });

  test('with the layer off the same questions return the Phase 4 result, whatever RAG_QUERY_TRANSLATE says', async () => {
    installShares({ zh: 0.85, en: 0.1, it: 0.05 });
    for (const question of [QUESTION_EN, QUESTION_IT]) {
      const translateOn = await withEnv({ RAG_QUERY_LAYER: 'false', RAG_QUERY_TRANSLATE: 'true' }, () => postEval({ query: question }));
      const translateOff = await withEnv({ RAG_QUERY_LAYER: 'false', RAG_QUERY_TRANSLATE: 'false' }, () => postEval({ query: question }));
      assert.equal(translateOn.status, 200);
      assert.equal(translateOn.json.query_plan, null);
      assert.equal(translateOn.json.stage_status.query_gate, undefined);
      assert.equal(translateOn.json.stage_status.translate, translateOff.json.stage_status.translate);
      assert.deepEqual(
        translateOn.json.candidates.map((row) => [row.chunk_id, row.legs]),
        translateOff.json.candidates.map((row) => [row.chunk_id, row.legs]),
      );
      assert.deepEqual(
        translateOn.json.kept.map((row) => row.chunk_id),
        translateOff.json.kept.map((row) => row.chunk_id),
      );
    }
    assert.equal(rpcCalls.length, 0, 'no shares are read with the layer off');
    assert.equal(fake.calls.length, 0);
  });
});
