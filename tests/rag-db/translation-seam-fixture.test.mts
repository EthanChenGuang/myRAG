import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, shouldInstallFixtureTranslator, type InProcessEval } from '../../eval/harness/run-eval.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const ROUTE_PATH = '/api/internal/rag/run';
const ITEM_ID = 'xl-en-it-03';
const GOLD_QUOTE = 'Sono esclusi i danni da caduta';

interface Candidate {
  chunk_id: string;
  content: string;
  legs?: Record<string, number>;
  language?: string | null;
}

interface TraceBody {
  candidates: Candidate[];
  stage_status: Record<string, string>;
}

function question(): string {
  const line = fs
    .readFileSync(GOLDEN_PATH, 'utf8')
    .split('\n')
    .find((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return false;
      return (JSON.parse(trimmed) as { id: string }).id === ITEM_ID;
    });
  assert.ok(line, 'golden item exists');
  return (JSON.parse(line) as { question: string }).question;
}

describe('which run configs install the fixture translator', () => {
  test('only a v2 run with RAG_LEXICAL_TRANSLATION on installs it', () => {
    assert.equal(shouldInstallFixtureTranslator({ RAG_PIPELINE: 'v2', RAG_LEXICAL_TRANSLATION: 'true' }), true);
    assert.equal(shouldInstallFixtureTranslator({ RAG_PIPELINE: 'v2', RAG_LEXICAL_TRANSLATION: ' TRUE ' }), true);
    assert.equal(shouldInstallFixtureTranslator({ RAG_PIPELINE: 'v2' }), false);
    assert.equal(shouldInstallFixtureTranslator({ RAG_PIPELINE: 'v2', RAG_LEXICAL_TRANSLATION: 'false' }), false);
    assert.equal(shouldInstallFixtureTranslator({ RAG_PIPELINE: 'legacy', RAG_LEXICAL_TRANSLATION: 'true' }), false);
    assert.equal(shouldInstallFixtureTranslator({ RAG_LEXICAL_TRANSLATION: 'true' }), false);
    assert.equal(shouldInstallFixtureTranslator(undefined), false);
  });
});

describe('English question about an Italian-only document', () => {
  let prepared: InProcessEval;

  before(async () => {
    prepared = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'single-tenant',
      envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_LEXICAL_TRANSLATION: 'true' },
    });
    const { resetRetrievalBackendForTests } = await import('../../src/lib/rag/backend/registry.ts');
    const { verifyV2Startup, resetV2StartupForTests } = await import('../../src/lib/rag/v2/startup.ts');
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    await verifyV2Startup();
  });

  after(async () => {
    await prepared?.close();
    const { getTranslator } = await import('../../src/lib/rag/query/translate.ts');
    assert.equal(getTranslator().name, 'none', 'closing the session removes the fixture translator');
  });

  test('the harness installs the fixture translator', async () => {
    const { getTranslator } = await import('../../src/lib/rag/query/translate.ts');
    assert.equal(getTranslator().name, 'fixture');
  });

  test('the Italian gold chunk is found on the lexical leg of the translated variant', async () => {
    const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
      body: JSON.stringify({ schema_version: 1, query: question(), item_id: ITEM_ID, rag_mode: 'strict', options: {} }),
    });
    const res = await prepared.POST(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as TraceBody;
    assert.equal(body.stage_status.translate, 'ok');
    const gold = body.candidates.find((candidate) => candidate.content.includes(GOLD_QUOTE));
    assert.ok(gold, 'the Italian gold chunk is a candidate');
    const legs = Object.keys(gold.legs ?? {});
    assert.ok(legs.includes('lexical:1'), `expected lexical:1 among ${legs.join(', ')}`);
    const translatedLexical = body.candidates.filter((candidate) => Object.keys(candidate.legs ?? {}).includes('lexical:1'));
    assert.ok(translatedLexical.length > 0);
    for (const candidate of translatedLexical) assert.equal(candidate.language, 'it', 'the translated lexical leg is restricted to Italian');
  });
});
