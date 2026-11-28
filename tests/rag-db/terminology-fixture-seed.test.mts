import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import { prepareInProcessEval, type InProcessEval } from '../../eval/harness/run-eval.mts';
import { CORPUS_LANGUAGES, loadCorpus } from '../../eval/harness/corpus.mts';
import type { DeploymentMode, FixtureMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
/** The ingest builds run on the small synthetic corpus: seeding does not depend on the corpus, and the full ingest is the smoke tier's job. */
const SMALL_CORPUS_DIR = path.join(REPO_ROOT, 'tests/fixtures/terminology-corpus');
const DICTIONARY_PATH = path.join(REPO_ROOT, 'eval/fixtures/terminology/dictionary.jsonl');
const SYNTHETIC_DOC = /(^|\/)synthetic-terms\.[a-z-]+\.md$/;
const ROUTE_PATH = '/api/internal/rag/run';

interface DictionaryRow {
  canonical: string;
  variants: string[];
  language: string;
  kind: string;
  mode: string;
  source_language?: string | null;
  target_language?: string | null;
}

function readDictionary(): DictionaryRow[] {
  return fs
    .readFileSync(DICTIONARY_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as DictionaryRow);
}

const ROWS = readDictionary();
const LANGUAGE_ENV = { RAG_SUPPORTED_LANGUAGES: CORPUS_LANGUAGES.join(','), RAG_PRIMARY_LANGUAGE: CORPUS_LANGUAGES[0] };

async function sharedLayerState(prepared: InProcessEval): Promise<{ version: number | null; entries: number }> {
  const layer = await prepared.fixtureDb.query<{ version: number }>("SELECT version FROM public.rag_term_layers WHERE layer_key = 'shared'");
  const entries = await prepared.fixtureDb.query<{ n: number }>("SELECT count(*)::int AS n FROM public.rag_term_entries WHERE layer_key = 'shared'");
  return { version: layer.rows[0] ? Number(layer.rows[0].version) : null, entries: Number(entries.rows[0]?.n ?? 0) };
}

describe('the fixture dictionary file (D-27, D-32, D-37)', () => {
  test('every line parses as a TerminologyImportRow and validateEntries reports no error for the harness languages', async () => {
    const { TerminologyImportRowSchema, TerminologyEntrySchema } = await import('../../src/lib/rag-eval/contracts.generated.ts');
    const { validateEntries } = await import('../../src/lib/rag/terminology/validate.ts');
    assert.ok(ROWS.length > 0);
    const entries = ROWS.map((row, index) => {
      const parsed = TerminologyImportRowSchema.parse(row);
      return TerminologyEntrySchema.parse({ ...parsed, layer: 'shared', id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}` });
    });
    const issues = validateEntries(entries, { layer: 'shared', current: [], enabledLanguages: CORPUS_LANGUAGES });
    assert.deepEqual(issues.filter((issue) => issue.severity === 'error'), []);
  });

  test('per harness language: at least 4 answerable entries and 1 identifier alias, plus a translation pair between two harness languages', () => {
    for (const language of CORPUS_LANGUAGES) {
      const own = ROWS.filter((row) => row.language === language);
      assert.ok(own.filter((row) => row.kind !== 'identifier' && row.kind !== 'translation').length >= 4, `${language}: answerable entries`);
      assert.ok(own.filter((row) => row.kind === 'identifier').length >= 1, `${language}: identifier alias`);
    }
    const pairs = ROWS.filter((row) => row.kind === 'translation');
    assert.ok(pairs.length >= 1, 'a translation pair');
    for (const pair of pairs) {
      assert.ok(CORPUS_LANGUAGES.includes(pair.source_language as never) && CORPUS_LANGUAGES.includes(pair.target_language as never));
      assert.notEqual(pair.source_language, pair.target_language);
    }
  });

  test('no variant shares a lexical token with any chunk of the fixture corpus, synthetic documents included', async () => {
    const { lexicalTokens, queryLexicalTokens } = await import('../../src/lib/rag/lexical/tokenize.ts');
    const corpus = loadCorpus(CORPUS_DIR);
    const corpusTokens = new Set(corpus.documents.flatMap((doc) => doc.chunks.flatMap((chunk) => lexicalTokens(chunk.stored))));
    for (const row of ROWS) {
      for (const variant of row.variants) {
        const shared = queryLexicalTokens(variant).filter((token) => corpusTokens.has(token));
        assert.deepEqual(shared, [], `variant ${variant} shares ${shared.join(', ')} with the corpus`);
      }
    }
  });

  test('every canonical occurs in exactly one synthetic document and in no other fixture document', () => {
    const corpus = loadCorpus(CORPUS_DIR);
    const synthetic = corpus.documents.filter((doc) => SYNTHETIC_DOC.test(doc.relpath));
    assert.deepEqual(
      synthetic.map((doc) => doc.language).sort(),
      [...CORPUS_LANGUAGES].sort(),
      'one synthetic document per harness language',
    );
    for (const row of ROWS) {
      const holders = corpus.documents.filter((doc) => doc.content.includes(row.canonical));
      assert.equal(holders.length, 1, `canonical ${row.canonical}: ${holders.map((doc) => doc.relpath).join(', ')}`);
      assert.ok(SYNTHETIC_DOC.test(holders[0]!.relpath), `canonical ${row.canonical} lives outside a synthetic document`);
    }
  });
});

// The app modules bind to the first session's edge when they are imported, so the one block that posts requests runs first.
describe('the translation pair is stored and never matched (D-32)', () => {
  let prepared: InProcessEval;

  async function postEval(query: string, itemId: string) {
    const req = new NextRequest(`http://localhost${ROUTE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rag-eval-secret': prepared.secret },
      body: JSON.stringify({ schema_version: 1, query, item_id: itemId, rag_mode: 'strict', options: {} }),
    });
    const res = await prepared.POST(req);
    const json = (await res.json()) as { stage_status: Record<string, string>; stage_counts?: Record<string, Record<string, number>> };
    assert.equal(res.status, 200, JSON.stringify(json).slice(0, 500));
    return json;
  }

  async function withTerminologyOn<T>(fn: () => Promise<T>): Promise<T> {
    const deps = await import('../../src/lib/rag/deps.ts');
    const previous = deps.getRagDeps().ragEnv;
    deps.setRagDepsForTests({ ragEnv: () => ({ ...previous(), RAG_TERMINOLOGY: 'true' }) });
    try {
      return await fn();
    } finally {
      deps.setRagDepsForTests({ ragEnv: previous });
    }
  }

  before(async () => {
    prepared = await prepareInProcessEval({
      corpusDir: CORPUS_DIR,
      deploymentMode: 'single-tenant',
      // D-36: pipeline and languages set explicitly, never the shipped default.
      envOverrides: { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_TERMINOLOGY: 'false', ...LANGUAGE_ENV },
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

  test('the pair keeps its source and target language in the database', async () => {
    const stored = await prepared.fixtureDb.query<{ canonical: string; source_language: string; target_language: string }>(
      "SELECT canonical, source_language, target_language FROM public.rag_term_entries WHERE kind = 'translation' ORDER BY canonical",
    );
    const expected = ROWS.filter((row) => row.kind === 'translation')
      .map((row) => ({ canonical: row.canonical, source_language: row.source_language, target_language: row.target_language }))
      .sort((a, b) => a.canonical.localeCompare(b.canonical));
    assert.deepEqual(stored.rows.map((row) => ({ ...row })), expected);
  });

  test("a query holding the pair's source term matches nothing, while a same-language variant matches", async () => {
    const pair = ROWS.find((row) => row.kind === 'translation')!;
    const synonym = ROWS.find((row) => row.kind === 'synonym')!;
    const pairRun = await withTerminologyOn(() => postEval(pair.variants[0]!, 'term-seed-translation'));
    assert.equal(pairRun.stage_status.terminology, 'ok');
    assert.equal(pairRun.stage_counts?.terminology?.matches, 0);
    const control = await withTerminologyOn(() => postEval(synonym.variants[0]!, 'term-seed-control'));
    assert.equal(control.stage_status.terminology, 'ok');
    assert.equal(control.stage_counts?.terminology?.matches, 1);
  });
});

const MATRIX: Array<{ fixtureMode: FixtureMode; deploymentMode: DeploymentMode; corpusDir: string }> = [
  { fixtureMode: 'prechunked', deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR },
  { fixtureMode: 'prechunked', deploymentMode: 'multi-tenant', corpusDir: CORPUS_DIR },
  { fixtureMode: 'ingest', deploymentMode: 'single-tenant', corpusDir: SMALL_CORPUS_DIR },
  { fixtureMode: 'ingest', deploymentMode: 'multi-tenant', corpusDir: SMALL_CORPUS_DIR },
];

describe('prepareInProcessEval seeds the fixture dictionary into every fixture database, the switch off (D-27)', () => {
  for (const cell of MATRIX) {
    test(`${cell.fixtureMode}, ${cell.deploymentMode}: shared layer version 1 with one entry per dictionary line`, async () => {
      const prepared = await prepareInProcessEval({
        corpusDir: cell.corpusDir,
        deploymentMode: cell.deploymentMode,
        fixtureMode: cell.fixtureMode,
        envOverrides: { RAG_TERMINOLOGY: 'false' },
      });
      try {
        assert.deepEqual(await sharedLayerState(prepared), { version: 1, entries: ROWS.length });
      } finally {
        await prepared.close();
      }
    });
  }
});
