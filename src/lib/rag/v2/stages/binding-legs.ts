import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';
import { EmbeddingProfileMismatchError } from '../../backend/supabase-rpc';
import type { RankedHit, RetrievalBackend, RetrievalFilters } from '../../backend/types';
import type { RagConfig } from '../../config';
import { getEmbeddingProfileById, LEGACY_PROFILE, type EmbeddingProfile } from '../../embeddings/active-profile';
import { getEffectiveBindings, type EffectiveBinding } from '../../embeddings/bindings';
import { EmbeddingProfileMismatch } from '../../embeddings/mrl';
import { embedQueryForEvalProfile, type QueryEmbedding } from '../../embeddings/query-embedding';
import type { RankedList } from '../../fusion/rrf';
import { scopeKey, type TenantScope } from '../../tenant/scope';
import type { Profile, RetrievalOptions } from '../../types';

export type BindingLegFailureReason = 'timeout' | 'error' | 'mismatch';

export interface BindingLegFailure {
  docType: string;
  reason: BindingLegFailureReason;
}

export interface BindingLegPlan {
  docType: string;
  profileId: string;
  /** Null when an eval override names a profile that could not be resolved; the leg then fails without a provider call. */
  profile: EmbeddingProfile | null;
  source: 'binding' | 'eval_override';
  resolveFailure?: BindingLegFailureReason;
}

export interface BindingLegsPlan {
  legs: BindingLegPlan[];
  /** Eval only: the doc type of the control leg (global profile, global vector, filtered to that type). */
  controlLeg: string | null;
  /** Failures known before any leg runs (the binding registry could not be read). */
  failures: BindingLegFailure[];
}

export type BindingEmbed = { vector: number[] } | { failure: BindingLegFailureReason };

export interface PlanBindingLegsInput {
  profile: Profile;
  config: RagConfig;
  scope: TenantScope;
  filters: RetrievalFilters;
  options?: RetrievalOptions;
}

export interface BindingLegDeps {
  effectiveBindings: (tenantKey: string) => Promise<EffectiveBinding[]>;
  profileById: (id: string) => Promise<EmbeddingProfile>;
}

export type BindingEmbedFn = (text: string, signal: AbortSignal, profile: EmbeddingProfile) => Promise<QueryEmbedding>;

export async function planBindingLegs(_input: PlanBindingLegsInput, _deps?: BindingLegDeps): Promise<BindingLegsPlan> {
  return { legs: [], controlLeg: null, failures: [] };
}

export function hasBindingWork(_plan: BindingLegsPlan): boolean {
  return false;
}

export function bindingHashFields(_plan: BindingLegsPlan): { embeddingBindings?: Record<string, string>; domainControlLeg?: string } {
  return {};
}

export function startBindingEmbeds(
  legs: readonly BindingLegPlan[],
  _text: string,
  _signal: AbortSignal,
  _timeoutMs: number,
  _embed: BindingEmbedFn = embedQueryForEvalProfile,
): Promise<BindingEmbed>[] {
  return legs.map(async () => ({ failure: 'error' as const }));
}

export interface RunBindingLegsInput {
  backend: RetrievalBackend;
  scope: TenantScope;
  filters: RetrievalFilters;
  params: RetrievalParams;
  plan: BindingLegsPlan;
  embeds: readonly Promise<BindingEmbed>[];
  globalEmbedding: QueryEmbedding;
  signal: AbortSignal;
  timeoutMs: number;
  chunkingProfileOverride?: Record<string, string>;
}

export interface BindingLegsOutput {
  lists: RankedList[];
  failures: BindingLegFailure[];
  counts: Record<string, number>;
}

export async function runBindingLegs(_input: RunBindingLegsInput): Promise<BindingLegsOutput> {
  return { lists: [], failures: [], counts: {} };
}

export function bindingFailureDetail(_failures: readonly BindingLegFailure[]): string | undefined {
  return undefined;
}
