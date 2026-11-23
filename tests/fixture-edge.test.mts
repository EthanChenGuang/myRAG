import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus } from '../eval/harness/corpus.mts';
import { EMBEDDER_ID, EMBEDDER_VERSION, embedText, embedderSourceSha256 } from '../eval/harness/fixture-embedder.mts';
import { FIXTURE_USER_ID, createFixtureDatabase } from '../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const TRACER_QUESTION = 'What is the refund window for annual plans?';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeTempCorpus(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-corpus-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

describe('corpus loader', () => {
  const tempDirs: string[] = [];
  after(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reads files in sorted relative-path order, splits on chunk markers and builds stored content', () => {
    const dir = makeTempCorpus({
      'zh/z-doc.md': '## 标题\n内容甲\n',
      'en/b-doc.md':
        '<!-- fixture-meta {"filename":"Custom.pdf","image_url":"https://example.test/x.png","created_at":"2024-02-03T00:00:00.000Z"} -->\n## Head A\nText A\n<!-- chunk -->\n\n  \n<!-- chunk -->\n## Head B\nText B\n',
      'en/a-doc.md': 'Plain body without a heading\n',
      'it/m-doc.md': '## Sezione\nTesto\n',
      'en/ignored.txt': 'not markdown',
      'fr/other.md': 'unsupported language directory',
    });
    tempDirs.push(dir);

    const { documents } = loadCorpus(dir);
    assert.deepEqual(
      documents.map((d) => d.relpath),
      ['en/a-doc.md', 'en/b-doc.md', 'it/m-doc.md', 'zh/z-doc.md'],
    );

    const [plain, custom] = documents;
    assert.equal(plain.filename, 'a-doc.md');
    assert.equal(plain.imageUrl, null);
    assert.equal(plain.createdAt, '2025-01-15T00:00:00.000Z');
    assert.equal(plain.language, 'en');
    assert.equal(plain.chunks[0].section, '');

    assert.equal(custom.filename, 'Custom.pdf');
    assert.equal(custom.imageUrl, 'https://example.test/x.png');
    assert.equal(custom.createdAt, '2024-02-03T00:00:00.000Z');
    assert.equal(custom.chunks.length, 2);
    assert.equal(custom.chunks[0].index, 0);
    assert.equal(custom.chunks[0].section, 'Head A');
    assert.equal(custom.chunks[0].text, '## Head A\nText A');
    assert.equal(custom.chunks[0].stored, 'Document: Custom.pdf. Chunk 1 of 2. Content: ## Head A\nText A');
    assert.equal(custom.chunks[1].stored, 'Document: Custom.pdf. Chunk 2 of 2. Content: ## Head B\nText B');
    assert.equal(custom.content, '## Head A\nText A\n\n## Head B\nText B');
  });

  test('document and chunk ids are UUID-shaped and identical across two loads', () => {
    const dir = makeTempCorpus({ 'en/a.md': 'one\n<!-- chunk -->\ntwo\n', 'it/b.md': 'tre\n' });
    tempDirs.push(dir);

    const first = loadCorpus(dir);
    const second = loadCorpus(dir);
    const ids = (c: typeof first) => c.documents.flatMap((d) => [d.id, ...d.chunks.map((k) => k.id)]);
    assert.deepEqual(ids(first), ids(second));
    assert.equal(first.corpusSha256, second.corpusSha256);
    for (const id of ids(first)) assert.match(id, UUID_RE);
    assert.equal(new Set(ids(first)).size, ids(first).length);
  });

  test('corpus hash changes when a byte changes', () => {
    const dir = makeTempCorpus({ 'en/a.md': 'one\n' });
    tempDirs.push(dir);
    const before = loadCorpus(dir).corpusSha256;
    fs.writeFileSync(path.join(dir, 'en/a.md'), 'one!\n');
    assert.notEqual(loadCorpus(dir).corpusSha256, before);
  });
});

describe('fixture embedder', () => {
  test('is deterministic, L2-normalized and 1536-dimensional', () => {
    assert.equal(EMBEDDER_ID, 'fixture-ngram');
    assert.equal(EMBEDDER_VERSION, 1);
    const a = embedText('Refund window for annual plans');
    const b = embedText('Refund window for annual plans');
    assert.deepEqual(a, b);
    assert.equal(a.length, 1536);
    const norm = Math.sqrt(a.reduce((sum, x) => sum + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, `norm was ${norm}`);
  });

  test('a text with no features embeds the __empty__ feature', () => {
    const empty = embedText('');
    assert.deepEqual(embedText('the of !!!'), empty);
    const nonZero = empty.filter((x) => x !== 0);
    assert.equal(nonZero.length, 1);
    assert.ok(Math.abs(Math.abs(nonZero[0]) - 1) < 1e-9);
  });

  test('related text is closer than unrelated text and Han text uses bigrams', () => {
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i], 0);
    const query = embedText('annual plan refund window');
    assert.ok(cos(query, embedText('The annual plan refund window is 45 days')) > cos(query, embedText('Shipping rates for oversized parcels')) + 0.2);
    const zh = embedText('退款期限是多少天');
    assert.ok(cos(zh, embedText('年度套餐的退款期限为四十五天')) > cos(zh, embedText('设备保修范围包括电池')));
  });

  test('embedderSourceSha256 is a stable sha-256 hex digest', () => {
    assert.match(embedderSourceSha256(), /^[0-9a-f]{64}$/);
    assert.equal(embedderSourceSha256(), embedderSourceSha256());
  });
});

describe('fixture database loaded with the repo SQL', () => {
  type Fixture = Awaited<ReturnType<typeof createFixtureDatabase>>;
  let singleP: Promise<Fixture> | undefined;
  let multiP: Promise<Fixture> | undefined;
  const getSingle = () => (singleP ??= createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS }));
  const getMulti = () => (multiP ??= createFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: REAL_CORPUS }));
  const expectedChunks = () => loadCorpus(REAL_CORPUS).documents.flatMap((d) => d.chunks);

  after(async () => {
    await (await singleP?.catch(() => undefined))?.db.close();
    await (await multiP?.catch(() => undefined))?.db.close();
  });

  test('single-tenant: loads supabase/single-tenant-setup.sql and inserts every corpus chunk', async () => {
    const single = await getSingle();
    const sql = fs.readFileSync(path.join(REPO_ROOT, 'supabase/single-tenant-setup.sql'));
    assert.deepEqual(Object.keys(single.sqlSha256), ['supabase/single-tenant-setup.sql']);
    assert.equal(single.corpusSha256, loadCorpus(REAL_CORPUS).corpusSha256);
    assert.match(single.sqlSha256['supabase/single-tenant-setup.sql'], /^[0-9a-f]{64}$/);
    assert.ok(sql.length > 0);

    const rows = await single.db.query<{ id: string }>('SELECT id FROM document_chunks ORDER BY id');
    assert.deepEqual(
      rows.rows.map((r) => r.id).sort(),
      expectedChunks().map((c) => c.id).sort(),
    );
    const index = await single.db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_document_chunks_embedding'",
    );
    assert.match(index.rows[0].indexdef, /hnsw/);
  });

  test('multi-tenant: loads multi-tenant-setup.sql and sets documents.user_id to FIXTURE_USER_ID', async () => {
    const multi = await getMulti();
    assert.deepEqual(Object.keys(multi.sqlSha256), ['supabase/multi-tenant-setup.sql']);
    assert.equal(multi.fixtureUserId, FIXTURE_USER_ID);
    const owners = await multi.db.query<{ user_id: string }>('SELECT DISTINCT user_id FROM documents');
    assert.deepEqual(owners.rows.map((r) => r.user_id), [FIXTURE_USER_ID]);
    const chunks = await multi.db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks');
    assert.equal(chunks.rows[0].n, expectedChunks().length);
  });

  test('match_document_chunks returns a refund-policy.en.md chunk for the tracer question', async () => {
    const single = await getSingle();
    const result = await single.db.query<{ chunk_id: string; content: string; similarity: number }>(
      'SELECT * FROM match_document_chunks(query_embedding => $1, similarity_threshold => $2, match_count => $3)',
      [vectorLiteral(embedText(TRACER_QUESTION)), 0.1, 10],
    );
    assert.ok(result.rows.length > 0, 'no rows returned');
    assert.ok(result.rows.some((r) => r.content.startsWith('Document: refund-policy.en.md.')));
    assert.match(result.rows[0].content, /Annual plans/);
  });

  test('two database builds produce identical chunk ids and candidate order', async () => {
    const single = await getSingle();
    const again = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: REAL_CORPUS });
    try {
      const run = (db: typeof again.db) =>
        db.query<{ chunk_id: string }>(
          'SELECT chunk_id FROM match_document_chunks(query_embedding => $1, similarity_threshold => $2, match_count => $3)',
          [vectorLiteral(embedText(TRACER_QUESTION)), 0.0, 10],
        );
      assert.deepEqual((await run(again.db)).rows, (await run(single.db)).rows);
    } finally {
      await again.db.close();
    }
  });
});
