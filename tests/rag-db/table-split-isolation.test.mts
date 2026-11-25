import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildIngestFixtureDatabase } from '../../eval/harness/ingest-mode.mts';
import type { FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, 'eval/fixtures/corpus');
const INGEST_GOLDEN = path.join(ROOT, 'eval/fixtures/ingest/golden-ingest.jsonl');
const LONG_TABLE_FILES = /^long-table-(zh|en|it)(-continued)?\.pdf$/;

interface GoldenLine {
  id: string;
  category: string;
  language: string;
  review_status: string;
  gold_evidence: Array<{ document: string; quote: string }>;
}

interface TraceChunk {
  chunk_id: string;
  document_name?: string | null;
  content: string;
  similarity: number;
  final_score?: number | null;
}

interface TraceLine {
  item_id: string;
  candidates: TraceChunk[];
  kept: TraceChunk[];
}

function goldenLines(): Array<{ raw: string; item: GoldenLine }> {
  return fs
    .readFileSync(INGEST_GOLDEN, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((raw) => ({ raw, item: JSON.parse(raw) as GoldenLine }));
}

function writeGolden(dir: string, name: string, lines: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function readTraces(file: string): Map<string, TraceLine> {
  const traces = new Map<string, TraceLine>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const trace = JSON.parse(line) as TraceLine;
    traces.set(trace.item_id, trace);
  }
  return traces;
}

/** A chunk as two builds can compare it: chunk ids are minted per build, so name, content and scores stand for the id. */
function retrieved(chunks: TraceChunk[]): string[] {
  return chunks.map((chunk) =>
    [
      chunk.document_name ?? '',
      crypto.createHash('sha256').update(chunk.content).digest('hex'),
      String(chunk.similarity),
      String(chunk.final_score ?? ''),
    ].join('|'),
  );
}

const oldLines = () => goldenLines().filter(({ item }) => item.category !== 'table_split');
const firstEnglishTableItem = () => goldenLines().find(({ item }) => item.category === 'table_split' && item.language === 'en');

const EVAL_SECRET = 'table-split-isolation-eval-secret-000000';

/** The run without the long-table documents: a fresh process, because the app modules keep the first edge they saw. */
function tracesWithoutTables(goldenPath: string, outDir: string): Map<string, TraceLine> {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'eval/harness/run-smoke.mts', '--fixture-mode', 'ingest', '--golden', goldenPath, '--no-gate', '--out', outDir],
    { cwd: ROOT, encoding: 'utf8', timeout: 600_000, env: { ...process.env } },
  );
  assert.equal(run.status, 0, `run-smoke without the tables failed: ${run.stderr.slice(-2000)}`);
  return readTraces(path.join(outDir, 'traces.jsonl'));
}

async function tracesWithTables(fixture: FixtureDatabase, goldenPath: string, outDir: string): Promise<Map<string, TraceLine>> {
  const { runEval } = await import('../../eval/harness/run-eval.mts');
  const result = await runEval({
    goldenPath,
    corpusDir: CORPUS_DIR,
    outDir,
    deploymentMode: 'single-tenant',
    fixtureMode: 'ingest',
    ingestFixture: fixture,
  });
  return readTraces(result.tracesPath);
}

async function closeFixture(fixture: FixtureDatabase | undefined): Promise<void> {
  if (!fixture) return;
  const tenants = (fixture as FixtureDatabase & { tableSplitTenants?: Array<{ db: { close(): Promise<void> } }> }).tableSplitTenants ?? [];
  for (const tenant of tenants) await tenant.db.close().catch(() => undefined);
  await fixture.edge?.close();
  await fixture.db.close().catch(() => undefined);
}

describe('table_split items run against isolated tenants and leave the old ingest items unchanged', () => {
  let tmp: string;
  let withTables: FixtureDatabase | undefined;
  let tracesWithout: Map<string, TraceLine>;
  let tracesWith: Map<string, TraceLine>;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'table-split-isolation-'));
    const old = oldLines();
    const table = firstEnglishTableItem();
    tracesWithout = tracesWithoutTables(writeGolden(tmp, 'old.jsonl', old.map(({ raw }) => raw)), path.join(tmp, 'without'));
    withTables = await buildIngestFixtureDatabase({
      deploymentMode: 'single-tenant',
      corpusDir: CORPUS_DIR,
      processEnv: { RAG_EVAL_SECRET: EVAL_SECRET },
      tableSplit: true,
    });
    const lines = [...old.map(({ raw }) => raw), ...(table ? [table.raw] : [])];
    tracesWith = await tracesWithTables(withTables, writeGolden(tmp, 'with.jsonl', lines), path.join(tmp, 'with'));
  });

  after(async () => {
    await closeFixture(withTables);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the ingest golden file has its 46 old items and an English table_split item', () => {
    assert.equal(oldLines().length, 46);
    const table = firstEnglishTableItem();
    assert.ok(table, 'no English table_split item in golden-ingest.jsonl');
    assert.ok(table.item.gold_evidence.every((span) => span.document === 'long-table-en.pdf'));
  });

  test('every old item retrieves the same chunks in the same order with and without the long-table documents', () => {
    const old = oldLines().filter(({ item }) => item.review_status === 'approved');
    assert.equal(tracesWithout.size, old.length);
    for (const { item } of old) {
      const before = tracesWithout.get(item.id);
      const afterLoad = tracesWith.get(item.id);
      assert.ok(before && afterLoad, `${item.id} has a trace in both runs`);
      assert.deepEqual(retrieved(afterLoad.candidates), retrieved(before.candidates), `${item.id} candidates`);
      assert.deepEqual(retrieved(afterLoad.kept), retrieved(before.kept), `${item.id} kept`);
    }
  });

  test('the old fixture tenant holds no long-table document', async () => {
    assert.ok(withTables);
    const { rows } = await withTables.db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE filename LIKE 'long-table-%'");
    assert.equal(rows[0]?.n, 0);
  });

  test('the six long-table documents are ready in their isolated tenants, plain and page-continued apart', async () => {
    assert.ok(withTables);
    const tenants = (withTables as FixtureDatabase & {
      tableSplitTenants?: Array<{ group: string; db: FixtureDatabase['db']; tenantKey: string }>;
    }).tableSplitTenants;
    assert.ok(tenants, 'the build exposes its table_split tenants');
    assert.deepEqual(tenants.map((tenant) => tenant.group), ['plain', 'continued']);
    for (const tenant of tenants) {
      const { rows } = await tenant.db.query<{ filename: string; status: string; tenant_key: string }>(
        'SELECT filename, status, tenant_key FROM documents ORDER BY filename',
      );
      const suffix = tenant.group === 'continued' ? '-continued' : '';
      assert.deepEqual(
        rows.map((row) => row.filename),
        ['en', 'it', 'zh'].map((language) => `long-table-${language}${suffix}.pdf`),
      );
      for (const row of rows) {
        assert.equal(row.status, 'ready', row.filename);
        assert.equal(row.tenant_key, tenant.tenantKey, row.filename);
      }
    }
  });

  test('the English table_split item is answered by the same eval route from the isolated tenant only', () => {
    const table = firstEnglishTableItem();
    assert.ok(table);
    const trace = tracesWith.get(table.item.id);
    assert.ok(trace, 'the table_split item has a trace');
    assert.ok(trace.candidates.length > 0, 'the table_split item retrieved candidates');
    for (const chunk of [...trace.candidates, ...trace.kept]) {
      assert.match(String(chunk.document_name ?? ''), LONG_TABLE_FILES, `chunk ${chunk.chunk_id} comes from the isolated tenant`);
      assert.ok(!/-continued\.pdf$/.test(String(chunk.document_name)), 'a plain-table item never sees the page-continued twin');
    }
    assert.ok(trace.candidates.some((chunk) => chunk.document_name === 'long-table-en.pdf'));
  });
});
