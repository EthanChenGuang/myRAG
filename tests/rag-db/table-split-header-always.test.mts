import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * D-46, roadmap criterion 8: with RAG_TABLE_HEADER_REPEAT=always every retrieved table_split row chunk holds its table header,
 * in every processing profile. Each profile is one ingest fixture run in its own process (the app modules freeze their env at
 * first import), with the long-table documents loaded under that profile's doc type.
 */
const ROOT = process.cwd();
const INGEST_GOLDEN = path.join(ROOT, 'eval/fixtures/ingest/golden-ingest.jsonl');
const PROFILES = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/rag/processing-profiles.json'), 'utf8')) as {
  profiles: Array<{ doc_type: string }>;
};
const DOC_TYPES = PROFILES.profiles.map((profile) => profile.doc_type);

interface RateValue {
  value: number | null;
  n: number;
}

interface TableSplitBlock {
  overall: { items: number; header_in_context_rate: RateValue; row_recall_at_10: RateValue };
  by_language: Record<string, { items: number; header_in_context_rate: RateValue }>;
}

function tableSplitGolden(dir: string): { file: string; count: number } {
  const lines = fs
    .readFileSync(INGEST_GOLDEN, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && (JSON.parse(line) as { category: string }).category === 'table_split');
  const file = path.join(dir, 'golden.table-split.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return { file, count: lines.length };
}

function runSmoke(args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'eval/harness/run-smoke.mts', ...args], { cwd: ROOT, env: { ...process.env } });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (status) => resolve({ status, output }));
  });
}

async function tableSplitBlock(golden: string, outDir: string, docType: string, repeat: 'always' | 'profile'): Promise<TableSplitBlock> {
  const { status, output } = await runSmoke([
    '--fixture-mode',
    'ingest',
    '--golden',
    golden,
    '--table-split-doc-type',
    docType,
    '--table-header-repeat',
    repeat,
    '--out',
    outDir,
  ]);
  assert.equal(status, 0, `run-smoke for ${docType} (${repeat}) exited ${status}:\n${output.slice(-2000)}`);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8')) as { table_split?: TableSplitBlock };
  assert.ok(report.table_split, `the ${docType} report has a table_split block`);
  const log = fs.readFileSync(path.join(outDir, 'harness.log'), 'utf8');
  assert.match(log, new RegExp(`"doc_type":"${docType}"`), `the long tables were ingested as ${docType}`);
  return report.table_split;
}

describe('header_in_context_rate under RAG_TABLE_HEADER_REPEAT=always (D-46)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-split-always-'));
  const golden = tableSplitGolden(dir);

  test('is 1.0 over every table_split item in every processing profile', { timeout: 900_000 }, async () => {
    assert.ok(DOC_TYPES.length >= 6, 'the six shipped processing profiles');
    // One build at a time: concurrent fixture builds compete for the stage time budgets and can fail a stage under load.
    for (const docType of DOC_TYPES) {
      const block = await tableSplitBlock(golden.file, path.join(dir, `always-${docType}`), docType, 'always');
      assert.equal(block.overall.items, golden.count, `${docType}: every table_split item is scored`);
      assert.deepEqual(block.overall.row_recall_at_10, { value: 1, n: golden.count }, `${docType}: every row chunk is retrieved`);
      assert.deepEqual(block.overall.header_in_context_rate, { value: 1, n: golden.count }, `${docType}: header_in_context_rate`);
      for (const language of ['zh', 'en', 'it']) {
        const slice = block.by_language[language];
        assert.ok(slice && slice.items > 0, `${docType}: ${language} items`);
        assert.equal(slice.header_in_context_rate.value, 1, `${docType}: ${language} header_in_context_rate`);
      }
    }
  });

  test('the check discriminates: the general profile without always leaves row chunks without their header', { timeout: 300_000 }, async () => {
    const block = await tableSplitBlock(golden.file, path.join(dir, 'profile-general'), 'general', 'profile');
    assert.ok((block.overall.header_in_context_rate.value ?? 1) < 1, 'profile mode on general does not repeat headers');
  });
});
