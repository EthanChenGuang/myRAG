import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCorpus, type CorpusDocument } from '../../eval/harness/corpus.mts';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

// The committed prechunked corpus before plan 04.2-28 (eval/baselines/fixture-baseline.json). Plan 04.2-37 adds the Phase 4.2 fixture
// files and re-records this hash and the two dump digests below together with the baselines.
const COMMITTED_CORPUS_SHA256 = '4d9bd0210cebe95433e3065f19414c92f328f1c9f4530cf437647438b230309b';
const COMMITTED_DUMP_SHA256: Record<DeploymentMode, string> = {
  'single-tenant': '6b56af41c33f75d1f3c2485cbd5b4475a0b57be80614a9421aefbe2b52c94a19',
  'multi-tenant': '43fa4b39ab025122f0d5ae772c315bf4b1077aaa0dadce453a6e07e927bf3e4c',
};
const DUMP_DOCUMENT_COLUMNS =
  'id, filename, content, metadata, status, is_current, version, lineage_id, source, source_key, tenant_key, superseded_by, doc_type, user_id, created_at';
const DUMP_CHUNK_COLUMNS = 'id, document_id, content, embedding::text AS embedding, metadata, is_current, status, version, tenant_key, doc_type, created_at';

const TEMPLATE = [
  '<!-- fixture-meta {"generate": {"count": 30, "name": "copy-{n}.en.md", "substitutions": [["lantern", "lantern"], ["lantern", "beacon"], ["lantern", "signal"]], "template_id": "T"}} -->',
  '## Shared notice',
  '',
  'The lantern panel opens after the second chime.',
  '<!-- chunk -->',
  '## Closing',
  '',
  'The lantern stays lit.',
  '',
].join('\n');
const V1 = [
  '<!-- fixture-meta {"filename": "orbit-notes.en.md", "lineage": "orbit", "version": 1, "created_at": "2025-01-10T00:00:00.000Z"} -->',
  '## Orbit schedule',
  '',
  'The quillstone orbit review happens every nine weeks.',
  '',
].join('\n');
const V2 = [
  '<!-- fixture-meta {"filename": "orbit-notes.en.md", "lineage": "orbit", "version": 2, "created_at": "2025-02-10T00:00:00.000Z"} -->',
  '## Orbit schedule',
  '',
  'The quillstone orbit review happens every four weeks.',
  '',
].join('\n');
const OTHER = '## Gravel paths\n\nThe gravel path is raked each morning.\n';

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempCorpus(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-phase42-'));
  tempDirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

const phase42Corpus = () =>
  makeTempCorpus({ 'en/dup-template.en.md': TEMPLATE, 'en/orbit-v1.en.md': V1, 'en/orbit-v2.en.md': V2, 'en/other.en.md': OTHER });

function pythonCorpus(command: 'dump' | 'sha256', dir: string): string {
  const result = spawnSync('uv', ['run', '--directory', 'eval', 'python', '-m', 'rag_eval.corpus', command, dir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function tsDump(documents: CorpusDocument[]) {
  return documents.map((doc) => ({
    relpath: doc.relpath,
    filename: doc.filename,
    language: doc.language,
    doc_type: doc.docType,
    chunks: doc.chunks.map((chunk) => ({ index: chunk.index, section: chunk.section, text: chunk.text, stored: chunk.stored })),
    ...(doc.fixtureDupTemplate !== undefined ? { fixture_dup_template: doc.fixtureDupTemplate } : {}),
    ...(doc.lineage ? { lineage: doc.lineage.id, version: doc.lineage.version } : {}),
  }));
}

async function stableDump(fixture: FixtureDatabase): Promise<string> {
  const documents = await fixture.db.query(`SELECT ${DUMP_DOCUMENT_COLUMNS} FROM documents ORDER BY id`);
  const chunks = await fixture.db.query(`SELECT ${DUMP_CHUNK_COLUMNS} FROM document_chunks ORDER BY id`);
  const vectors = await fixture.db.query('SELECT chunk_id, profile_id FROM chunk_embeddings ORDER BY chunk_id, profile_id');
  return crypto.createHash('sha256').update(JSON.stringify({ d: documents.rows, c: chunks.rows, e: vectors.rows })).digest('hex');
}

describe('corpus loaders on a Phase 4.2 corpus', () => {
  test('TypeScript and Python expand the template and read the lineage identically', () => {
    const dir = phase42Corpus();
    const loaded = loadCorpus(dir);
    const python = JSON.parse(pythonCorpus('dump', dir)) as unknown[];
    const fromTs = tsDump(loaded.documents);
    const firstDiff = fromTs.findIndex((doc, index) => JSON.stringify(doc) !== JSON.stringify(python[index]));
    assert.equal(firstDiff, -1, `first differing document: ${JSON.stringify(fromTs[firstDiff])} vs ${JSON.stringify(python[firstDiff])}`);
    assert.equal(fromTs.length, python.length);
    assert.equal(loaded.documents.length, 33);
    assert.equal(pythonCorpus('sha256', dir).trim(), loaded.corpusSha256);
  });

  test('the committed corpus loads unchanged, with the same hash in both loaders', () => {
    const loaded = loadCorpus(REAL_CORPUS);
    assert.equal(loaded.corpusSha256, COMMITTED_CORPUS_SHA256);
    assert.equal(pythonCorpus('sha256', REAL_CORPUS).trim(), COMMITTED_CORPUS_SHA256);
    assert.ok(loaded.documents.every((doc) => doc.fixtureDupTemplate === undefined && doc.lineage === undefined));
  });
});

for (const mode of MODES) {
  describe(`fixture database seeding (${mode})`, () => {
    test('the earlier version of a lineage is superseded and ready without vectors; generated copies are current', async () => {
      const dir = phase42Corpus();
      const corpus = loadCorpus(dir);
      const v1 = corpus.documents.find((doc) => doc.relpath === 'en/orbit-v1.en.md')!;
      const v2 = corpus.documents.find((doc) => doc.relpath === 'en/orbit-v2.en.md')!;
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: dir });
      try {
        const versions = await fixture.db.query<Record<string, unknown>>(
          'SELECT id, is_current, status, version, superseded_by, lineage_id, source, source_key, tenant_key FROM documents WHERE id = ANY($1::uuid[]) ORDER BY version',
          [[v1.id, v2.id]],
        );
        assert.equal(versions.rows.length, 2);
        const [old, current] = versions.rows;
        assert.deepEqual(
          { id: old.id, is_current: old.is_current, status: old.status, version: old.version, superseded_by: old.superseded_by },
          { id: v1.id, is_current: false, status: 'ready', version: 1, superseded_by: v2.id },
          `version 1 row: ${JSON.stringify(old)}`,
        );
        assert.deepEqual(
          { id: current.id, is_current: current.is_current, status: current.status, version: current.version, superseded_by: current.superseded_by },
          { id: v2.id, is_current: true, status: 'ready', version: 2, superseded_by: null },
          `version 2 row: ${JSON.stringify(current)}`,
        );
        assert.equal(old.lineage_id, current.lineage_id);
        assert.equal(old.source, current.source);
        assert.equal(old.source_key, current.source_key);
        assert.equal(old.tenant_key, current.tenant_key);

        const oldChunks = await fixture.db.query<{ is_current: boolean; status: string; has_vector: boolean; lexical: string | null; profiles: number }>(
          `SELECT c.is_current, c.status, c.embedding IS NOT NULL AS has_vector, c.lexical_text AS lexical,
                  (SELECT count(*)::int FROM chunk_embeddings ce WHERE ce.chunk_id = c.id) AS profiles
           FROM document_chunks c WHERE c.document_id = $1`,
          [v1.id],
        );
        assert.equal(oldChunks.rows.length, v1.chunks.length);
        for (const chunk of oldChunks.rows) {
          assert.equal(chunk.is_current, false);
          assert.equal(chunk.status, 'ready');
          assert.equal(chunk.has_vector, false);
          assert.equal(chunk.profiles, 0);
          assert.ok(chunk.lexical && chunk.lexical.includes('quillstone'), `lexical text: ${String(chunk.lexical)}`);
        }
        const currentChunks = await fixture.db.query<{ is_current: boolean; has_vector: boolean }>(
          'SELECT is_current, embedding IS NOT NULL AS has_vector FROM document_chunks WHERE document_id = $1',
          [v2.id],
        );
        assert.ok(currentChunks.rows.length > 0 && currentChunks.rows.every((chunk) => chunk.is_current && chunk.has_vector));

        const copies = await fixture.db.query<{ is_current: boolean; status: string; template: string | null }>(
          "SELECT is_current, status, metadata->>'fixture_dup_template' AS template FROM documents WHERE filename LIKE 'copy-%'",
        );
        assert.equal(copies.rows.length, 30);
        assert.ok(copies.rows.every((row) => row.is_current && row.status === 'ready' && row.template === 'T'));
        const plain = await fixture.db.query<{ metadata: Record<string, unknown> }>("SELECT metadata FROM documents WHERE filename = 'other.en.md'");
        assert.equal(plain.rows[0].metadata.fixture_dup_template, undefined);
      } finally {
        await fixture.db.close();
      }
    });

    test('the eval route with every Phase 4.2 switch off never returns a version 1 chunk', async () => {
      const dir = phase42Corpus();
      const corpus = loadCorpus(dir);
      const v1 = corpus.documents.find((doc) => doc.relpath === 'en/orbit-v1.en.md')!;
      const v2 = corpus.documents.find((doc) => doc.relpath === 'en/orbit-v2.en.md')!;
      const work = makeTempCorpus({});
      const golden = path.join(work, 'golden.jsonl');
      const item = {
        answerable: true,
        category: 'general',
        conversation: [],
        evidence_language: null,
        expected_answer: 'The quillstone orbit review happens every four weeks.',
        gold_evidence: [{ document: 'orbit-notes.en.md', quote: 'The quillstone orbit review happens every four weeks.', section: 'Orbit schedule' }],
        id: 'en-general-001',
        language: 'en',
        provenance: 'synthetic_fixture',
        question: 'How often does the quillstone orbit review happen?',
        review_status: 'approved',
        split: 'dev',
      };
      fs.writeFileSync(golden, `${JSON.stringify(item)}\n`);
      // A child process per mode: the app reads the deployment mode once at import, so two modes cannot share one module graph.
      const script = [
        "const { runEval } = await import('./eval/harness/run-eval.mts');",
        'const [golden, corpus, out, mode] = process.argv.slice(1);',
        'const result = await runEval({ goldenPath: golden, corpusDir: corpus, outDir: out, deploymentMode: mode });',
        'console.log(JSON.stringify({ tracesPath: result.tracesPath, edgeErrors: result.edgeErrors }));',
      ].join('\n');
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, golden, dir, path.join(work, 'out'), mode], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim().split('\n').pop() as string) as { tracesPath: string; edgeErrors: number };
      assert.equal(result.edgeErrors, 0);
      const traces = fs
        .readFileSync(result.tracesPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { candidates: { chunk_id: string }[]; kept: { chunk_id: string }[] });
      assert.equal(traces.length, 1);
      const oldIds = new Set(v1.chunks.map((chunk) => chunk.id));
      const returned = [...traces[0].candidates, ...traces[0].kept].map((chunk) => chunk.chunk_id);
      assert.ok(returned.some((id) => v2.chunks.some((chunk) => chunk.id === id)), `version 2 not retrieved: ${JSON.stringify(returned)}`);
      assert.deepEqual(returned.filter((id) => oldIds.has(id)), []);
    });

    test('the committed corpus builds the same database and the same inputs hash as before', async () => {
      const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      try {
        assert.equal(fixture.corpusSha256, COMMITTED_CORPUS_SHA256);
        const setupSql = mode === 'single-tenant' ? 'supabase/single-tenant-setup.sql' : 'supabase/multi-tenant-setup.sql';
        const keys = Object.keys(fixture.sqlSha256).sort();
        assert.equal(keys.length, 2, JSON.stringify(keys));
        assert.equal(keys[1], setupSql);
        assert.match(keys[0], /^lexical_version:\d+$/);
        assert.equal(await stableDump(fixture), COMMITTED_DUMP_SHA256[mode]);
      } finally {
        await fixture.db.close();
      }
    });
  });
}
