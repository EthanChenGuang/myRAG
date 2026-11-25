import { BackfillDryRunReportSchema, type BackfillDryRunReport } from '@/lib/rag-eval/contracts.generated';
import { priceFor } from '../../embeddings/prices';
import type { EmbeddingProviderId } from '../../embeddings/types';
import type { ParseRoutingConfig } from '../routing/config';
import type { InventoryDuplicateCounts } from './inventory';
import { stratumOf, type SampleCandidate } from './sample';

/** One finished (or failed) job of the sample, read from the ledger and joined with its inventory entry. */
export interface SampleJob {
  sourceKey: string;
  ext: string;
  size: number;
  status: string;
  /** The class preflight gave the file; null when the job ended without one. */
  docClass: string | null;
  pages: number | null;
  /** Pages per tier from preflight's per-page tiers (native, fast, structured, premium). */
  tierPageCounts: Record<string, number>;
  l2Pages: number;
  l3Pages: number;
}

export interface ProjectionProfile {
  id: string;
  provider: string;
}

export interface ProjectionSnapshot {
  routing: 'fixed' | 'tiered';
  cloudAllowed: boolean;
  /** RAG_PARSE_PREMIUM_PAGE_BUDGET: 0 means no premium page is ever parsed under tiered routing. */
  premiumPageBudget: number;
  routingConfig: ParseRoutingConfig;
  /** Slots of the sidecar worker (RAG_INGEST_WORKER_CONCURRENCY); batch jobs hold at most one less. */
  workerConcurrency: number;
  batchConcurrency: number;
  runner: 'worker' | 'ray';
  embedBatchMode: 'sync' | 'batch_api';
  /** Every profile a new chunk is embedded for: the active one, backfilling ones and the previous one (P3 D-39 dual-write). */
  profiles: ProjectionProfile[];
}

export interface ReportInventory {
  entries: readonly SampleCandidate[];
  duplicates: InventoryDuplicateCounts;
}

export interface ReportBatch {
  budgetUsd: number | null;
  /** The batch's budget reservations so far: the sample's premium pages count against the budget (D-33 step 2). */
  spentUsd: number;
}

export const TIERS = ['native', 'fast', 'structured', 'premium'] as const;
type Tier = (typeof TIERS)[number];

/** Embedding text per parsed page, chunk headers and overlap included [ASSUMED until a measured run]. */
export const TOKENS_PER_PAGE = 500;
/** Plain text files are embedded as they are: about four bytes a token. */
export const TEXT_BYTES_PER_TOKEN = 4;
/** An image is embedded through its caption. */
export const IMAGE_TOKENS = 200;
/** Claim, the app callbacks and the publish of one document, in seconds [ASSUMED until a measured run]. */
export const CALLBACK_OVERHEAD_S = 2;

const TEXT_EXTS = new Set(['txt', 'md', 'csv']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff']);
const KNOWN_PROVIDERS = new Set<string>(['openai', 'voyage', 'qwen3']);
/** A provider without a price row is priced at the dearest known rate, so an unknown price never makes a run look cheaper. */
const FALLBACK_USD_PER_MILLION = Math.max(...(['openai', 'voyage', 'qwen3'] as const).map((id) => priceFor(id).usdPerMillionTokens));

function usd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A sample job from its ledger row; null for a row that is not a dry run. */
export function sampleJobFromRow(row: Record<string, unknown>, entry: SampleCandidate | undefined): SampleJob | null {
  if (row.kind !== 'dry_run' || typeof row.source_key !== 'string') return null;
  const tierPageCounts: Record<string, number> = {};
  for (const [tier, n] of Object.entries(objectOf(row.tier_page_counts))) {
    const count = numberOf(n);
    if (count !== null && count > 0) tierPageCounts[tier] = Math.round(count);
  }
  const detect = objectOf(row.detect_counts);
  const status = String(row.status);
  const finished = status === 'ready' || status === 'needs_review';
  const pages = numberOf(row.pages);
  return {
    sourceKey: row.source_key,
    ext: entry?.ext ?? '',
    size: entry?.size ?? 0,
    status,
    docClass: finished && typeof row.doc_class === 'string' && row.doc_class !== '' ? row.doc_class : null,
    pages: finished && pages !== null ? pages : null,
    tierPageCounts,
    l2Pages: Math.max(0, numberOf(detect.L2) ?? 0),
    l3Pages: Math.max(0, numberOf(detect.L3) ?? 0),
  };
}

function usable(job: SampleJob): boolean {
  return job.docClass !== null && job.pages !== null && job.pages > 0;
}

function embeddingTokens(ext: string, size: number, docClass: string | null, pages: number): number {
  const lower = ext.toLowerCase();
  if (TEXT_EXTS.has(lower)) return Math.ceil(size / TEXT_BYTES_PER_TOKEN);
  if (docClass === 'image' || IMAGE_EXTS.has(lower)) return IMAGE_TOKENS;
  return pages * TOKENS_PER_PAGE;
}

function profileCost(profile: ProjectionProfile, tokens: number, mode: ProjectionSnapshot['embedBatchMode']): number {
  const perMillion = KNOWN_PROVIDERS.has(profile.provider)
    ? priceFor(profile.provider as EmbeddingProviderId).usdPerMillionTokens
    : FALLBACK_USD_PER_MILLION;
  // D-35: only OpenAI profiles use the Batch API, at half the sync price.
  const factor = mode === 'batch_api' && profile.provider === 'openai' ? 0.5 : 1;
  return (tokens * perMillion * factor) / 1_000_000;
}

function embeddingCosts(tokens: number, snapshot: Pick<ProjectionSnapshot, 'embedBatchMode' | 'profiles'>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const profile of snapshot.profiles) out[profile.id] = usd(profileCost(profile, tokens, snapshot.embedBatchMode));
  return out;
}

/**
 * The embedding cost of the plain text files alone, known before any sample job runs: a lower bound of the projected embedding cost,
 * so a budget it already exceeds is refused before the sample spends anything (D-32).
 */
export function embeddingLowerBoundUsd(entries: readonly SampleCandidate[], snapshot: Pick<ProjectionSnapshot, 'embedBatchMode' | 'profiles'>): number {
  let tokens = 0;
  for (const entry of entries) if (TEXT_EXTS.has(entry.ext.toLowerCase())) tokens += Math.ceil(entry.size / TEXT_BYTES_PER_TOKEN);
  return usd(Object.values(embeddingCosts(tokens, snapshot)).reduce((sum, value) => sum + value, 0));
}

interface Totals {
  tiers: Record<Tier, number>;
  l2: number;
  l3: number;
  tokens: number;
}

function emptyTotals(): Totals {
  return { tiers: { native: 0, fast: 0, structured: 0, premium: 0 }, l2: 0, l3: 0, tokens: 0 };
}

function addScaled(into: Totals, from: Totals, factor: number): void {
  for (const tier of TIERS) into.tiers[tier] += from.tiers[tier] * factor;
  into.l2 += from.l2 * factor;
  into.l3 += from.l3 * factor;
  into.tokens += from.tokens * factor;
}

function jobTotals(job: SampleJob): Totals {
  const totals = emptyTotals();
  const pages = job.pages ?? 0;
  let counted = 0;
  for (const tier of TIERS) {
    const n = job.tierPageCounts[tier] ?? 0;
    totals.tiers[tier] += n;
    counted += n;
  }
  // A job that recorded its page count but no per-page tiers is projected at the fast preset.
  if (counted === 0) totals.tiers.fast += pages;
  totals.l2 = job.l2Pages;
  totals.l3 = job.l3Pages;
  totals.tokens = embeddingTokens(job.ext, job.size, job.docClass, pages);
  return totals;
}

/** Pages a tier would really be parsed at: premium needs the cloud and a page budget; fixed routing runs the Phase 3 chain. */
function routedTiers(tiers: Record<Tier, number>, snapshot: ProjectionSnapshot): Record<Tier, number> {
  const all = TIERS.reduce((sum, tier) => sum + tiers[tier], 0);
  if (snapshot.routing === 'fixed') {
    // The chain sends every file to LlamaParse first when the cloud is allowed, else to Docling.
    return snapshot.cloudAllowed
      ? { native: 0, fast: 0, structured: 0, premium: all }
      : { native: tiers.native, fast: 0, structured: all - tiers.native, premium: 0 };
  }
  if (snapshot.cloudAllowed && snapshot.premiumPageBudget > 0) return { ...tiers };
  return { ...tiers, structured: tiers.structured + tiers.premium, premium: 0 };
}

function effectiveParallelism(snapshot: ProjectionSnapshot): number {
  const batch = Math.max(1, Math.floor(snapshot.batchConcurrency));
  if (snapshot.runner === 'ray') return batch;
  // Batch jobs hold at most worker concurrency - 1 slots; a single-slot worker takes one only when idle (03.1-46).
  const workerSlots = Math.max(1, Math.floor(snapshot.workerConcurrency) - 1);
  return Math.max(1, Math.min(batch, workerSlots));
}

/**
 * D-33 step 3 and the research projection formulas. Each stratum (extension and size bucket) of the inventory is projected from its own
 * usable sample jobs, scaled by inventory bytes over sampled bytes; a stratum without one uses the whole sample's per-byte rates. So the
 * pages per tier are the sample's per-page tier shares (weighted by stratum) times the inventory pages.
 *
 * - cost = premium pages × premium $/page + L3 pages × L3 $/page + tokens × embedding price per profile (Batch API at half price)
 * - wall time = (Σ pages_tier × s_per_page_tier + documents × callback overhead) / effective parallelism
 *
 * Parse compute of the local tiers is not part of the budget (D-32 counts premium pages and embeddings). The result validates as
 * BackfillDryRunReport. fits_budget needs a budget, a usable sample (unless there is nothing to ingest) and spent + total within it.
 */
export function buildReport(
  batch: ReportBatch,
  sampleJobs: readonly SampleJob[],
  inventory: ReportInventory,
  snapshot: ProjectionSnapshot,
): BackfillDryRunReport {
  const strata = new Map<string, { files: number; bytes: number }>();
  for (const entry of inventory.entries) {
    const stratum = stratumOf(entry);
    const current = strata.get(stratum) ?? { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += entry.size;
    strata.set(stratum, current);
  }

  const sampleSize: Record<string, number> = {};
  const sampled = new Map<string, { jobs: number; bytes: number; totals: Totals; classes: Map<string, number> }>();
  const global = { bytes: 0, totals: emptyTotals(), jobs: 0 };
  for (const job of sampleJobs) {
    const name = job.docClass ?? 'unclassified';
    sampleSize[name] = (sampleSize[name] ?? 0) + 1;
    if (!usable(job)) continue;
    const stratum = stratumOf(job);
    const current = sampled.get(stratum) ?? { jobs: 0, bytes: 0, totals: emptyTotals(), classes: new Map<string, number>() };
    const totals = jobTotals(job);
    current.jobs += 1;
    current.bytes += Math.max(1, job.size);
    addScaled(current.totals, totals, 1);
    current.classes.set(job.docClass as string, (current.classes.get(job.docClass as string) ?? 0) + 1);
    sampled.set(stratum, current);
    global.jobs += 1;
    global.bytes += Math.max(1, job.size);
    addScaled(global.totals, totals, 1);
  }

  const projected = emptyTotals();
  const classFiles = new Map<string, number>();
  let classTotal = 0;
  for (const [stratum, { files, bytes }] of strata) {
    const own = sampled.get(stratum);
    if (own) {
      addScaled(projected, own.totals, Math.max(1, bytes) / own.bytes);
      for (const [docClass, n] of own.classes) {
        const share = (files * n) / own.jobs;
        classFiles.set(docClass, (classFiles.get(docClass) ?? 0) + share);
        classTotal += share;
      }
    } else if (global.jobs > 0) {
      addScaled(projected, global.totals, Math.max(1, bytes) / global.bytes);
    }
  }

  const rounded = Object.fromEntries(TIERS.map((tier) => [tier, Math.round(projected.tiers[tier])])) as Record<Tier, number>;
  const tiers = routedTiers(rounded, snapshot);
  const pagesEstimated = TIERS.reduce((sum, tier) => sum + rounded[tier], 0);
  const l2 = Math.round(projected.l2);
  const l3 = Math.round(projected.l3);
  const tokens = Math.round(projected.tokens);

  const cfg = snapshot.routingConfig;
  const premiumUsd = usd(tiers.premium * cfg.costs.tier.premium.usd_per_page);
  const vlmUsd = usd(l3 * cfg.costs.layer.L3.usd_per_page);
  const byProfile = embeddingCosts(tokens, snapshot);
  const embeddingsUsd = usd(Object.values(byProfile).reduce((sum, value) => sum + value, 0));
  const totalUsd = usd(premiumUsd + vlmUsd + embeddingsUsd);

  const seconds =
    TIERS.reduce((sum, tier) => sum + tiers[tier] * cfg.costs.tier[tier].s_per_page, 0) + inventory.entries.length * CALLBACK_OVERHEAD_S;
  const wallTime = Math.round((seconds / effectiveParallelism(snapshot)) * 10) / 10;

  const classShares: Record<string, number> = {};
  for (const [docClass, files] of classFiles) classShares[docClass] = Math.round((files / classTotal) * 1e4) / 1e4;

  const projectionKnown = inventory.entries.length === 0 || global.jobs > 0;
  const fits = batch.budgetUsd !== null && projectionKnown && usd(batch.spentUsd + totalUsd) <= batch.budgetUsd;

  return BackfillDryRunReportSchema.parse({
    inventory: { files: inventory.entries.length, bytes: inventory.entries.reduce((sum, entry) => sum + entry.size, 0), pages_estimated: pagesEstimated },
    duplicates: { in_inventory: inventory.duplicates.inInventory, already_existing: inventory.duplicates.alreadyExisting },
    sample_size_by_class: sampleSize,
    class_shares: classShares,
    projected_pages_by_tier: tiers,
    projected_l2_pages: l2,
    projected_l3_pages: l3,
    projected_cost: { premium_parse_usd: premiumUsd, vlm_usd: vlmUsd, embeddings_usd: embeddingsUsd, total_usd: totalUsd },
    projected_wall_time_s: wallTime,
    embedding_cost_by_profile_usd: byProfile,
    budget_usd: batch.budgetUsd,
    fits_budget: fits,
  });
}

function money(value: number): string {
  return value >= 1 ? value.toFixed(2) : value.toFixed(6);
}

function duration(seconds: number): string {
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** Counts, pages and dollars only: never a file name or any parsed text. */
export function formatReport(report: BackfillDryRunReport): string[] {
  const shares = Object.entries(report.class_shares)
    .sort(([, a], [, b]) => b - a)
    .map(([name, share]) => `${name} ${(share * 100).toFixed(1)}%`)
    .join(', ');
  const sample = Object.entries(report.sample_size_by_class)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
  const tiers = TIERS.map((tier) => `${tier} ${report.projected_pages_by_tier[tier] ?? 0}`).join(', ');
  const profiles = Object.entries(report.embedding_cost_by_profile_usd)
    .map(([id, value]) => `${id} ${money(value)} USD`)
    .join(', ');
  const cost = report.projected_cost;
  return [
    `inventory: ${report.inventory.files} files, ${report.inventory.bytes} bytes, about ${report.inventory.pages_estimated} pages`,
    `duplicates: ${report.duplicates.in_inventory} inside the source, ${report.duplicates.already_existing} already in the knowledge base`,
    `sample size by class: ${sample || 'none'}`,
    `class shares: ${shares || 'none'}`,
    `projected pages by tier: ${tiers}`,
    `projected detection pages: L2 ${report.projected_l2_pages}, L3 ${report.projected_l3_pages}`,
    `projected cost: premium parse ${money(cost.premium_parse_usd)} USD, L3 ${money(cost.vlm_usd)} USD, embeddings ${money(cost.embeddings_usd)} USD, total ${money(cost.total_usd)} USD`,
    `embedding cost by profile: ${profiles || 'none'}`,
    `projected wall time: ${duration(report.projected_wall_time_s)}`,
    `budget: ${report.budget_usd === null ? 'none' : `${money(report.budget_usd)} USD`}, fits: ${report.fits_budget ? 'yes' : 'no'}`,
  ];
}
