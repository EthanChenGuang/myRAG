/**
 * The backfill dry run (D-33 steps 2 to 4): a stratified sample that grows until every class seen by preflight has 20 files, the
 * projection report built from the sample's per-page tiers, and the `rag:backfill` command that reports before it spends.
 */
import { describe, test } from 'node:test';
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
