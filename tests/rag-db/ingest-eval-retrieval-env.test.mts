import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const CORPUS_DIR = path.join(process.cwd(), 'eval/fixtures/corpus');

describe('ingest-mode eval retrieval env', () => {
  let close: (() => Promise<void>) | undefined;

  before(async () => {
    const { prepareInProcessEval } = await import('../../eval/harness/run-eval.mts');
    const prepared = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'single-tenant',
      fixtureMode: 'ingest',
    });
    close = prepared.close;
  });

  after(async () => {
    await close?.();
  });

  test('keeps RAG_EXACT_ID_LOOKUP on for retrieval so ingest smoke matches its baseline', async () => {
    const { getRagDeps } = await import('../../src/lib/rag/deps.ts');
    const { loadRagConfig } = await import('../../src/lib/rag/config.ts');
    assert.equal(getRagDeps().ragEnv().RAG_EXACT_ID_LOOKUP, 'true');
    assert.equal(loadRagConfig(getRagDeps().ragEnv()).exactIdLookup, true);
  });
});