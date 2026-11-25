import { BackfillDryRunReportSchema, type BackfillDryRunReport } from '@/lib/rag-eval/contracts.generated';
import type { ParseRoutingConfig } from '../routing/config';
import type { InventoryDuplicateCounts } from './inventory';
import type { SampleCandidate } from './sample';

export interface SampleJob {
  sourceKey: string;
  ext: string;
  size: number;
  status: string;
  docClass: string | null;
  pages: number | null;
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
  premiumPageBudget: number;
  routingConfig: ParseRoutingConfig;
  workerConcurrency: number;
  batchConcurrency: number;
  runner: 'worker' | 'ray';
  embedBatchMode: 'sync' | 'batch_api';
  profiles: ProjectionProfile[];
}

export interface ReportInventory {
  entries: readonly SampleCandidate[];
  duplicates: InventoryDuplicateCounts;
}

export interface ReportBatch {
  budgetUsd: number | null;
  spentUsd: number;
}

export function sampleJobFromRow(_row: Record<string, unknown>, _entry: SampleCandidate | undefined): SampleJob | null {
  return null;
}

export function embeddingLowerBoundUsd(_entries: readonly SampleCandidate[], _snapshot: Pick<ProjectionSnapshot, 'embedBatchMode' | 'profiles'>): number {
  return 0;
}

export function buildReport(
  batch: ReportBatch,
  _sampleJobs: readonly SampleJob[],
  _inventory: ReportInventory,
  _snapshot: ProjectionSnapshot,
): BackfillDryRunReport {
  return BackfillDryRunReportSchema.parse({
    inventory: { files: 0, bytes: 0, pages_estimated: 0 },
    duplicates: { in_inventory: 0, already_existing: 0 },
    sample_size_by_class: {},
    class_shares: {},
    projected_pages_by_tier: {},
    projected_l2_pages: 0,
    projected_l3_pages: 0,
    projected_cost: { premium_parse_usd: 0, vlm_usd: 0, embeddings_usd: 0, total_usd: 0 },
    projected_wall_time_s: 0,
    embedding_cost_by_profile_usd: {},
    budget_usd: batch.budgetUsd,
    fits_budget: false,
  });
}

export function formatReport(_report: BackfillDryRunReport): string[] {
  return [];
}
