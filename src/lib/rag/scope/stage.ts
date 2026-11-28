import type { QueryPlan, ScopeGateResult } from '@/lib/rag-eval/contracts.generated';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import type { TenantScope } from '../tenant/scope';
import type { QueryVariant, RagMode } from '../types';
import { scopeGateCalibrationFor } from './calibration';
import { getCentroidSnapshot } from './centroids';
import { scoreScope } from './score';

export interface ScopeGateStageInput {
  scope: TenantScope;
  /** The profile the query embeddings were made with; the snapshot and the calibration cell are read for it. */
  embeddingProfileId: string;
  ragMode: RagMode;
  /** 06.2-26: true for the eval profile only; a fixture calibration decides nothing else. */
  evalRun?: boolean;
  /** The variants the embed stage embedded, index-aligned with embeddings. */
  variants: readonly QueryVariant[];
  embeddings: readonly QueryEmbedding[];
  queryPlan: QueryPlan | null;
}

/** P-04: every variant but HyDE is scored (original, condensed, translated, sub-questions, history fallback, expansions). */
function scoredVectors(variants: readonly QueryVariant[], embeddings: readonly QueryEmbedding[]): number[][] {
  const vectors: number[][] = [];
  embeddings.forEach((embedding, index) => {
    if (variants[index]?.kind === 'hyde') return;
    vectors.push(embedding.vector);
  });
  return vectors;
}

/** Research Pitfall 5: the query layer was asked to translate and the translate transform did not run. */
function translateSkipped(plan: QueryPlan | null): boolean {
  if (!plan) return false;
  return plan.gate.transforms.includes('translate') && (plan.skipped ?? []).some((entry) => entry.transform === 'translate');
}

/**
 * D-26: the scope_gate stage body. Reads the tenant's cached centroid snapshot (never awaits I/O), the calibration cell for the
 * embedding profile and RAG mode, and scores the embeddings the embed stage already made. No LLM call, no I/O.
 */
export function runScopeGateStage(input: ScopeGateStageInput): ScopeGateResult {
  const started = performance.now();
  const snapshot = getCentroidSnapshot(input.scope, input.embeddingProfileId);
  const scored = scoreScope({
    queryVectors: scoredVectors(input.variants, input.embeddings),
    snapshot,
    cell: scopeGateCalibrationFor(input.embeddingProfileId, input.ragMode, { evalRun: input.evalRun === true }),
    flags: { translateSkipped: translateSkipped(input.queryPlan) },
  });
  return { ...scored, latency_ms: Math.max(0, performance.now() - started) };
}

/** D-26: a stage that timed out or threw is unsure and never degrades the retrieval status. */
export function scopeGateFailOpen(reason: 'timeout' | 'failed' | 'disabled'): ScopeGateResult {
  return { label: 'unsure', score: null, negative_score: null, reason, centroid_count: 0, latency_ms: 0 };
}

const loggedProblems = new Set<string>();

/** Logs a stage problem once per reason, with the reason only. */
export function logScopeGateProblem(reason: string): void {
  if (loggedProblems.has(reason)) return;
  loggedProblems.add(reason);
  console.warn(`[Scope Gate] stage_unavailable reason=${reason}`);
}

export function resetScopeGateStageLogForTests(): void {
  loggedProblems.clear();
}
