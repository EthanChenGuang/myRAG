import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';
const CHAT_CONDENSE_TIMEOUT_MS = 600;

interface GoldenItem {
  id: string;
  question: string;
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface TraceBody {
  query_plan: null | {
    standalone: string;
    variants: Array<{ kind: string; text: string }>;
    skipped: Array<{ transform: string; reason: string }>;
  };
  kept: Array<{ content: string }>;
  candidates: Array<{ legs?: Record<string, number> }>;
  stage_status: Record<string, string>;
}

const GOLDEN: Map<string, GoldenItem> = new Map(
  readFileSync(path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GoldenItem)
    .map((item) => [item.id, item]),
);

/** One multi_turn item per fixture language and the cells that identify its gold passage. */
const TIMEOUT_ITEMS: ReadonlyArray<{ id: string; gold: readonly string[] }> = [
  { id: 'en-multi-turn-001', gold: ['XR-5100', 'LV-81-0007'] },
  { id: 'zh-multi-turn-001', gold: ['GT-500', 'GV-44-0016'] },
  { id: 'it-multi-turn-005', gold: ['accessori di consumo', 'coperti'] },
];
const PROTECTED_ITEM = { id: 'en-multi-turn-004', gold: ['DLF-1.3.2'] };

let prepared: InProcessEval;
let depsModule: typeof import('../../src/lib/rag/deps.ts');
let configModule: typeof import('../../src/lib/rag/config.ts');
let fakeModule: typeof import('../../eval/harness/fake-query-llm.mts');

function useScenario(name: string): void {
  const table = fakeModule.applyFakeQueryLlmScenario(fakeModule.loadFakeQueryLlmTable(), name);
  const fake = fakeModule.createFakeQueryLlm({ table });
  depsModule.setRagDepsForTests({ queryLlm: () => fake });
}

async function runItem(id: string): Promise<TraceBody> {
  const item = GOLDEN.get(id);
  assert.ok(item, `golden item ${id}`);
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({
      schema_version: 1,
      rag_mode: 'balanced',
      query: item.question,
      conversation: item.conversation,
      item_id: id,
      options: { stage_timeouts_ms: { condense: CHAT_CONDENSE_TIMEOUT_MS } },
    }),
  });
  const res = await prepared.POST(req);
  assert.equal(res.status, 200);
  return (await res.json()) as TraceBody;
}

function previousUser(id: string): string {
  const turns = GOLDEN.get(id)?.conversation ?? [];
  return [...turns].reverse().find((turn) => turn.role === 'user')?.content ?? '';
}

const keptGold = (trace: TraceBody, gold: readonly string[]) => trace.kept.some((row) => gold.every((cell) => row.content.includes(cell)));

function assertFallbackSearched(trace: TraceBody, id: string, reason: string): void {
  const plan = trace.query_plan;
  assert.ok(plan, 'expected a query_plan');
  assert.ok(plan.skipped.some((entry) => entry.transform === 'condense_history' && entry.reason === reason), JSON.stringify(plan.skipped));
  assert.deepEqual(plan.variants.map((variant) => variant.kind).slice(0, 2), ['original', 'history_fallback']);
  const item = GOLDEN.get(id);
  assert.equal(plan.variants[1]?.text, `${previousUser(id)}\n${item?.question}`);
  const legs = new Set(trace.candidates.flatMap((row) => Object.keys(row.legs ?? {})));
  assert.ok(legs.has('dense:1'), 'the history_fallback variant was searched');
}

before(async () => {
  prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: 'single-tenant',
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_QUERY_LAYER: 'true', RAG_QUERY_HISTORY_FALLBACK: 'true' },
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

after(async () => {
  depsModule?.resetRagDepsForTests();
  await prepared?.close();
});

describe('history_fallback with condense forced to fail (plan 06.2-20, D-23, ROADMAP criterion 5)', () => {
  for (const { id, gold } of TIMEOUT_ITEMS) {
    test(`${id}: condense times out, the fallback variant is searched and the gold passage is kept`, async () => {
      useScenario('condense_timeout');
      const trace = await runItem(id);
      assert.equal(trace.stage_status.condense, 'skipped');
      assertFallbackSearched(trace, id, 'timeout');
      assert.equal(trace.query_plan?.standalone, GOLDEN.get(id)?.question);
      assert.ok(keptGold(trace, gold), `expected the gold passage (${gold.join(', ')}) in kept`);
    });
  }

  test(`${PROTECTED_ITEM.id}: a condense that drops a protected token yields the fallback too`, async () => {
    useScenario('condense_protected_token_lost');
    const trace = await runItem(PROTECTED_ITEM.id);
    assertFallbackSearched(trace, PROTECTED_ITEM.id, 'protected_token_lost');
    assert.ok(keptGold(trace, PROTECTED_ITEM.gold), `expected the gold passage (${PROTECTED_ITEM.gold.join(', ')}) in kept`);
  });

  test('RAG_QUERY_HISTORY_FALLBACK=false: the same follow-ups search the original only (difference recorded)', async () => {
    const previous = process.env.RAG_QUERY_HISTORY_FALLBACK;
    process.env.RAG_QUERY_HISTORY_FALLBACK = 'false';
    configModule.resetRagConfigForTests();
    const recorded: Array<{ id: string; goldKept: boolean }> = [];
    try {
      useScenario('condense_timeout');
      for (const { id, gold } of TIMEOUT_ITEMS) {
        const trace = await runItem(id);
        assert.deepEqual(trace.query_plan?.variants.map((variant) => variant.kind), ['original']);
        assert.ok(trace.query_plan?.skipped.some((entry) => entry.transform === 'condense_history' && entry.reason === 'timeout'));
        recorded.push({ id, goldKept: keptGold(trace, gold) });
      }
    } finally {
      if (previous === undefined) delete process.env.RAG_QUERY_HISTORY_FALLBACK;
      else process.env.RAG_QUERY_HISTORY_FALLBACK = previous;
      configModule.resetRagConfigForTests();
    }
    console.log('[History Fallback] switch off, gold kept per item:', JSON.stringify(recorded));
  });
});
