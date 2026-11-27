import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ingestMode from '../../eval/harness/ingest-mode.mts';
import type { FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, 'eval/fixtures/corpus');
const HARNESS = path.join(ROOT, 'eval/harness/templated-fixtures.mts');
/** The ingest-mode corpus hash before plan 03.3-20 (committed fixture-ingest-baseline.json at its Task 1). */
const PLAIN_CORPUS_SHA256 = 'f70716e198dd625ce408aa1d26a042567e33398b8d37df50f3245352932ae08c';
const RESTRICTED = ['tpl-family-zh-01', 'tpl-family-en-01', 'tpl-family-it-01', 'tpl-variants-zh', 'tpl-variants-en', 'tpl-variants-it'];
/** A small build: one corpus document, no typed or parse fixture document (the corpus hash still covers the whole corpus). */
const SMALL = { corpusDir: CORPUS_DIR, corpusRange: { start: 0, end: 1 }, typedFixtureIds: [], parseFixtureIds: [] } as const;

type Build = FixtureDatabase & { corpusSha256: string };
type Options = Parameters<typeof ingestMode.buildIngestFixtureDatabase>[0] & { templated?: boolean; templatedFixtureIds?: string[] };
type Harness = typeof import('../../eval/harness/templated-fixtures.mts');

interface DeclaredLines {
  top: string[];
  bottom: string[];
  fragment: string;
  footer: string[];
}

const build = (options: Options) => ingestMode.buildIngestFixtureDatabase(options as Parameters<typeof ingestMode.buildIngestFixtureDatabase>[0]) as Promise<Build>;

async function harness(): Promise<Harness> {
  assert.ok(fs.existsSync(HARNESS), 'eval/harness/templated-fixtures.mts is missing');
  return (await import('../../eval/harness/templated-fixtures.mts')) as Harness;
}

async function close(fixture: FixtureDatabase | undefined): Promise<void> {
  await fixture?.edge?.close().catch(() => undefined);
  await fixture?.db.close().catch(() => undefined);
}

async function templatedDocuments(fixture: FixtureDatabase): Promise<Array<Record<string, unknown>>> {
  const { rows } = await fixture.db.query<Record<string, unknown>>(
    "SELECT id, filename, status, source, source_key, doc_type, tenant_key FROM documents WHERE filename LIKE 'tpl-%' ORDER BY filename",
  );
  return rows;
}

describe('ingest mode: the templated collection loads only with the templated option (03.3-20)', () => {
  const builds: FixtureDatabase[] = [];
  let plainSingle: Build;
  let plainMulti: Build;
  let first: Build;
  let second: Build;
  let fewer: Build;

  before(async () => {
    plainSingle = await build({ deploymentMode: 'single-tenant', ...SMALL });
    builds.push(plainSingle);
    plainMulti = await build({ deploymentMode: 'multi-tenant', ...SMALL });
    builds.push(plainMulti);
    first = await build({ deploymentMode: 'single-tenant', ...SMALL, templated: true, templatedFixtureIds: RESTRICTED });
    builds.push(first);
    second = await build({ deploymentMode: 'single-tenant', ...SMALL, templated: true, templatedFixtureIds: RESTRICTED });
    builds.push(second);
    fewer = await build({ deploymentMode: 'single-tenant', ...SMALL, templated: true, templatedFixtureIds: RESTRICTED.slice(1) });
    builds.push(fewer);
  });

  after(async () => {
    for (const fixture of builds) await close(fixture);
  });

  test('a build without the option holds no templated document and keeps the corpus hash of before, in both modes', async () => {
    for (const plain of [plainSingle, plainMulti]) {
      assert.deepEqual(await templatedDocuments(plain), []);
      assert.equal(plain.corpusSha256, PLAIN_CORPUS_SHA256);
    }
  });

  test('the restricted templated build ingests the six documents as ready config uploads of the fixture tenant', async () => {
    const { loadTemplatedFixtures } = await harness();
    const fixtures = loadTemplatedFixtures(ROOT).fixtures.filter((fixture) => RESTRICTED.includes(fixture.id));
    const rows = await templatedDocuments(first);
    assert.deepEqual(
      rows.map((row) => row.filename),
      fixtures.map((fixture) => fixture.file_name).sort(),
    );
    for (const row of rows) {
      const fixture = fixtures.find((entry) => entry.file_name === row.filename);
      assert.ok(fixture);
      assert.equal(row.status, 'ready', String(row.filename));
      assert.equal(row.source, 'config_upload', String(row.filename));
      assert.equal(row.source_key, fixture.source_key, String(row.filename));
      assert.equal(row.source_key, `root/${String(row.filename)}`);
      assert.equal(row.doc_type, 'product_technical', String(row.filename));
      assert.equal(row.tenant_key, 's:default', String(row.filename));
    }
  });

  test('the chunks hold the top line, the bottom line and the fragment and never the footer line', async () => {
    const { loadTemplatedFixtures } = await harness();
    const fixtures = loadTemplatedFixtures(ROOT).fixtures.filter((fixture) => RESTRICTED.includes(fixture.id));
    for (const fixture of fixtures) {
      const { rows } = await first.db.query<{ content: string }>(
        'SELECT c.content FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.filename = $1 ORDER BY c.chunk_index',
        [fixture.file_name],
      );
      assert.ok(rows.length > 0, fixture.id);
      const text = rows.map((row) => row.content).join('\n');
      const lines = fixture.templated.lines as DeclaredLines;
      for (const line of [...lines.top, ...lines.bottom, lines.fragment]) assert.ok(text.includes(line), `${fixture.id}: ${line}`);
      for (const line of lines.footer) assert.ok(!text.includes(line), `${fixture.id}: footer ${line}`);
    }
  });

  test('the corpus hash covers the templated files: it differs from the plain build, repeats across builds and moves with the file set', () => {
    assert.notEqual(first.corpusSha256, PLAIN_CORPUS_SHA256);
    assert.equal(first.corpusSha256, second.corpusSha256);
    assert.notEqual(fewer.corpusSha256, first.corpusSha256);
  });

  test('a routed build or a build in several passes refuses the templated option', async () => {
    await assert.rejects(
      build({ deploymentMode: 'single-tenant', ...SMALL, templated: true, routing: { routing: 'tiered' } }),
      /templated/,
    );
    await assert.rejects(build({ deploymentMode: 'single-tenant', ...SMALL, templated: true, splitAtCorpusIndex: 1 }), /templated/);
  });

  test('templated items are recognised by category and dropped from a golden file for runs that cannot load them', async () => {
    const { isTemplatedItem, dropTemplatedItems } = (await harness()) as Harness & {
      isTemplatedItem?: (item: { category: string }) => boolean;
      dropTemplatedItems?: (goldenPath: string, outPath: string) => string;
    };
    assert.equal(typeof isTemplatedItem, 'function');
    assert.equal(typeof dropTemplatedItems, 'function');
    assert.equal(isTemplatedItem!({ category: 'templated_collection' }), true);
    assert.equal(isTemplatedItem!({ category: 'general' }), false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'templated-drop-'));
    try {
      const golden = path.join(dir, 'golden.jsonl');
      fs.writeFileSync(golden, `${JSON.stringify({ id: 'a', category: 'general' })}\n${JSON.stringify({ id: 'b', category: 'templated_collection' })}\n`);
      const out = dropTemplatedItems!(golden, path.join(dir, 'kept.jsonl'));
      assert.deepEqual(
        fs.readFileSync(out, 'utf8').trim().split('\n').map((line) => (JSON.parse(line) as { id: string }).id),
        ['a'],
      );
      const plain = path.join(dir, 'plain.jsonl');
      fs.writeFileSync(plain, `${JSON.stringify({ id: 'a', category: 'general' })}\n`);
      assert.equal(dropTemplatedItems!(plain, path.join(dir, 'unused.jsonl')), plain);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
