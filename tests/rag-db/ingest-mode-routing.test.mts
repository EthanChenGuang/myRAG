/**
 * The ingest fixture mode per routing mode and per forced tier (D-40): without --routing it is the Phase 3 inline ingest() plus
 * the parse fixtures; with --routing every document goes through enqueueIngest and the real sidecar job function (recorded
 * converter, fake LlamaParse), one job at a time.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
  buildIngestFixtureDatabase,
  ingestModeParseFixtures,
  parseIngestRoutingFlags,
  type IngestRoutingOptions,
} from '../../eval/harness/ingest-mode.mts';
import type { FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

type Row = Record<string, unknown>;
type Built = FixtureDatabase & { routingSummary?: { jobs: number; llamaUploads: number; needsReview: Array<{ filename: string; reason: string }> } };

const CORPUS_DIR = path.join(process.cwd(), 'eval/fixtures/corpus');

interface Subset {
  corpus?: number;
  typed?: string[];
  parse?: string[];
}

async function build(subset: Subset, routing?: IngestRoutingOptions): Promise<Built> {
  return (await buildIngestFixtureDatabase({
    deploymentMode: 'single-tenant',
    corpusDir: CORPUS_DIR,
    corpusRange: { start: 0, end: subset.corpus ?? 0 },
    typedFixtureIds: subset.typed ?? [],
    parseFixtureIds: subset.parse ?? [],
    ...(routing ? { routing } : {}),
  })) as Built;
}

async function close(fixture: Built | undefined): Promise<void> {
  await fixture?.edge?.close().catch(() => undefined);
  await fixture?.db.close().catch(() => undefined);
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows;
}

/** What two builds of the same document must agree on; ids, tenants and timestamps are left out. */
async function fingerprints(db: PGlite): Promise<Map<string, Row[]>> {
  const chunks = await rows(
    db,
    `SELECT d.filename, c.chunk_index, c.content, c.content_hash, c.section_path, c.page_start, c.page_end, c.chunk_kind
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.is_current AND d.status = 'ready'
      ORDER BY d.filename, c.chunk_index`,
  );
  const out = new Map<string, Row[]>();
  for (const row of chunks) {
    const { filename, ...rest } = row;
    out.set(String(filename), [...(out.get(String(filename)) ?? []), rest]);
  }
  return out;
}

async function jobsByFilename(db: PGlite): Promise<Map<string, Row>> {
  const list = await rows(
    db,
    `SELECT j.filename, j.status, j.settings, j.page_ranges, j.tier_page_counts, j.parser_used
       FROM ingestion_jobs j ORDER BY j.created_at`,
  );
  return new Map(list.map((row) => [String(row.filename), row]));
}

function tiersOf(job: Row | undefined): string[] {
  return ((job?.page_ranges as Row[] | null) ?? []).map((range) => String(range.tier));
}

describe('ingest mode routing flags', () => {
  test('no flag keeps the inline Phase 3 path', () => {
    assert.equal(parseIngestRoutingFlags({}), undefined);
  });

  test('--routing fixed and --routing tiered select the queue', () => {
    assert.deepEqual(parseIngestRoutingFlags({ routing: 'fixed' }), { routing: 'fixed' });
    assert.deepEqual(parseIngestRoutingFlags({ routing: 'tiered' }), { routing: 'tiered' });
  });

  test('--force-tier pins tiered routing and names the tier', () => {
    for (const tier of ['fast', 'structured', 'premium'] as const) {
      assert.deepEqual(parseIngestRoutingFlags({ 'force-tier': tier }), { routing: 'tiered', forceTier: tier });
      assert.deepEqual(parseIngestRoutingFlags({ routing: 'tiered', 'force-tier': tier }), { routing: 'tiered', forceTier: tier });
    }
  });

  test('unknown values and a forced tier under fixed routing are refused', () => {
    assert.throws(() => parseIngestRoutingFlags({ routing: 'queued' }), /--routing must be fixed or tiered/);
    assert.throws(() => parseIngestRoutingFlags({ 'force-tier': 'native' }), /--force-tier must be fast, structured or premium/);
    assert.throws(() => parseIngestRoutingFlags({ routing: 'fixed', 'force-tier': 'fast' }), /--force-tier needs tiered routing/);
  });

  test('the parse fixtures of the ingest corpus: every class but the latency fixture, the scans and invoice-en as their typed twins', () => {
    const fixtures = ingestModeParseFixtures();
    assert.deepEqual(
      fixtures.map((fixture) => [fixture.id, fixture.filename, fixture.typedTwin]),
      [
        ['cross-boundary', 'cross-boundary.pdf', false],
        ['digital-text', 'digital-text.pdf', false],
        ['invoice-en', 'invoice-en.pdf', true],
        ['mixed-routing', 'mixed-routing.pdf', false],
        ['multi-column-en', 'multi-column-en.pdf', false],
        ['scan-en', 'scan-en.pdf', true],
        ['scan-it', 'scan-it.pdf', true],
        ['scan-zh', 'scan-zh.pdf', true],
        ['table-en', 'table-en.pdf', false],
      ],
    );
    assert.ok(!fixtures.some((fixture) => fixture.class === 'bench'));
    assert.ok(!fixtures.some((fixture) => fixture.class === 'scan_zh_it'), 'the character-exact scan fixture is not part of the retrieval corpus');
  });
});

describe('ingest mode by routing', () => {
  let inline: Built | undefined;
  let inlinePrints: Map<string, Row[]>;
  const SUBSET: Subset = { corpus: 1, typed: ['scan-en'], parse: ['table-en'] };

  before(async () => {
    inline = await build(SUBSET);
    inlinePrints = await fingerprints(inline.db);
  });

  after(async () => {
    await close(inline);
  });

  test('without --routing: inline ingest, no ledger row, and the parse fixtures are ready docling documents', async () => {
    assert.ok(inline);
    assert.equal((await rows(inline.db, 'SELECT count(*)::int AS n FROM ingestion_jobs'))[0]?.n, 0);
    const [table] = await rows(inline.db, "SELECT status, parser_used, is_current FROM documents WHERE filename = 'table-en.pdf'");
    assert.deepEqual(table, { status: 'ready', parser_used: 'docling', is_current: true });
    const tableChunks = inlinePrints.get('table-en.pdf') ?? [];
    assert.ok(tableChunks.some((chunk) => String(chunk.content).includes('Row-01')), 'the table rows are indexed');
    assert.ok(inlinePrints.has('scan-en.pdf'), 'the typed scan stands for the parse fixture scan-en');
    assert.equal(inlinePrints.size, 3, 'one corpus document, one typed fixture and one parse fixture');
  });

  test('--routing fixed: every document has a ready ledger row and the chunks equal the inline run', async () => {
    const fixed = await build(SUBSET, { routing: 'fixed' });
    try {
      const jobs = await jobsByFilename(fixed.db);
      assert.deepEqual([...jobs.keys()].sort(), [...inlinePrints.keys()].sort());
      for (const [filename, job] of jobs) {
        assert.equal(job.status, 'ready', `${filename} job status`);
        assert.equal((job.settings as Row).routing, 'fixed', `${filename} routing`);
      }
      assert.deepEqual(await fingerprints(fixed.db), inlinePrints);
    } finally {
      await close(fixed);
    }
  });

  test('--routing tiered: the mixed fixture is parsed page by page (fast, structured_full, structured_ocr)', async () => {
    const tiered = await build({ parse: ['mixed-routing'] }, { routing: 'tiered' });
    try {
      const job = (await jobsByFilename(tiered.db)).get('mixed-routing.pdf');
      assert.equal(job?.status, 'ready');
      assert.equal((job?.settings as Row).routing, 'tiered');
      assert.deepEqual(
        ((job?.page_ranges as Row[]) ?? []).map((range) => [range.start, range.end, range.tier, range.preset]),
        [
          [1, 6, 'fast', 'fast'],
          [7, 8, 'structured', 'structured_full'],
          [9, 9, 'structured', 'structured_ocr'],
          [10, 10, 'fast', 'fast'],
        ],
      );
      assert.equal(tiered.routingSummary?.llamaUploads, 0, 'no premium request with the default bounds');
    } finally {
      await close(tiered);
    }
  });

  test('--force-tier structured: every page of every PDF is parsed structured and the overrides are cleared', async () => {
    const forced = await build({ typed: ['scan-en'], parse: ['table-en'] }, { routing: 'tiered', forceTier: 'structured' });
    try {
      const jobs = await jobsByFilename(forced.db);
      assert.equal(jobs.size, 2);
      for (const [filename, job] of jobs) {
        assert.equal(job.status, 'ready', `${filename} status`);
        assert.ok(tiersOf(job).length > 0 && tiersOf(job).every((tier) => tier === 'structured'), `${filename}: ${tiersOf(job).join(',')}`);
        assert.equal((job.settings as Row).min_tier, 'structured');
        assert.equal((job.settings as Row).max_tier, 'structured');
      }
      assert.equal(((jobs.get('scan-en.pdf')?.page_ranges as Row[])[0] as Row).preset, 'structured_ocr');
      assert.equal((await rows(forced.db, 'SELECT count(*)::int AS n FROM rag_parse_tier_overrides'))[0]?.n, 0);
    } finally {
      await close(forced);
    }
  });

  test('--force-tier fast: every PDF page is parsed fast, so the scan has no text and is not published', async () => {
    const forced = await build({ typed: ['scan-en'], parse: ['table-en'] }, { routing: 'tiered', forceTier: 'fast' });
    try {
      const jobs = await jobsByFilename(forced.db);
      assert.equal(jobs.size, 2);
      for (const [filename, job] of jobs) {
        assert.ok(tiersOf(job).length > 0 && tiersOf(job).every((tier) => tier === 'fast'), `${filename}: ${tiersOf(job).join(',')}`);
      }
      assert.equal(jobs.get('scan-en.pdf')?.status, 'needs_review');
      assert.deepEqual(
        forced.routingSummary?.needsReview.find((entry) => entry.filename === 'scan-en.pdf'),
        { filename: 'scan-en.pdf', reason: 'max_tier' },
        'the pinned tier is the ceiling the scan needed to rise above',
      );
      const prints = await fingerprints(forced.db);
      assert.equal(prints.has('scan-en.pdf'), false, 'no published chunk for the scan under fast');
      assert.equal((await rows(forced.db, 'SELECT count(*)::int AS n FROM rag_parse_tier_overrides'))[0]?.n, 0);
    } finally {
      await close(forced);
    }
  });

  test('--force-tier premium: every PDF goes to the fake LlamaParse and the budget counters move', async () => {
    const forced = await build({ typed: ['scan-en'], parse: ['table-en'] }, { routing: 'tiered', forceTier: 'premium' });
    try {
      const jobs = await jobsByFilename(forced.db);
      assert.equal(jobs.size, 2);
      for (const [filename, job] of jobs) {
        assert.equal(job.status, 'ready', `${filename} status`);
        assert.ok(tiersOf(job).length > 0 && tiersOf(job).every((tier) => tier === 'premium'), `${filename}: ${tiersOf(job).join(',')}`);
      }
      assert.equal(forced.routingSummary?.llamaUploads, 2, 'one premium upload per PDF');
      const [usage] = await rows(forced.db, 'SELECT COALESCE(SUM(pages_used), 0)::int AS pages FROM rag_parse_budget_usage');
      assert.equal(usage?.pages, 3, 'scan-en (1 page) and table-en (2 pages) were charged');
      const prints = await fingerprints(forced.db);
      assert.ok((prints.get('scan-en.pdf') ?? []).some((chunk) => String(chunk.content).includes('AC-2025-0232')), 'premium text is indexed');
      assert.equal((await rows(forced.db, 'SELECT count(*)::int AS n FROM rag_parse_tier_overrides'))[0]?.n, 0);
    } finally {
      await close(forced);
    }
  });
});

describe('the re-recorded ingest baseline (T-03.1-104)', () => {
  const ROOT = process.cwd();
  /** The ingest baseline as it was before the parse fixtures joined the corpus (03-41 shape, recorded at 925beab2). */
  const PREVIOUS = path.join(ROOT, 'eval/baselines/history/fixture-ingest-baseline.pre-03.1-47.json');
  const CURRENT = path.join(ROOT, 'eval/baselines/fixture-ingest-baseline.json');
  type Baseline = { corpus_sha256: string; runs: unknown[]; items: Record<string, Record<string, Array<number | null>>> };
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Baseline;

  test('every pre-existing item has exactly its previous metrics in every run: the paired differences are zero', () => {
    const previous = read(PREVIOUS);
    const current = read(CURRENT);
    assert.ok(current.runs.length >= 3, 'recorded with at least three runs');
    const moved = Object.keys(previous.items).filter((id) => JSON.stringify(current.items[id]) !== JSON.stringify(previous.items[id]));
    assert.deepEqual(moved, [], `items whose metrics moved: ${moved.join(', ')}`);
  });

  test('the items the new baseline adds are exactly the parse fixture items, on a new corpus hash', () => {
    const previous = read(PREVIOUS);
    const current = read(CURRENT);
    const parseIds = fs
      .readFileSync(path.join(ROOT, 'eval/fixtures/ingest/golden-ingest.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: string; tags?: string[] })
      .filter((item) => item.tags?.includes('parse_fixtures'))
      .map((item) => item.id);
    // Plan 05.1-17 later added the injection categories to golden.jsonl, which ingest mode also scores.
    const injectionIds = fs
      .readFileSync(path.join(ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: string; category: string })
      .filter((item) => item.category === 'injection' || item.category === 'injection_evasive')
      .map((item) => item.id);
    // Plan 03.2-30 added the table_split items to golden-ingest.jsonl; they run against their isolated tenants.
    const tableSplitIds = fs
      .readFileSync(path.join(ROOT, 'eval/fixtures/ingest/golden-ingest.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: string; category: string })
      .filter((item) => item.category === 'table_split')
      .map((item) => item.id);
    // Plan 06-38 added the Phase 6 query-layer items (phase6_* tags and small_talk) to golden.jsonl.
    const phase6Ids = fs
      .readFileSync(path.join(ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: string; category: string; tags?: string[] })
      .filter((item) => item.category === 'small_talk' || (item.tags ?? []).some((tag) => tag.startsWith('phase6_')))
      .map((item) => item.id);
    // Plan 06-39 added the cache_paraphrase and cache_near_miss pairs to golden.jsonl.
    const cachePairIds = fs
      .readFileSync(path.join(ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: string; category: string })
      .filter((item) => item.category === 'cache_paraphrase' || item.category === 'cache_near_miss')
      .map((item) => item.id);
    // Plan 04.2-37 added the Phase 4.2 items (tag phase42) to golden.jsonl.
    const goldenItems = fs
      .readFileSync(path.join(ROOT, 'eval/fixtures/golden.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { id: string; tags?: string[] });
    const phase42Ids = goldenItems.filter((item) => (item.tags ?? []).includes('phase42')).map((item) => item.id);
    // Plan 04.1.1-10 added the colloquial and no_answer term items to golden.jsonl.
    const termIds = goldenItems
      .filter((item) => /^[a-z]+-(colloquial|no_answer)-term-\d{3}$/.test(item.id))
      .map((item) => item.id);
    const added = Object.keys(current.items).filter((id) => !(id in previous.items)).sort();
    assert.ok(parseIds.length >= 30);
    assert.equal(phase42Ids.length, 36);
    assert.equal(phase6Ids.length, 38);
    assert.equal(cachePairIds.length, 27);
    assert.equal(injectionIds.length, 18);
    assert.equal(tableSplitIds.length, 15);
    assert.equal(termIds.length, 18);
    assert.deepEqual(
      added,
      [...parseIds, ...injectionIds, ...tableSplitIds, ...phase6Ids, ...cachePairIds, ...phase42Ids, ...termIds].sort(),
    );
    assert.notEqual(current.corpus_sha256, previous.corpus_sha256, 'the parse fixtures are part of the ingest corpus hash');
  });
});
