import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadCorpus, type LoadedCorpus } from '../../eval/harness/corpus.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { buildIngestFixtureDatabase, ingestModeGoldenPaths, isPrechunkedOnlyDocument, mergeGoldenFiles } from '../../eval/harness/ingest-mode.mts';
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

  /** The corpus documents ingest() writes; the sec-attacks documents are written pre-chunked (D-13). */
  const ingestedDocuments = () => corpus.documents.filter((doc) => !isPrechunkedOnlyDocument(doc.relpath));
  const corpusFilenames = () => [...new Set(ingestedDocuments().map((doc) => doc.filename))];
  /** Plan 04.2-37: the versions of a lineage share one filename; ingest publishes the later version over the earlier one. */
  const versionOf = (doc: { lineage?: { version: number } }) => doc.lineage?.version ?? 1;
  const latestVersion = (filename: unknown) =>
    Math.max(...ingestedDocuments().filter((doc) => doc.filename === filename).map((doc) => versionOf(doc)));
  const sourceOf = (row: Row) => corpus.documents.find((doc) => doc.filename === row.filename && versionOf(doc) === row.version);

  test('every corpus document is a ready, current config_upload document of the fixture tenant', async () => {
    const { rows } = await fixture.db.query<Row>(
      'SELECT filename, status, is_current, source, tenant_key, version FROM documents WHERE filename = ANY($1::text[]) ORDER BY filename',
      [corpusFilenames()],
    );
    assert.deepEqual(
      rows.map((row) => row.filename),
      ingestedDocuments()
        .map((doc) => doc.filename)
        .sort(),
    );
    for (const row of rows) {
      assert.equal(row.status, 'ready', `${String(row.filename)} status`);
      assert.equal(row.is_current, row.version === latestVersion(row.filename), `${String(row.filename)} v${String(row.version)} is_current`);
      assert.equal(row.source, 'config_upload', `${String(row.filename)} source`);
      assert.equal(row.tenant_key, 's:default', `${String(row.filename)} tenant_key`);
      assert.ok(sourceOf(row), `${String(row.filename)} v${String(row.version)} is a corpus document version`);
    }
  });

  test('the chunks are written by the unified writer: plain content, hashes, parser and a vector', async () => {
    const { rows } = await fixture.db.query<Row>(
      `SELECT c.content, c.content_hash, c.parser_used, c.status, c.is_current, (c.embedding IS NOT NULL) AS has_vector,
              d.is_current AS document_current
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.filename = ANY($1::text[])`,
      [corpusFilenames()],
    );
    assert.ok(rows.length >= ingestedDocuments().length, `expected at least one chunk per document, got ${rows.length}`);
    const prefixed = rows.filter((row) => String(row.content).startsWith('Document: '));
    assert.equal(prefixed.length, 0, 'ingest mode must not store the prechunked Document: prefix');
    for (const row of rows) {
      assert.ok(row.content_hash, 'every chunk has a content hash');
      assert.equal(row.parser_used, 'text');
      assert.equal(row.status, 'ready');
      // A superseded version keeps its chunks, not current and without a vector (D-40).
      assert.equal(row.is_current, row.document_current);
      assert.equal(row.has_vector, row.document_current);
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
      'SELECT filename, version, content, metadata::text AS metadata, content_hash FROM documents WHERE filename = ANY($1::text[])',
      [corpusFilenames()],
    );
    assert.equal(documents.rows.length, ingestedDocuments().length, 'every corpus document is there to inspect');
    const { contentHash } = await import('@/lib/rag/ingest/hash');
    for (const row of documents.rows) {
      assert.ok(!String(row.content ?? '').includes(MARKER), `${String(row.filename)} content holds a marker`);
      assert.ok(!String(row.metadata ?? '').includes(META), `${String(row.filename)} metadata holds fixture-meta`);
      const source = sourceOf(row);
      assert.ok(source, `${String(row.filename)} is a corpus document`);
      assert.equal(row.content_hash, contentHash(source.content), `${String(row.filename)} was hashed over the stripped text`);
    }
    // Generated template copies (04.2-28) have no file of their own.
    const stripped = corpus.documents.filter(
      (doc) => fs.existsSync(path.join(CORPUS_DIR, doc.relpath)) && fs.readFileSync(path.join(CORPUS_DIR, doc.relpath), 'utf8').includes(META),
    );
    assert.ok(stripped.length >= 1, 'the corpus has a document with a fixture-meta line, so the check above is not vacuous');
  });

  test('sec-attacks documents bypass ingest() as ready pre-chunked rows with lexical text; sec-topics go through ingest() (D-13)', async () => {
    const attacks = corpus.documents.filter((doc) => isPrechunkedOnlyDocument(doc.relpath));
    assert.deepEqual(
      attacks.map((doc) => doc.relpath),
      ['en/sec-attacks.en.md', 'it/sec-attacks.it.md', 'zh/sec-attacks.zh.md'],
    );
    assert.equal(isPrechunkedOnlyDocument('en/sec-topics.en.md'), false);
    assert.equal(isPrechunkedOnlyDocument('en/sec-attacks-notes.en.md'), false);
    const { LEXICAL_VERSION } = await import('@/lib/rag/lexical/chunk-text');
    for (const doc of attacks) {
      const { rows } = await fixture.db.query<Row>(
        `SELECT c.id, c.content, c.status, c.is_current, c.tenant_key, c.lexical_version, c.lexical_text, c.content_hash, d.status AS document_status
         FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.filename = $1 ORDER BY c.id`,
        [doc.filename],
      );
      assert.deepEqual(
        rows.map((row) => row.id),
        doc.chunks.map((chunk) => chunk.id).sort(),
        `${doc.filename} is written with the prechunked chunk ids`,
      );
      for (const row of rows) {
        assert.ok(String(row.content).startsWith(`Document: ${doc.filename}. Chunk `), `${doc.filename} keeps the prechunked content`);
        assert.equal(row.status, 'ready');
        assert.equal(row.document_status, 'ready');
        assert.equal(row.is_current, true);
        assert.equal(row.tenant_key, 's:default');
        assert.equal(row.content_hash, null, `${doc.filename} did not come through the ingest() writer`);
        assert.equal(row.lexical_version, LEXICAL_VERSION);
        assert.ok(String(row.lexical_text ?? '').length > 0, `${doc.filename} has lexical text`);
      }
    }
    const topics = await fixture.db.query<Row>(
      `SELECT d.filename, c.parser_used, count(c.id)::int AS chunks FROM documents d JOIN document_chunks c ON c.document_id = d.id
       WHERE d.filename LIKE 'sec-topics.%' GROUP BY 1, 2 ORDER BY 1`,
    );
    assert.deepEqual(
      topics.rows.map((row) => [row.filename, row.parser_used]),
      [
        ['sec-topics.en.md', 'text'],
        ['sec-topics.it.md', 'text'],
        ['sec-topics.zh.md', 'text'],
      ],
    );
  });

  test('the pre-chunked relex leaves the rows ingest() wrote without the current lexical version as they were', async () => {
    const { LEXICAL_VERSION } = await import('@/lib/rag/lexical/chunk-text');
    const { rows } = await fixture.db.query<Row>(
      `SELECT d.filename FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE c.lexical_version IS DISTINCT FROM $1 GROUP BY 1 ORDER BY 1`,
      [LEXICAL_VERSION],
    );
    assert.ok(rows.length > 0, 'the build has rows ingest() left without a lexical version, so a full relex would have changed them');
    assert.ok(rows.every((row) => !String(row.filename).startsWith('sec-attacks.')));
  });

  test('documents.content holds the parsed text of every document, the text the chunker consumed', async () => {
    const { rows } = await fixture.db.query<Row>('SELECT filename, version, content FROM documents WHERE filename = ANY($1::text[])', [corpusFilenames()]);
    assert.equal(rows.length, ingestedDocuments().length, 'every corpus document is there to inspect');
    for (const row of rows) {
      const source = sourceOf(row);
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
