import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { buildIngestFixtureDatabase, partitionIngestModeItems } from '../../eval/harness/ingest-mode.mts';
import { createFixtureDatabase, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, 'eval/fixtures/corpus');
const PRECHUNKED_GOLDEN = path.join(ROOT, 'eval/fixtures/golden.jsonl');
const INGEST_GOLDEN = path.join(ROOT, 'eval/fixtures/ingest/golden-ingest.jsonl');
const Q62_MANIFEST = path.join(ROOT, 'eval/fixtures/q62-corpus/manifest.json');
const Q62_FILE = /^q62-[a-z-]+\.(zh|en|it)\.md$/;
const Q62_USER_ID = '00000000-0000-4000-8000-0000000006a2';
const EVAL_SECRET = 'q62-fixture-isolation-eval-secret-0000000';

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

interface Q62Fixture extends FixtureDatabase {
  q62Tenant?: { db: PGlite; tenantKey: string; userId: string | null; documentIds: Map<string, string>; filenames: string[] };
}

/** A synthetic scoped_compound item on the q62 corpus (neutral content; the real items are written by 06.2-22). */
const ORIEL_SPAN = {
  document: 'q62-scope-oriel-corvid.en.md',
  quote: 'the Corvid unit recalibrates each sensor array every 14 days',
  section: 'Sensor array calibration cadence',
};
const PALLAS_SPAN = {
  document: 'q62-scope-pallas-lumen.en.md',
  quote: 'the Lumen unit recalibrates each sensor array every 21 days',
  section: 'Sensor array calibration cadence',
};
const Q62_ITEM = {
  answerable: true,
  category: 'scoped_compound',
  conversation: [],
  evidence_language: null,
  expected_answer: 'Every 14 days in Zone Oriel and every 21 days in Zone Pallas.',
  gold_evidence: [ORIEL_SPAN, PALLAS_SPAN],
  id: 'q62-isolation-probe-en-01',
  language: 'en',
  provenance: 'synthetic_fixture',
  question: 'How often do the Corvid unit in Zone Oriel and the Lumen unit in Zone Pallas recalibrate a sensor array?',
  review_status: 'approved',
  split: 'dev',
  sub_questions: [
    { index: 0, gold_spans: [ORIEL_SPAN] },
    { index: 1, gold_spans: [PALLAS_SPAN] },
  ],
};

function lines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function writeGolden(dir: string, name: string, content: string[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${content.join('\n')}\n`);
  return file;
}

function readTraces(file: string): Map<string, TraceLine> {
  const traces = new Map<string, TraceLine>();
  for (const line of lines(file)) {
    const trace = JSON.parse(line) as TraceLine;
    traces.set(trace.item_id, trace);
  }
  return traces;
}

/** Prechunked chunk ids are derived from the corpus path, so the ids themselves are compared. */
const chunkIds = (chunks: TraceChunk[]): string[] => chunks.map((chunk) => chunk.chunk_id);

/** Ingest builds mint chunk ids per build, so name, content and scores stand for the id. */
function ingestSignature(chunks: TraceChunk[]): string[] {
  return chunks.map((chunk) =>
    [chunk.document_name ?? '', crypto.createHash('sha256').update(chunk.content).digest('hex'), String(chunk.similarity), String(chunk.final_score ?? '')].join('|'),
  );
}

/** One run-smoke in a fresh process: the app modules keep the first edge and environment they saw. */
function runSmoke(fixtureMode: 'prechunked' | 'ingest', goldenPath: string, outDir: string): Map<string, TraceLine> {
  const run = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'eval/harness/run-smoke.mts', '--fixture-mode', fixtureMode, '--golden', goldenPath, '--no-gate', '--out', outDir],
    { cwd: ROOT, encoding: 'utf8', timeout: 900_000, env: { ...process.env } },
  );
  assert.equal(run.status, 0, `run-smoke ${fixtureMode} failed: ${run.stderr.slice(-2000)}`);
  return readTraces(path.join(outDir, 'traces.jsonl'));
}

function assertOldItemsUnchanged(
  without: Map<string, TraceLine>,
  withQ62: Map<string, TraceLine>,
  signature: (chunks: TraceChunk[]) => string[],
): void {
  assert.ok(without.size > 0, 'the run without the q62 documents scored items');
  assert.deepEqual([...withQ62.keys()].filter((id) => id !== Q62_ITEM.id).sort(), [...without.keys()].sort());
  for (const [id, before] of without) {
    const afterLoad = withQ62.get(id);
    assert.ok(afterLoad, `${id} has a trace in both runs`);
    assert.deepEqual(signature(afterLoad.candidates), signature(before.candidates), `${id} candidates`);
    assert.deepEqual(signature(afterLoad.kept), signature(before.kept), `${id} kept`);
  }
}

function assertQ62ItemFromIsolatedTenant(traces: Map<string, TraceLine>): void {
  const trace = traces.get(Q62_ITEM.id);
  assert.ok(trace, 'the q62 item has a trace');
  assert.ok(trace.candidates.length > 0, 'the q62 item retrieved candidates');
  for (const chunk of [...trace.candidates, ...trace.kept]) {
    assert.match(String(chunk.document_name ?? ''), Q62_FILE, `chunk ${chunk.chunk_id} comes from the q62 tenant`);
  }
  assert.ok(trace.candidates.some((chunk) => chunk.document_name === 'q62-scope-oriel-corvid.en.md'));
}

const manifest = () =>
  JSON.parse(fs.readFileSync(Q62_MANIFEST, 'utf8')) as {
    document_scopes: Record<string, string[]>;
    glossary: Array<{ canonical: string; variants: string[]; language: string; target_language: string }>;
  };

async function assertQ62Tenant(fixture: Q62Fixture, tenantKey: string): Promise<void> {
  const tenant = fixture.q62Tenant;
  assert.ok(tenant, 'the build exposes its q62 tenant');
  assert.equal(tenant.tenantKey, tenantKey);
  const docs = await tenant.db.query<{ filename: string; status: string; tenant_key: string; scopes: string[] | null }>(
    'SELECT filename, status, tenant_key, scopes FROM documents ORDER BY filename',
  );
  assert.equal(docs.rows.length, 12);
  for (const row of docs.rows) {
    assert.match(row.filename, Q62_FILE);
    assert.equal(row.status, 'ready', row.filename);
    assert.equal(row.tenant_key, tenantKey, row.filename);
    assert.deepEqual(row.scopes ?? [], manifest().document_scopes[row.filename] ?? [], `${row.filename} scopes`);
  }
  const chunks = await tenant.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM document_chunks c JOIN documents d ON d.id = c.document_id WHERE d.scopes <> '{}' AND c.scopes = d.scopes",
  );
  assert.ok((chunks.rows[0]?.n ?? 0) >= 6, 'the chunks of the tagged documents carry the scope tags');
  const vocabulary = await tenant.db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_scope_vocabulary WHERE tenant_key = $1', [tenantKey]);
  assert.equal(vocabulary.rows[0]?.n, 4);

  const glossary = await tenant.db.query<{ canonical: string; language: string; target_language: string | null }>(
    "SELECT canonical, language, target_language FROM public.rag_term_entries WHERE layer_key = $1 AND kind = 'translation' ORDER BY language",
    [tenantKey],
  );
  assert.deepEqual(
    glossary.rows,
    manifest()
      .glossary.map((entry) => ({ canonical: entry.canonical, language: entry.language, target_language: entry.target_language }))
      .sort((a, b) => a.language.localeCompare(b.language)),
  );
  const effective = await tenant.db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM public.rag_term_effective($1) WHERE kind = 'translation' AND target_language IS NOT NULL AND canonical = ANY ($2::text[])",
    [tenantKey, manifest().glossary.map((entry) => entry.canonical)],
  );
  assert.equal(effective.rows[0]?.n, 3, 'the glossary rows are in the tenant effective dictionary');

  const mainDocs = await fixture.db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE filename LIKE 'q62-%'");
  assert.equal(mainDocs.rows[0]?.n, 0, 'the main fixture tenant holds no q62 document');
  const mainGlossary = await fixture.db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_term_entries WHERE canonical = ANY ($1::text[])', [
    manifest().glossary.map((entry) => entry.canonical),
  ]);
  assert.equal(mainGlossary.rows[0]?.n, 0, 'the main fixture tenant has no q62 glossary row');
}

async function closeFixture(fixture: Q62Fixture | undefined): Promise<void> {
  if (!fixture) return;
  await fixture.q62Tenant?.db.close().catch(() => undefined);
  await fixture.edge?.close();
  await fixture.db.close().catch(() => undefined);
}

describe('routing', () => {
  test('scoped_compound, glossary and version_compare items and off_domain-tagged items go to the q62 tenant, every other item to the main tenant', () => {
    const items = [
      { id: 'a', category: 'general' },
      { id: 'b', category: 'scoped_compound' },
      { id: 'c', category: 'glossary' },
      { id: 'd', category: 'version_compare' },
      { id: 'e', category: 'no_answer', tags: ['off_domain'] },
      { id: 'f', category: 'no_answer', tags: ['near_miss_code'] },
      { id: 'g', category: 'table_split' },
      { id: 'h', category: 'compound' },
    ];
    const routed = partitionIngestModeItems(items) as { main: typeof items; tableSplit: typeof items; q62?: typeof items };
    assert.deepEqual(routed.main.map((item) => item.id), ['a', 'f', 'h']);
    assert.deepEqual(routed.tableSplit.map((item) => item.id), ['g']);
    assert.deepEqual((routed.q62 ?? []).map((item) => item.id), ['b', 'c', 'd', 'e']);
  });

  test('no committed golden item is routed to the q62 tenant yet, so the default runs load nothing new', () => {
    const items = [...lines(PRECHUNKED_GOLDEN), ...lines(INGEST_GOLDEN)].map((line) => JSON.parse(line) as { category: string; tags?: string[] });
    const routed = partitionIngestModeItems(items) as { q62?: unknown[]; main: unknown[]; tableSplit: unknown[] };
    assert.ok(routed.q62, 'the partition has a q62 group');
    assert.equal(routed.q62.length, 0);
  });
});

describe('prechunked mode: the q62 documents load into an isolated tenant and leave the old items unchanged', () => {
  let tmp: string;
  let without: Map<string, TraceLine>;
  let withQ62: Map<string, TraceLine>;
  const fixtures: Q62Fixture[] = [];

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q62-isolation-prechunked-'));
    const old = lines(PRECHUNKED_GOLDEN);
    without = runSmoke('prechunked', writeGolden(tmp, 'old.jsonl', old), path.join(tmp, 'without'));
    withQ62 = runSmoke('prechunked', writeGolden(tmp, 'with.jsonl', [...old, JSON.stringify(Q62_ITEM)]), path.join(tmp, 'with'));
  });

  after(async () => {
    for (const fixture of fixtures) await closeFixture(fixture);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('every old item retrieves the same chunk ids in the same order with and without the q62 documents', () => {
    assertOldItemsUnchanged(without, withQ62, chunkIds);
  });

  test('the scoped_compound item retrieves only from the q62 tenant', () => {
    assertQ62ItemFromIsolatedTenant(withQ62);
  });

  for (const deploymentMode of ['single-tenant', 'multi-tenant'] as const) {
    test(`${deploymentMode}: the q62 tenant holds the tagged documents and the glossary rows, the main tenant neither`, async () => {
      const fixture = (await createFixtureDatabase({ deploymentMode, corpusDir: CORPUS_DIR, fixtureMode: 'prechunked', q62: true } as Parameters<
        typeof createFixtureDatabase
      >[0])) as Q62Fixture;
      fixtures.push(fixture);
      await assertQ62Tenant(fixture, deploymentMode === 'multi-tenant' ? `u:${Q62_USER_ID}` : 's:default');
    });
  }
});

describe('ingest mode: the q62 documents load into an isolated tenant and leave the old items unchanged', () => {
  let tmp: string;
  let fixture: Q62Fixture | undefined;
  let without: Map<string, TraceLine>;
  let withQ62: Map<string, TraceLine>;

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q62-isolation-ingest-'));
    // table_split and templated_collection items run against builds of their own (table-split.mts, the 03.3 templated collection),
    // which this q62 build does not load, so only the other items are compared.
    const old = [...lines(PRECHUNKED_GOLDEN), ...lines(INGEST_GOLDEN)].filter((line) => {
      const category = (JSON.parse(line) as { category: string }).category;
      return category !== 'table_split' && category !== 'templated_collection';
    });
    without = runSmoke('ingest', writeGolden(tmp, 'old.jsonl', old), path.join(tmp, 'without'));
    fixture = (await buildIngestFixtureDatabase({
      deploymentMode: 'single-tenant',
      corpusDir: CORPUS_DIR,
      processEnv: { RAG_EVAL_SECRET: EVAL_SECRET },
      q62: true,
    } as Parameters<typeof buildIngestFixtureDatabase>[0])) as Q62Fixture;
    const { runEval } = await import('../../eval/harness/run-eval.mts');
    const result = await runEval({
      goldenPath: writeGolden(tmp, 'with.jsonl', [...old, JSON.stringify(Q62_ITEM)]),
      corpusDir: CORPUS_DIR,
      outDir: path.join(tmp, 'with'),
      deploymentMode: 'single-tenant',
      fixtureMode: 'ingest',
      ingestFixture: fixture,
    });
    withQ62 = readTraces(result.tracesPath);
  });

  after(async () => {
    await closeFixture(fixture);
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('every old item retrieves the same chunks in the same order with and without the q62 documents', () => {
    assertOldItemsUnchanged(without, withQ62, ingestSignature);
  });

  test('the scoped_compound item retrieves only from the q62 tenant', () => {
    assertQ62ItemFromIsolatedTenant(withQ62);
  });

  test('the q62 tenant holds the tagged documents and the glossary rows, the main tenant neither', async () => {
    assert.ok(fixture);
    await assertQ62Tenant(fixture, 's:default');
  });
});
