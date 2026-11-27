import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';

const LEGACY_V1_ONLY_STAGES = ['legacy_rank', 'post_filter', 'exact_id_lookup'] as const;

interface TraceBody {
  kept: Array<{ chunk_id: string; content: string }>;
  stage_status: Record<string, string>;
  candidates: Array<{ chunk_id: string; content: string }>;
  refused?: boolean;
  refusal_reason?: string | null;
}

let prepared: InProcessEval;

async function postEval(query: string, itemId: string) {
  const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
    body: JSON.stringify({
      schema_version: 1,
      query,
      item_id: itemId,
      rag_mode: 'strict',
      options: {},
    }),
  });
  const res = await prepared.POST(req);
  return { status: res.status, json: (await res.json()) as TraceBody };
}

before(async () => {
  prepared = await prepareInProcessEval({
    corpusDir: CORPUS_DIR,
    deploymentMode: 'single-tenant',
    envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' },
  });
  const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
  const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
  resetRetrievalBackendForTests();
  resetV2StartupForTests();
  await verifyV2Startup();
});

after(async () => {
  await prepared?.close();
});

describe('v2 tracer through the eval route', () => {
  test('exact_term golden item hybrid retrieval keeps the SKU chunk with v2 stages only', async () => {
    const { status, json } = await postEval('What is SKU LV-RC-0030?', 'en-exact-term-002');
    assert.equal(status, 200);
    assert.ok(json.candidates.length >= 1, 'expected at least one traced candidate');
    const skuChunk = json.candidates.some((row) => row.content.includes('LV-RC-0030'));
    assert.ok(skuChunk, 'expected chunk mentioning LV-RC-0030 in candidates');
    if (json.refused) {
      assert.equal(json.refusal_reason, 'below_similarity_floor');
    }
    assert.equal(json.stage_status.embed, 'ok');
    assert.equal(json.stage_status.search, 'ok');
    assert.equal(json.stage_status.fuse, 'ok');
    assert.equal(json.stage_status.rerank, 'disabled');
    assert.equal(json.stage_status.analyze, 'ok');
    for (const name of LEGACY_V1_ONLY_STAGES) {
      assert.equal(json.stage_status[name], undefined, `v1-only stage ${name} should not run under v2`);
    }
  });

  test('a small documentTokenBudget keeps only the highest-ranked parent and reports the dropped count (D-83)', async () => {
    const { runRetrieval } = await import('../../src/lib/rag/pipeline.ts');
    const { mintScope } = await import('../../src/lib/rag/tenant/scope.ts');
    const { createCitationLabeler } = await import('../../src/lib/rag/generation/citations/blocks.ts');
    const retrieve = (documentTokenBudget?: number) =>
      runRetrieval({
        scope: mintScope('single', null, null),
        query: 'What is SKU LV-RC-0030?',
        profile: 'eval',
        options: { ragMode: 'balanced', ...(documentTokenBudget === undefined ? {} : { documentTokenBudget }) },
        signal: new AbortController().signal,
        citationLabeler: createCitationLabeler(),
      });

    const plain = await retrieve();
    assert.equal(plain.packing, undefined);
    assert.ok(plain.kept.length >= 2, 'expected at least two kept chunks without a budget');

    const roomy = await retrieve(1_000_000);
    assert.deepEqual(
      roomy.kept.map((row) => row.chunk_id),
      plain.kept.map((row) => row.chunk_id),
    );
    assert.equal(roomy.context, plain.context);
    const units = roomy.packing!.keptParents + roomy.packing!.droppedDocuments;

    const tight = await retrieve(1);
    assert.deepEqual(
      tight.kept.map((row) => row.chunk_id),
      [plain.kept[0]!.chunk_id],
    );
    assert.deepEqual(tight.packing, { documentBudget: 1, droppedDocuments: units - 1, keptParents: 1 });
    const cited = new Set((tight.blocks ?? []).filter((block) => block.alias !== null).flatMap((block) => block.chunkIds));
    for (const row of plain.kept.slice(1)) assert.equal(cited.has(row.chunk_id), false, `dropped ${row.chunk_id} must carry no alias`);
  });
});