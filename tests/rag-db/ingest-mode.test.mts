import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCorpus, type LoadedCorpus } from '../../eval/harness/corpus.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { buildIngestFixtureDatabase, ingestModeGoldenPaths, mergeGoldenFiles } from '../../eval/harness/ingest-mode.mts';
import { fixtureEntry } from '../helpers/fake-sidecar.ts';

const CORPUS_DIR = path.join(process.cwd(), 'eval/fixtures/corpus');
const MARKER = '<!-- chunk -->';
const META = 'fixture-meta';

type Row = Record<string, unknown>;

/** The matcher's normalisation (eval/src/rag_eval/matching.py): NFKC, case-folded, no whitespace and no punctuation. */
function normalize(text: string): string {
  return Array.from(text.normalize('NFKC').toLowerCase())
    .filter((char) => !/[\s\p{P}]/u.test(char))
    .join('');
}

interface GoldSpan {
  document: string;
  quote: string;
}

function goldSpans(): Array<{ id: string; span: GoldSpan }> {
  const spans: Array<{ id: string; span: GoldSpan }> = [];
  for (const line of fs.readFileSync(path.join(process.cwd(), 'eval/fixtures/golden.jsonl'), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const item = JSON.parse(line) as { id: string; review_status: string; gold_evidence: GoldSpan[] };
    if (item.review_status !== 'approved') continue;
    for (const span of item.gold_evidence) spans.push({ id: item.id, span });
  }
  return spans;
}

describe('ingest fixture mode: the corpus goes through the real ingest()', () => {
  let corpus: LoadedCorpus;
  let fixture: FixtureDatabase;

  before(async () => {
    corpus = loadCorpus(CORPUS_DIR);
    fixture = await buildIngestFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR });
  });

  after(async () => {
    await fixture?.edge?.close();
    await fixture?.db.close();
  });

  const corpusFilenames = () => corpus.documents.map((doc) => doc.filename);

  test('every corpus document is a ready, current config_upload document of the fixture tenant', async () => {
    const { rows } = await fixture.db.query<Row>(
      'SELECT filename, status, is_current, source, tenant_key, version FROM documents WHERE filename = ANY($1::text[]) ORDER BY filename',
      [corpusFilenames()],
    );
    assert.deepEqual(
      rows.map((row) => row.filename),
      corpusFilenames().sort(),
    );
    for (const row of rows) {
      assert.equal(row.status, 'ready', `${String(row.filename)} status`);
      assert.equal(row.is_current, true, `${String(row.filename)} is_current`);
      assert.equal(row.source, 'config_upload', `${String(row.filename)} source`);
      assert.equal(row.tenant_key, 's:default', `${String(row.filename)} tenant_key`);
      assert.equal(row.version, 1, `${String(row.filename)} version`);
    }
  });

  test('the chunks are written by the unified writer: plain content, hashes, parser and a vector', async () => {
    const { rows } = await fixture.db.query<Row>(
      `SELECT c.content, c.content_hash, c.parser_used, c.status, c.is_current, (c.embedding IS NOT NULL) AS has_vector
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.filename = ANY($1::text[])`,
      [corpusFilenames()],
    );
    assert.ok(rows.length >= corpus.documents.length, `expected at least one chunk per document, got ${rows.length}`);
    const prefixed = rows.filter((row) => String(row.content).startsWith('Document: '));
    assert.equal(prefixed.length, 0, 'ingest mode must not store the prechunked Document: prefix');
    for (const row of rows) {
      assert.ok(row.content_hash, 'every chunk has a content hash');
      assert.equal(row.parser_used, 'text');
      assert.equal(row.status, 'ready');
      assert.equal(row.is_current, true);
      assert.equal(row.has_vector, true);
    }
  });

  test('no chunk marker and no fixture-meta line reaches a chunk, a lexical text, a document or a hash', async () => {
    const chunks = await fixture.db.query<Row>(
      `SELECT c.content, c.lexical_text, c.metadata::text AS metadata
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.filename = ANY($1::text[])`,
      [corpusFilenames()],
    );
    assert.ok(chunks.rows.length > 0, 'there are chunks to inspect');
    for (const row of chunks.rows) {
      for (const field of ['content', 'lexical_text', 'metadata'] as const) {
        const text = String(row[field] ?? '');
        assert.ok(!text.includes(MARKER), `${field} holds a chunk marker: ${text.slice(0, 80)}`);
        assert.ok(!text.includes(META), `${field} holds the fixture-meta line: ${text.slice(0, 80)}`);
      }
    }
    const documents = await fixture.db.query<Row>(
      'SELECT filename, content, metadata::text AS metadata, content_hash FROM documents WHERE filename = ANY($1::text[])',
      [corpusFilenames()],
    );
    assert.equal(documents.rows.length, corpus.documents.length, 'every corpus document is there to inspect');
    const { contentHash } = await import('@/lib/rag/ingest/hash');
    for (const row of documents.rows) {
      assert.ok(!String(row.content ?? '').includes(MARKER), `${String(row.filename)} content holds a marker`);
      assert.ok(!String(row.metadata ?? '').includes(META), `${String(row.filename)} metadata holds fixture-meta`);
      const source = corpus.documents.find((doc) => doc.filename === row.filename);
      assert.ok(source, `${String(row.filename)} is a corpus document`);
      assert.equal(row.content_hash, contentHash(source.content), `${String(row.filename)} was hashed over the stripped text`);
    }
    const stripped = corpus.documents.filter((doc) => fs.readFileSync(path.join(CORPUS_DIR, doc.relpath), 'utf8').includes(META));
    assert.ok(stripped.length >= 1, 'the corpus has a document with a fixture-meta line, so the check above is not vacuous');
  });

  test('documents.content holds the parsed text of every document, the text the chunker consumed', async () => {
    const { rows } = await fixture.db.query<Row>('SELECT filename, content FROM documents WHERE filename = ANY($1::text[])', [corpusFilenames()]);
    assert.equal(rows.length, corpus.documents.length, 'every corpus document is there to inspect');
    for (const row of rows) {
      const source = corpus.documents.find((doc) => doc.filename === row.filename);
      assert.ok(source, `${String(row.filename)} is a corpus document`);
      assert.equal(row.content, source.content, `${String(row.filename)} content`);
    }
  });

  test('every gold quote of the fixture golden set lies inside a single chunk of its document', async () => {
    const { rows } = await fixture.db.query<Row>(
      'SELECT d.filename AS filename, c.content AS content FROM document_chunks c JOIN documents d ON d.id = c.document_id',
    );
    const byDocument = new Map<string, string[]>();
    for (const row of rows) {
      const key = String(row.filename).toLowerCase();
      byDocument.set(key, [...(byDocument.get(key) ?? []), normalize(String(row.content))]);
    }
    const spans = goldSpans();
    assert.ok(spans.length >= 100, `expected the golden set's spans, got ${spans.length}`);
    const missing = spans
      .filter(({ span }) => !(byDocument.get(span.document.toLowerCase()) ?? []).some((chunk) => chunk.includes(normalize(span.quote))))
      .map(({ id, span }) => `${id} (${span.document}): ${span.quote}`);
    assert.deepEqual(missing, [], `${missing.length} gold quote(s) are not inside one chunk:\n${missing.join('\n')}`);
  });

  test('the corpus hash of the ingest mode differs from the prechunked one, so the two baselines cannot be mixed up', () => {
    assert.notEqual(fixture.corpusSha256, corpus.corpusSha256);
    assert.match(fixture.corpusSha256, /^[0-9a-f]{64}$/);
  });

  test('the ingest-mode build served recorded PDFs through the fake sidecar and left LlamaParse unconfigured', async () => {
    const { getLlamaParseParser } = await import('@/lib/rag/ingest/parsers/llamaparse-v2');
    assert.equal(fixture.ingestLlamaParseAttempts, 0);
    const upload = fixture.ingestSidecarUploads?.find((row) => row.fileSha256 === fixtureEntry('report-zh-table').file_sha256);
    assert.ok(upload, 'report-zh-table reached the fake sidecar');
    const doc = await fixture.db.query<Row>('SELECT parser_used, status FROM documents WHERE filename = $1', ['report-zh-table.pdf']);
    assert.equal(doc.rows[0]?.parser_used, 'docling');
    assert.equal(doc.rows[0]?.status, 'ready');
    assert.ok(process.env.LLAMA_CLOUD_API_KEY === '' || process.env.LLAMA_CLOUD_API_KEY === undefined, 'empty LlamaParse key in harness');
  });
});

describe('ingest fixture mode: the default and the golden file list', () => {
  test('createFixtureDatabase without a fixture mode still inserts the pre-cut rows with their Document: prefix', async () => {
    const corpus = loadCorpus(CORPUS_DIR);
    const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR });
    try {
      assert.equal(fixture.edge, undefined);
      assert.equal(fixture.corpusSha256, corpus.corpusSha256);
      const { rows } = await fixture.db.query<Row>('SELECT id, content FROM document_chunks ORDER BY id');
      assert.deepEqual(
        rows.map((row) => row.id),
        corpus.documents.flatMap((doc) => doc.chunks.map((chunk) => chunk.id)).sort(),
      );
      assert.ok(rows.every((row) => String(row.content).startsWith('Document: ')));
    } finally {
      await fixture.db.close();
    }
  });

  test('createFixtureDatabase rejects an unknown fixture mode', async () => {
    await assert.rejects(
      () => createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR, fixtureMode: 'nope' as never }),
      /unsupported fixture mode/,
    );
  });

  test('ingestModeGoldenPaths lists the repo-relative golden files, starting with the shared fixture set', () => {
    const paths = ingestModeGoldenPaths();
    assert.equal(paths[0], 'eval/fixtures/golden.jsonl');
    assert.equal(paths[1], 'eval/fixtures/ingest/golden-ingest.jsonl');
    for (const relative of paths) {
      assert.ok(!path.isAbsolute(relative), `${relative} is repo-relative`);
      assert.ok(fs.existsSync(path.join(process.cwd(), relative)), `${relative} exists`);
    }
  });

  test('mergeGoldenFiles returns a single file unchanged and concatenates several in order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-golden-'));
    try {
      const a = path.join(dir, 'a.jsonl');
      const b = path.join(dir, 'b.jsonl');
      fs.writeFileSync(a, '{"id":"a1"}\n{"id":"a2"}\n');
      fs.writeFileSync(b, '{"id":"b1"}');
      assert.equal(mergeGoldenFiles([a], path.join(dir, 'out.jsonl')), a);
      const merged = mergeGoldenFiles([a, b], path.join(dir, 'out.jsonl'));
      assert.equal(merged, path.join(dir, 'out.jsonl'));
      assert.equal(fs.readFileSync(merged, 'utf8'), '{"id":"a1"}\n{"id":"a2"}\n{"id":"b1"}\n');
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(merged)).digest('hex').length, 64);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
