import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const ROUTE_PATH = '/api/internal/rag/run';

const LEGACY_STAGE_NAMES = ['analyze', 'legacy_rank', 'post_filter', 'exact_id_lookup'] as const;

interface TraceBody {
  kept: Array<{ chunk_id: string; content: string }>;
  stage_status: Record<string, string>;
  candidates: Array<{ chunk_id: string; content: string }>;
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
    assert.ok(json.kept.length >= 1, 'expected at least one kept chunk');
    const kept = json.kept.some((row) => row.content.includes('LV-RC-0030'));
    assert.ok(kept, 'expected chunk mentioning LV-RC-0030 in kept');
    assert.equal(json.stage_status.embed, 'ok');
    assert.equal(json.stage_status.search, 'ok');
    assert.equal(json.stage_status.fuse, 'ok');
    assert.equal(json.stage_status.rerank, 'disabled');
    for (const name of LEGACY_STAGE_NAMES) {
      assert.equal(json.stage_status[name], undefined, `legacy stage ${name} should not run under v2`);
    }
  });
});