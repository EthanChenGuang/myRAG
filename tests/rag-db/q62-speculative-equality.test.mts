import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { GoldenItemSchema, type GoldenItem } from '../../src/lib/rag-eval/contracts.generated.ts';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const ROUTE_PATH = '/api/internal/rag/run';

interface Trace {
  item_id: string;
  query_plan: null | { variants?: Array<{ kind: string }> };
  candidates: Array<{ chunk_id: string; fused_score: number | null; legs?: Record<string, number> }>;
  kept: Array<{ chunk_id: string }>;
  refused: boolean;
  stage_status: Record<string, string>;
  speculative?: { started_ms: number; overlap_ms: number; cancelled_by_cache: boolean; wasted_searches: number };
}

let prepared: InProcessEval;
let depsModule: typeof import('../../src/lib/rag/deps.ts');
let configModule: typeof import('../../src/lib/rag/config.ts');
let fakeModule: typeof import('../../eval/harness/fake-query-llm.mts');
const savedSwitch = process.env.RAG_SPECULATIVE_RETRIEVAL;

function golden(): GoldenItem[] {
  return fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => GoldenItemSchema.parse(JSON.parse(line)));
}

async function postEval(item: GoldenItem): Promise<Trace> {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({
      schema_version: 1,
      query: item.question,
      conversation: item.conversation,
      rag_mode: 'strict',
      web_search: false,
      options: {},
      item_id: item.id,
    }),
  });
  const res = await prepared.POST(req);
  assert.equal(res.status, 200, `item ${item.id}`);
  return (await res.json()) as Trace;
}

async function runAll(items: GoldenItem[], speculative: boolean): Promise<Map<string, Trace>> {
  process.env.RAG_SPECULATIVE_RETRIEVAL = speculative ? 'true' : 'false';
  configModule.resetRagConfigForTests();
  const out = new Map<string, Trace>();
  for (const item of items) {
    // A fresh fake per item, so scripted delays and call counts never carry over between the two runs.
    const fake = fakeModule.createFakeQueryLlm();
    depsModule.setRagDepsForTests({ queryLlm: () => fake });
    out.set(item.id, await postEval(item));
  }
  return out;
}

function fusedOf(trace: Trace): Array<[string, number | null, Record<string, number> | undefined]> {
  return trace.candidates.map((row) => [row.chunk_id, row.fused_score, row.legs]);
}

let items: GoldenItem[] = [];
let off: Map<string, Trace>;
let on: Map<string, Trace>;

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
  items = golden();
  off = await runAll(items, false);
  on = await runAll(items, true);
});

after(async () => {
  if (savedSwitch === undefined) delete process.env.RAG_SPECULATIVE_RETRIEVAL;
  else process.env.RAG_SPECULATIVE_RETRIEVAL = savedSwitch;
  depsModule?.resetRagDepsForTests();
  await prepared?.close();
});

describe('speculative retrieval changes no fused result on the fixtures (D-21, D-31 f)', () => {
  test('every golden item: fused candidate ids, scores and legs, kept ids and refusal are equal with the switch on and off', () => {
    assert.ok(items.length > 100, `expected the fixture golden set, got ${items.length} items`);
    const differing: string[] = [];
    for (const item of items) {
      const a = off.get(item.id)!;
      const b = on.get(item.id)!;
      try {
        assert.deepEqual(fusedOf(b), fusedOf(a));
        assert.deepEqual(
          b.kept.map((row) => row.chunk_id),
          a.kept.map((row) => row.chunk_id),
        );
        assert.equal(b.refused, a.refused);
        assert.equal(b.stage_status.search, a.stage_status.search);
      } catch {
        differing.push(item.id);
      }
    }
    assert.deepEqual(differing, []);
  });

  test('off carries no speculative field; on, every searched turn carries one with overlap_ms of at least 0', () => {
    let searched = 0;
    let adopted = 0;
    for (const item of items) {
      assert.equal(off.get(item.id)!.speculative, undefined, `off ${item.id}`);
      const trace = on.get(item.id)!;
      if (trace.stage_status.search === undefined) continue;
      searched += 1;
      assert.ok(trace.speculative, `on ${item.id} has a speculative trace`);
      assert.ok(trace.speculative.overlap_ms >= 0);
      assert.ok(trace.speculative.started_ms >= 0);
      assert.equal(trace.speculative.cancelled_by_cache, false);
      if (trace.speculative.wasted_searches === 0) adopted += 1;
    }
    assert.ok(searched > 100, `searched turns ${searched}`);
    // Not vacuous: on most turns the search stage took the speculative legs instead of searching the original again.
    assert.ok(adopted * 2 > searched, `adopted ${adopted} of ${searched}`);
  });
});
