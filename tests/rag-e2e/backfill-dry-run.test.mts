/**
 * The backfill dry run (D-33 steps 2 to 4): a stratified sample that grows until every class seen by preflight has 20 files, the
 * projection report built from the sample's per-page tiers, and the `rag:backfill` command that reports before it spends.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BackfillDryRunReportSchema } from '@/lib/rag-eval/contracts.generated';
import { loadRoutingConfig } from '@/lib/rag/ingest/routing/config';
import { selectSample, stratumOf, type SampleCandidate } from '@/lib/rag/ingest/backfill/sample';
import { buildReport, embeddingLowerBoundUsd, type ProjectionSnapshot, type SampleJob } from '@/lib/rag/ingest/backfill/report';

const KIB = 1024;
const MIB = 1024 * KIB;
const EXTS = ['pdf', 'docx', 'txt', 'png'] as const;
const SIZES = [10 * KIB, 1 * MIB, 8 * MIB] as const;

function archive(count: number): SampleCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    sourceKey: `archive/${String(index).padStart(5, '0')}.${EXTS[index % 4]}`,
    ext: EXTS[index % 4] as string,
    size: SIZES[Math.floor(index / 4) % 3] as number,
  }));
}

/** What preflight would call each file: a stand-in rule that depends on the stratum only. */
function classOf(entry: SampleCandidate): string {
  if (entry.ext === 'png') return 'image';
  if (entry.ext === 'txt') return 'native';
  if (entry.ext === 'pdf' && entry.size >= 8 * MIB) return 'scanned';
  return 'text_pdf';
}

/** Runs selectSample the way the orchestrator does: sample, learn the classes of the sampled files, grow, until nothing is added. */
function grow(inventory: SampleCandidate[], seed: string, classify: (entry: SampleCandidate) => string = classOf): SampleCandidate[] {
  const classes = new Map<string, string | null>();
  let selected: SampleCandidate[] = [];
  for (let round = 0; round < 20; round += 1) {
    selected = selectSample(inventory, classes, seed).entries;
    const before = classes.size;
    for (const entry of selected) if (!classes.has(entry.sourceKey)) classes.set(entry.sourceKey, classify(entry));
    if (classes.size === before) break;
  }
  return selected;
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

describe('stratified sample (D-33 step 2)', () => {
  test('sample: 2,000 files across 4 extensions and 3 size buckets give an initial 20-file sample covering every stratum', () => {
    const inventory = archive(2000);
    const strata = new Set(inventory.map(stratumOf));
    assert.equal(strata.size, 12);
    const first = selectSample(inventory, new Map(), 'batch-seed-1');
    assert.equal(first.entries.length, 20);
    assert.equal(first.initial, 20);
    assert.equal(first.cap, 100);
    assert.deepEqual(new Set(first.entries.map(stratumOf)), strata, 'every stratum has a sampled file');
    assert.equal(new Set(first.entries.map((entry) => entry.sourceKey)).size, 20, 'no file twice');

    const again = selectSample(inventory, new Map(), 'batch-seed-1');
    assert.deepEqual(
      again.entries.map((entry) => entry.sourceKey),
      first.entries.map((entry) => entry.sourceKey),
      'the same seed gives the same sample',
    );
    const other = selectSample(inventory, new Map(), 'batch-seed-2');
    assert.notDeepEqual(
      other.entries.map((entry) => entry.sourceKey).sort(),
      first.entries.map((entry) => entry.sourceKey).sort(),
      'another seed gives another sample',
    );
  });

  test('sample: small inventories still take one file of every stratum and never more files than exist', () => {
    const inventory = archive(30);
    const first = selectSample(inventory, new Map(), 's');
    assert.equal(first.entries.length, 12, 'one per stratum beats 1% of 30');
    assert.equal(selectSample(archive(5), new Map(), 's').entries.length, 5);
    assert.equal(selectSample([], new Map(), 's').entries.length, 0);
  });

  test('sample: grows until every class seen by preflight has 20 sampled files, within 5% of the inventory', () => {
    const inventory = archive(2000);
    const sample = grow(inventory, 'batch-seed-1');
    assert.ok(sample.length > 20, `the sample grew (${sample.length})`);
    assert.ok(sample.length <= 100, `at most 5% of the inventory (${sample.length})`);
    const byClass = countBy(sample, classOf);
    for (const name of ['image', 'native', 'scanned', 'text_pdf']) assert.ok((byClass[name] ?? 0) >= 20, `${name}: ${byClass[name]}`);
    const initial = new Set(selectSample(inventory, new Map(), 'batch-seed-1').entries.map((entry) => entry.sourceKey));
    for (const key of initial) assert.ok(sample.some((entry) => entry.sourceKey === key), 'growth keeps the initial sample');
  });

  test('sample: growth takes every file of a class smaller than 20 and adds files only from strata that showed the class', () => {
    const inventory = archive(2000);
    // Seven large tif scans hide in the archive; the first round finds one of them.
    for (let index = 0; index < 7; index += 1) inventory.push({ sourceKey: `scans/${index}.tif`, ext: 'tif', size: 8 * MIB });
    const classify = (entry: SampleCandidate) => (entry.ext === 'tif' ? 'scanned_tif' : entry.ext === 'png' ? 'image' : 'text_pdf');
    const first = selectSample(inventory, new Map(), 'seed-small');
    assert.equal(first.entries.filter((entry) => entry.ext === 'tif').length, 1, 'the tif stratum has one file in the initial sample');
    const classes = new Map(first.entries.map((entry) => [entry.sourceKey, classify(entry)] as const));
    const grown = selectSample(inventory, classes, 'seed-small');
    assert.equal(grown.entries.filter((entry) => entry.ext === 'tif').length, 7, 'every file of the small class');
    const added = grown.entries.filter((entry) => !classes.has(entry.sourceKey));
    assert.equal(grown.added, added.length);
    const imageStrata = new Set(first.entries.filter((entry) => entry.ext === 'png').map(stratumOf));
    for (const entry of added) {
      if (entry.ext === 'tif') continue;
      if (entry.ext === 'png') assert.ok(imageStrata.has(stratumOf(entry)));
    }
    assert.ok(grown.entries.length <= Math.ceil(inventory.length * 0.05));
  });

  test('sample: growth stops at 5% of the inventory when many classes are short', () => {
    const inventory = archive(2000);
    // Every file is its own class: no class can reach 20, so the sample fills up to the cap and stops.
    const sample = grow(inventory, 'seed-cap', (entry) => entry.sourceKey);
    assert.equal(sample.length, 100);
  });

  test('sample: a failed sample job (no class) still counts as sampled and is never replaced', () => {
    const inventory = archive(2000);
    const first = selectSample(inventory, new Map(), 'seed-fail');
    const classes = new Map<string, string | null>(first.entries.map((entry) => [entry.sourceKey, null] as const));
    const next = selectSample(inventory, classes, 'seed-fail');
    assert.equal(next.entries.length, 20, 'no class was seen, so nothing grows');
    assert.equal(next.added, 0);
  });
});

function snapshot(overrides: Partial<ProjectionSnapshot> = {}): ProjectionSnapshot {
  return {
    routing: 'tiered',
    cloudAllowed: true,
    premiumPageBudget: 1000,
    routingConfig: loadRoutingConfig(),
    workerConcurrency: 4,
    batchConcurrency: 4,
    runner: 'worker',
    embedBatchMode: 'sync',
    profiles: [{ id: 'openai-3-small-1536', provider: 'openai' }],
    ...overrides,
  };
}

function job(entry: SampleCandidate, fields: Partial<SampleJob> = {}): SampleJob {
  return {
    sourceKey: entry.sourceKey,
    ext: entry.ext,
    size: entry.size,
    status: 'ready',
    docClass: 'text_pdf',
    pages: 10,
    tierPageCounts: { native: 0, fast: 8, structured: 1, premium: 1 },
    l2Pages: 2,
    l3Pages: 1,
    ...fields,
  };
}

function pdfs(count: number, size = 100_000, prefix = 'docs'): SampleCandidate[] {
  return Array.from({ length: count }, (_, index) => ({ sourceKey: `${prefix}/${index}.pdf`, ext: 'pdf', size }));
}

const NO_DUPLICATES = { inInventory: 0, alreadyExisting: 0 };

describe('projection report (D-33 step 3)', () => {
  test('report: pages per tier are the sample per-page tier shares times the inventory pages; L2 and L3 scale the same way', () => {
    const entries = pdfs(1000);
    const sampleJobs = entries.slice(0, 10).map((entry) => job(entry));
    const report = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, { entries, duplicates: { inInventory: 3, alreadyExisting: 2 } }, snapshot());
    assert.deepEqual(report.inventory, { files: 1000, bytes: 100_000_000, pages_estimated: 10_000 });
    assert.deepEqual(report.duplicates, { in_inventory: 3, already_existing: 2 });
    assert.deepEqual(report.projected_pages_by_tier, { native: 0, fast: 8000, structured: 1000, premium: 1000 });
    assert.equal(report.projected_l2_pages, 2000);
    assert.equal(report.projected_l3_pages, 1000);
    assert.deepEqual(report.sample_size_by_class, { text_pdf: 10 });
    assert.deepEqual(report.class_shares, { text_pdf: 1 });
    assert.equal(report.budget_usd, null);
    assert.equal(report.fits_budget, false, 'no budget never fits');
    BackfillDryRunReportSchema.parse(report);
  });

  test('report: costs come from parse-routing.json and the embedding price table, batch_api at half the sync price per profile', () => {
    const cfg = loadRoutingConfig();
    const premiumUsd = cfg.costs.tier.premium.usd_per_page;
    const l3Usd = cfg.costs.layer.L3.usd_per_page;
    const entries = pdfs(1000);
    const sampleJobs = entries.slice(0, 10).map((entry) => job(entry));
    const profiles = [
      { id: 'openai-3-small-1536', provider: 'openai' },
      { id: 'voyage-3', provider: 'voyage' },
    ];
    const sync = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, { entries, duplicates: NO_DUPLICATES }, snapshot({ profiles }));
    // 10,000 pages at 500 tokens a page: 5M tokens.
    assert.equal(sync.embedding_cost_by_profile_usd['openai-3-small-1536'], 0.1);
    assert.equal(sync.embedding_cost_by_profile_usd['voyage-3'], 0.6);
    assert.equal(sync.projected_cost.premium_parse_usd, Number((1000 * premiumUsd).toFixed(6)));
    assert.equal(sync.projected_cost.vlm_usd, Number((1000 * l3Usd).toFixed(6)));
    assert.equal(sync.projected_cost.embeddings_usd, 0.7);
    assert.equal(sync.projected_cost.total_usd, Number((1000 * premiumUsd + 1000 * l3Usd + 0.7).toFixed(6)));

    const batch = buildReport(
      { budgetUsd: null, spentUsd: 0 },
      sampleJobs,
      { entries, duplicates: NO_DUPLICATES },
      snapshot({ profiles, embedBatchMode: 'batch_api' }),
    );
    assert.equal(batch.embedding_cost_by_profile_usd['openai-3-small-1536'], 0.05, 'OpenAI at the Batch API price');
    assert.equal(batch.embedding_cost_by_profile_usd['voyage-3'], 0.6, 'no batch price for a provider without a Batch API');
    assert.equal(batch.projected_cost.embeddings_usd, 0.65);
  });

  test('report: the budget fits only when the projection plus what the batch already spent stays within it', () => {
    const entries = pdfs(1000);
    const sampleJobs = entries.slice(0, 10).map((entry) => job(entry));
    const total = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, { entries, duplicates: NO_DUPLICATES }, snapshot()).projected_cost.total_usd;
    const inventory = { entries, duplicates: NO_DUPLICATES };
    assert.equal(buildReport({ budgetUsd: total + 1, spentUsd: 0 }, sampleJobs, inventory, snapshot()).fits_budget, true);
    assert.equal(buildReport({ budgetUsd: total - 0.01, spentUsd: 0 }, sampleJobs, inventory, snapshot()).fits_budget, false);
    assert.equal(buildReport({ budgetUsd: total + 1, spentUsd: 1.5 }, sampleJobs, inventory, snapshot()).fits_budget, false, 'the sample premium spend counts');
    assert.equal(buildReport({ budgetUsd: total + 1, spentUsd: 0 }, [], inventory, snapshot()).fits_budget, false, 'no usable sample never fits');
    assert.equal(buildReport({ budgetUsd: 0, spentUsd: 0 }, [], { entries: [], duplicates: NO_DUPLICATES }, snapshot()).fits_budget, true, 'nothing to do fits');
  });

  test('report: premium pages are projected only when premium can run; fixed routing sends every page through the Phase 3 chain', () => {
    const entries = pdfs(1000);
    const sampleJobs = entries.slice(0, 10).map((entry) => job(entry));
    const inventory = { entries, duplicates: NO_DUPLICATES };
    for (const blocked of [snapshot({ cloudAllowed: false }), snapshot({ premiumPageBudget: 0 })]) {
      const report = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, inventory, blocked);
      assert.deepEqual(report.projected_pages_by_tier, { native: 0, fast: 8000, structured: 2000, premium: 0 });
      assert.equal(report.projected_cost.premium_parse_usd, 0);
    }
    const fixedCloud = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, inventory, snapshot({ routing: 'fixed' }));
    assert.deepEqual(fixedCloud.projected_pages_by_tier, { native: 0, fast: 0, structured: 0, premium: 10_000 });
    const fixedLocal = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, inventory, snapshot({ routing: 'fixed', cloudAllowed: false }));
    assert.deepEqual(fixedLocal.projected_pages_by_tier, { native: 0, fast: 0, structured: 10_000, premium: 0 });
  });

  test('report: each stratum is scaled by its own inventory bytes, so an over-sampled small stratum does not skew the tiers', () => {
    const small = pdfs(100, 1000, 'small');
    const large = pdfs(10, 1_000_000, 'large');
    const sampleJobs = [
      job(small[0] as SampleCandidate, { pages: 1, tierPageCounts: { fast: 1 }, l2Pages: 0, l3Pages: 0, docClass: 'text_pdf' }),
      job(small[1] as SampleCandidate, { pages: 1, tierPageCounts: { fast: 1 }, l2Pages: 0, l3Pages: 0, docClass: 'text_pdf' }),
      job(large[0] as SampleCandidate, { pages: 100, tierPageCounts: { structured: 100 }, l2Pages: 0, l3Pages: 0, docClass: 'scanned' }),
    ];
    const report = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, { entries: [...small, ...large], duplicates: NO_DUPLICATES }, snapshot());
    assert.deepEqual(report.projected_pages_by_tier, { native: 0, fast: 100, structured: 1000, premium: 0 });
    assert.equal(report.inventory.pages_estimated, 1100);
    assert.deepEqual(report.sample_size_by_class, { text_pdf: 2, scanned: 1 });
    assert.equal(report.class_shares.text_pdf, Number((100 / 110).toFixed(4)));
    assert.equal(report.class_shares.scanned, Number((10 / 110).toFixed(4)));
  });

  test('report: wall time is tier pages times seconds per page plus the per-document overhead, over the effective parallelism', () => {
    const cfg = loadRoutingConfig();
    const entries = pdfs(1000);
    const sampleJobs = entries.slice(0, 10).map((entry) => job(entry));
    const inventory = { entries, duplicates: NO_DUPLICATES };
    const work = 8000 * cfg.costs.tier.fast.s_per_page + 1000 * cfg.costs.tier.structured.s_per_page + 1000 * cfg.costs.tier.premium.s_per_page + 1000 * 2;
    // Batch jobs hold at most worker concurrency - 1 slots (03.1-46).
    const worker = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, inventory, snapshot({ batchConcurrency: 8, workerConcurrency: 4 }));
    assert.equal(worker.projected_wall_time_s, Number((work / 3).toFixed(1)));
    const narrow = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, inventory, snapshot({ batchConcurrency: 2, workerConcurrency: 4 }));
    assert.equal(narrow.projected_wall_time_s, Number((work / 2).toFixed(1)));
    const single = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, inventory, snapshot({ batchConcurrency: 4, workerConcurrency: 1 }));
    assert.equal(single.projected_wall_time_s, Number(work.toFixed(1)));
    const ray = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, inventory, snapshot({ batchConcurrency: 8, workerConcurrency: 4, runner: 'ray' }));
    assert.equal(ray.projected_wall_time_s, Number((work / 8).toFixed(1)));
  });

  test('report: text files are priced by their bytes, images by a caption, and failed sample jobs are listed as unclassified', () => {
    const texts = Array.from({ length: 10 }, (_, index) => ({ sourceKey: `t/${index}.txt`, ext: 'txt', size: 40_000 }));
    const images = Array.from({ length: 10 }, (_, index) => ({ sourceKey: `i/${index}.png`, ext: 'png', size: 40_000 }));
    const sampleJobs = [
      job(texts[0] as SampleCandidate, { docClass: 'native', pages: 1, tierPageCounts: { native: 1 }, l2Pages: 0, l3Pages: 0 }),
      job(images[0] as SampleCandidate, { docClass: 'image', pages: 1, tierPageCounts: { native: 1 }, l2Pages: 0, l3Pages: 0 }),
      job(images[1] as SampleCandidate, { status: 'failed', docClass: null, pages: null, tierPageCounts: {}, l2Pages: 0, l3Pages: 0 }),
    ];
    const report = buildReport({ budgetUsd: null, spentUsd: 0 }, sampleJobs, { entries: [...texts, ...images], duplicates: NO_DUPLICATES }, snapshot());
    // 10 text files of 40,000 bytes at 4 bytes a token, and 10 images at 200 caption tokens.
    assert.equal(report.embedding_cost_by_profile_usd['openai-3-small-1536'], Number((((10 * 10_000 + 10 * 200) * 0.02) / 1e6).toFixed(6)));
    assert.deepEqual(report.sample_size_by_class, { native: 1, image: 1, unclassified: 1 });
    assert.equal(
      embeddingLowerBoundUsd([...texts, ...images], snapshot()),
      Number(((10 * 10_000 * 0.02) / 1e6).toFixed(6)),
      'the pre-sample bound counts text files only',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The command: report before spending, run only within the budget (D-31 to D-34, D-36, D-37)
// ---------------------------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

describe('rag:backfill orchestration and exit codes', () => {
  let harness: import('../../eval/harness/queued-ingest.mts').QueuedHarness;
  let cli: typeof import('@/lib/rag/ingest/backfill/cli');
  let tenant: string;
  let folder: string;
  let stopWorker: () => void = () => undefined;

  function textFile(label: string): Buffer {
    return Buffer.from(`# ${label}\n\nThe ${label} note describes one shelf of the archive in a few plain sentences.\n`, 'utf8');
  }

  /** A worker stand-in: every queued job of a batch ends ready, dry runs with a native one-page preflight result. */
  function fakeWorker(): () => void {
    const timer = setInterval(() => {
      harness
        .rows(
          `UPDATE ingestion_jobs
              SET status = 'ready', stage = 'ready', doc_class = 'native', pages = 1,
                  tier_page_counts = '{"native":1,"fast":0,"structured":0,"premium":0}'::jsonb,
                  detect_counts = '{"L1":1,"L2":0,"L3":0,"gated_share":0}'::jsonb
            WHERE batch_id IS NOT NULL AND status = 'queued' AND deleted_at IS NULL`,
        )
        .catch(() => undefined);
    }, 40);
    return () => clearInterval(timer);
  }

  async function runCli(args: string[], overrides: Record<string, unknown> = {}): Promise<{ code: number; out: string[]; err: string[]; batchId: string | null }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await cli.main(args, { out: (line) => out.push(line), err: (line) => err.push(line) }, new AbortController().signal, {
      monitorIntervalMs: 50,
      ...overrides,
    });
    const match = [...out, ...err].join('\n').match(/batch ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
    return { code, out, err, batchId: match ? (match[1] as string) : null };
  }

  async function batchRow(batchId: string): Promise<Row> {
    const [row] = await harness.rows('SELECT * FROM ingestion_batches WHERE id = $1', [batchId]);
    assert.ok(row, 'batch row');
    return row;
  }

  async function counts(batchId: string, kind: string): Promise<Record<string, number>> {
    const rows = await harness.rows('SELECT status, count(*)::int AS n FROM ingestion_jobs WHERE batch_id = $1 AND kind = $2 GROUP BY status', [batchId, kind]);
    return Object.fromEntries(rows.map((row) => [String(row.status), Number(row.n)]));
  }

  before(async () => {
    const { startQueuedHarness, QUEUED_IDS } = await import('../../eval/harness/queued-ingest.mts');
    harness = await startQueuedHarness();
    const objectStore = await import('@/lib/rag/ingest/object-store');
    objectStore.resetObjectStoreForTests();
    cli = await import('@/lib/rag/ingest/backfill/cli');
    tenant = `o:${QUEUED_IDS.orgB}`;
    const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    folder = await mkdtemp(path.join(os.tmpdir(), 'backfill-dry-run-'));
    await mkdir(path.join(folder, 'copies'));
    for (let index = 0; index < 8; index += 1) await writeFile(path.join(folder, `note-${index}.txt`), textFile(`note-${index}`));
    await writeFile(path.join(folder, 'copies', 'note-0.txt'), textFile('note-0'));
    await writeFile(path.join(folder, 'copies', 'note-1.txt'), textFile('note-1'));
    stopWorker = fakeWorker();
  });

  after(async () => {
    stopWorker();
    await harness?.close();
    if (folder) await (await import('node:fs/promises')).rm(folder, { recursive: true, force: true });
  });

  test('no --budget: inventory, sample and report are printed and stored on the batch, exit 2, no ingest job is enqueued', async () => {
    const result = await runCli(['--tenant', tenant, '--source', `folder:${folder}`]);
    assert.equal(result.code, 2, result.err.join('\n'));
    assert.ok(result.batchId, 'the batch id is printed');
    const row = await batchRow(result.batchId as string);
    const report = BackfillDryRunReportSchema.parse(row.dry_run_report);
    assert.equal(report.inventory.files, 8);
    assert.deepEqual(report.duplicates, { in_inventory: 2, already_existing: 0 });
    assert.equal(report.budget_usd, null);
    assert.equal(report.fits_budget, false);
    assert.equal(row.source_kind, 'folder');
    assert.equal(row.tenant_key, tenant);
    assert.ok(result.out.some((line) => line.includes('projected cost')), 'the report is printed');
    assert.ok(result.err.some((line) => line.includes('--budget')), 'says why it stopped');
    assert.deepEqual(await counts(result.batchId as string, 'ingest'), { skipped_duplicate: 2 }, 'only the inventory duplicates');
    const sample = await counts(result.batchId as string, 'dry_run');
    assert.ok((sample.ready ?? 0) >= 1, 'the sample ran');
  });

  test('--dry-run with --budget: the same report and exit 2, nothing ingested', async () => {
    const result = await runCli(['--tenant', tenant, '--source', `folder:${folder}`, '--budget', '100', '--dry-run']);
    assert.equal(result.code, 2, result.err.join('\n'));
    const row = await batchRow(result.batchId as string);
    const report = BackfillDryRunReportSchema.parse(row.dry_run_report);
    assert.equal(report.budget_usd, 100);
    assert.equal(report.fits_budget, true);
    assert.deepEqual(await counts(result.batchId as string, 'ingest'), { skipped_duplicate: 2 });
  });

  test('--budget below the projection: refused with exit 3 and a message naming the shortfall', async () => {
    const result = await runCli(['--tenant', tenant, '--source', `folder:${folder}`, '--budget', '0.01']);
    assert.equal(result.code, 3, result.err.join('\n'));
    const report = BackfillDryRunReportSchema.parse((await batchRow(result.batchId as string)).dry_run_report);
    assert.equal(report.fits_budget, false);
    const shortfall = report.projected_cost.total_usd - 0.01;
    assert.ok(shortfall > 0);
    assert.ok(
      result.err.some((line) => /short by/.test(line) && line.includes(shortfall.toFixed(6))),
      `names the shortfall: ${result.err.join(' | ')}`,
    );
    assert.deepEqual(await counts(result.batchId as string, 'ingest'), { skipped_duplicate: 2 });
  });

  test('projected embedding cost alone above the budget: refused before the sample runs, exit 3', async () => {
    const result = await runCli(['--tenant', tenant, '--source', `folder:${folder}`, '--budget', '0.000001']);
    assert.equal(result.code, 3, result.err.join('\n'));
    assert.ok(result.err.some((line) => /embedding cost alone/.test(line)), result.err.join(' | '));
    assert.deepEqual(await counts(result.batchId as string, 'dry_run'), {}, 'no sample job');
    assert.deepEqual(await counts(result.batchId as string, 'ingest'), { skipped_duplicate: 2 });
  });

  test('--budget above the projection: ingest jobs at priority 10, monitored to the end, end report printed, exit 0', async () => {
    const result = await runCli(['--tenant', tenant, '--source', `folder:${folder}`, '--budget', '100', '--concurrency', '2']);
    assert.equal(result.code, 0, result.err.join('\n'));
    const batchId = result.batchId as string;
    const row = await batchRow(batchId);
    assert.equal(row.status, 'completed');
    assert.equal(row.concurrency, 2);
    assert.equal(Number(row.budget_usd), 100);
    assert.deepEqual(await counts(batchId, 'ingest'), { ready: 8, skipped_duplicate: 2 });
    const priorities = await harness.rows("SELECT DISTINCT priority FROM ingestion_jobs WHERE batch_id = $1 AND kind = 'ingest' AND status = 'ready'", [batchId]);
    assert.deepEqual(priorities.map((p) => p.priority), [10]);
    const totals = row.totals as Row;
    assert.equal(totals.ready, 8);
    assert.equal(totals.ingest_total, 10);
    assert.ok(result.out.some((line) => /end report/.test(line)), 'end report printed');
  });

  test('success counts exclude dry runs: 20 ready sample jobs never add to the 90 ready of 100 ingest jobs', async () => {
    const [created] = await harness.rows("SELECT id FROM rag_create_ingestion_batch($1, 'folder', '/archive', 5, 2, 'worker', NULL)", [tenant]);
    const batchId = String(created?.id);
    const statuses = [
      ...Array.from({ length: 90 }, () => 'ready'),
      ...Array.from({ length: 6 }, () => 'skipped_duplicate'),
      ...Array.from({ length: 3 }, () => 'needs_review'),
      'failed',
    ];
    const jobs = [
      ...statuses.map((status, index) => ({ kind: 'ingest', source: 'config_upload', source_key: `a/${index}.pdf`, status, settings: {} })),
      ...Array.from({ length: 20 }, (_, index) => ({ kind: 'dry_run', source: 'config_upload', source_key: `a/${index}.pdf`, status: 'ready', settings: {} })),
    ];
    await harness.rows('SELECT rag_enqueue_backfill_jobs($1, $2::jsonb)', [batchId, JSON.stringify(jobs)]);
    const { finishBatch } = await import('@/lib/rag/ingest/backfill/orchestrate');
    const out: string[] = [];
    const end = await finishBatch({ id: batchId, scope: harness.scopeB }, { signal: new AbortController().signal, io: { out: (line) => out.push(line), err: (line) => out.push(line) } });
    assert.equal(end.ingest.total, 100);
    assert.deepEqual(end.ingest.byStatus, { ready: 90, skipped_duplicate: 6, needs_review: 3, failed: 1 });
    assert.deepEqual(end.sample, { total: 20, byStatus: { ready: 20 } });
    const totals = (await batchRow(batchId)).totals as Row;
    assert.equal(totals.ready, 90, 'stored ready excludes the sample');
    assert.equal(totals.ingest_total, 100);
    assert.equal(totals.skipped_duplicate, 6);
    assert.equal(totals.needs_review, 3);
    assert.equal(totals.failed, 1);
    assert.deepEqual(totals.sample, { total: 20, by_status: { ready: 20 } });
    const text = out.join('\n');
    assert.match(text, /ingest jobs 100: ready 90/);
    assert.doesNotMatch(text, /ready 110/);
    assert.match(text, /sample \(dry runs, not ingested\) 20: ready 20/);
  });

  test('unknown flags, a missing --tenant or an invalid tenant: exit 64 with usage', async () => {
    for (const args of [
      ['--tenant', tenant, '--source', `folder:${folder}`, '--bogus'],
      ['--source', `folder:${folder}`],
      ['--tenant', 'x:not-a-tenant', '--source', `folder:${folder}`],
      ['--tenant', 'o:00000000-0000-4000-8000-00000000dead', '--source', `folder:${folder}`],
      ['--tenant', tenant, '--source', 'ftp:somewhere'],
      ['--tenant', tenant, '--source', `folder:${folder}`, '--budget', '-1'],
      ['--tenant', tenant, '--source', `folder:${folder}`, '--runner', 'spark'],
      ['--tenant', tenant, '--resume', 'not-a-uuid'],
      ['--tenant', tenant],
    ]) {
      const result = await runCli(args);
      assert.equal(result.code, 64, `${args.join(' ')} -> ${result.code}: ${result.err.join(' | ')}`);
      assert.ok(result.err.some((line) => line.includes('usage: npm run rag:backfill')), `usage for ${args.join(' ')}`);
    }
  });

  const childEnv = (env: Record<string, string>): NodeJS.ProcessEnv => env as NodeJS.ProcessEnv;

  test('--runner ray builds the uv command line with --extra ray and passes RAY_ADDRESS through', async () => {
    const { rayRunnerCommand, startRunner } = await import('@/lib/rag/ingest/backfill/runners');
    const id = '11111111-2222-4333-8444-555555555555';
    const command = rayRunnerCommand(id, childEnv({ PATH: '/usr/bin', RAY_ADDRESS: 'ray://head.example.invalid:10001' }));
    assert.equal(command.command, 'uv');
    const sidecar = command.args[2] as string;
    assert.deepEqual(command.args, ['run', '--project', sidecar, '--extra', 'ray', 'python', '-m', 'rag_sidecar.ingest.ray_runner', '--batch', id]);
    assert.ok(sidecar.endsWith('rag-sidecar'));
    assert.equal(command.env.RAY_ADDRESS, 'ray://head.example.invalid:10001');
    assert.equal('RAY_ADDRESS' in rayRunnerCommand(id, childEnv({ PATH: '/usr/bin' })).env, false, 'a local Ray instance without RAY_ADDRESS');
    assert.equal('RAY_ADDRESS' in rayRunnerCommand(id, childEnv({ PATH: '/usr/bin', RAY_ADDRESS: '' })).env, false);
    assert.throws(() => rayRunnerCommand(`${id}; rm -rf /`, childEnv({})), /batch id/);

    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const calls: Array<{ command: string; args: readonly string[]; options: Row }> = [];
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: () => true });
    const spawnSpy = ((cmd: string, args: readonly string[], options: Row) => {
      calls.push({ command: cmd, args, options });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const lines: string[] = [];
    const handle = startRunner('ray', id, { io: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, spawn: spawnSpy });
    child.stdout.write('claimed 3 jobs\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0);
    assert.deepEqual(await handle.done, { exitCode: 0 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, 'uv');
    assert.ok(!calls[0]?.options.shell, 'no shell');
    assert.ok(lines.some((line) => line.includes('[Backfill][ray] claimed 3 jobs')), lines.join(' | '));

    const started: Array<[string, string]> = [];
    const result = await runCli(['--tenant', tenant, '--source', `folder:${folder}`, '--runner', 'ray', '--dry-run'], {
      startRunner: (runner: string, batchId: string) => {
        started.push([runner, batchId]);
        return { runner, done: new Promise(() => undefined), stop() {} };
      },
    });
    assert.equal(result.code, 2, result.err.join('\n'));
    assert.equal((await batchRow(result.batchId as string)).runner, 'ray', 'the runner is recorded on the batch');
    assert.ok(started.length >= 1 && started.every(([runner, batchId]) => runner === 'ray' && batchId === result.batchId));
  });

  test('the command never activates an embedding profile', () => {
    const activations = harness.edge.calls.filter((call) => /activate_embedding_profile/.test(call.path));
    assert.equal(activations.length, 0);
    assert.ok(harness.edge.calls.some((call) => call.path.endsWith('/rag_create_ingestion_batch')), 'the spy saw the CLI calls');
  });
});
