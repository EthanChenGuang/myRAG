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
  /** The profile mismatch kind (for example unknown_profile) when resolveFailure is mismatch. */
  resolveKind?: string;
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

/** D-17: only these v2 profiles run binding legs; voice and the legacy pipeline never do. */
const BINDING_LEG_PROFILES: readonly Profile[] = ['chat', 'embed', 'eval'];

const EMPTY_PLAN: BindingLegsPlan = Object.freeze({ legs: [], controlLeg: null, failures: [] }) as BindingLegsPlan;

const DEFAULT_DEPS: BindingLegDeps = {
  effectiveBindings: getEffectiveBindings,
  profileById: getEmbeddingProfileById,
};

function failureReason(error: unknown): BindingLegFailureReason {
  if (error instanceof EmbeddingProfileMismatchError || error instanceof EmbeddingProfileMismatch) return 'mismatch';
  return 'error';
}

function inDocTypeFilter(filters: RetrievalFilters, docType: string): boolean {
  const docTypes = filters.docTypes;
  return docTypes === undefined || docTypes.length === 0 || docTypes.includes(docType);
}

async function overrideLegs(overrides: Record<string, string | undefined>, deps: BindingLegDeps): Promise<BindingLegPlan[]> {
  const entries = Object.entries(overrides).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
  return Promise.all(
    entries.map(async ([docType, profileId]): Promise<BindingLegPlan> => {
      try {
        return { docType, profileId, profile: await deps.profileById(profileId), source: 'eval_override' };
      } catch (error) {
        return {
          docType,
          profileId,
          profile: null,
          source: 'eval_override',
          resolveFailure: failureReason(error),
          ...(error instanceof EmbeddingProfileMismatchError ? { resolveKind: error.kind } : {}),
        };
      }
    }),
  );
}

/**
 * The binding legs one request runs (D-17, D-18, D-22): effective non-stale bindings of the request's tenant (or, for the eval profile
 * only, the eval override), intersected with the request's docTypes filter, ordered by doc type and capped at maxLegs. Never throws:
 * an unreadable binding registry gives no legs and one failure.
 */
export async function planBindingLegs(input: PlanBindingLegsInput, deps: BindingLegDeps = DEFAULT_DEPS): Promise<BindingLegsPlan> {
  const { profile, config, scope, filters, options } = input;
  const domain = config.v2.domainEmbeddings;
  if (!BINDING_LEG_PROFILES.includes(profile) || !domain.enabled) return EMPTY_PLAN;

  const isEval = profile === 'eval';
  const controlLeg = isEval && options?.domainControlLeg && inDocTypeFilter(filters, options.domainControlLeg) ? options.domainControlLeg : null;

  let candidates: BindingLegPlan[];
  const failures: BindingLegFailure[] = [];
  if (domain.maxLegs <= 0) {
    candidates = [];
  } else if (isEval && options?.embeddingBindings) {
    candidates = await overrideLegs(options.embeddingBindings, deps);
  } else {
    try {
      candidates = (await deps.effectiveBindings(scopeKey(scope)))
        .filter((binding) => !binding.stale)
        .map((binding) => ({ docType: binding.docType, profileId: binding.profile.id, profile: binding.profile, source: 'binding' as const }));
    } catch {
      candidates = [];
      failures.push({ docType: 'registry', reason: 'error' });
    }
  }

  const legs = candidates
    .filter((leg) => inDocTypeFilter(filters, leg.docType))
    .sort((left, right) => (left.docType < right.docType ? -1 : left.docType > right.docType ? 1 : 0))
    .slice(0, Math.max(0, domain.maxLegs));

  if (legs.length === 0 && controlLeg === null && failures.length === 0) return EMPTY_PLAN;
  return { legs, controlLeg, failures };
}

/** The first planned eval-override leg whose profile could not be resolved: the request must fail, never search the global profile. */
export function unresolvedEvalOverride(plan: BindingLegsPlan): BindingLegPlan | null {
  return plan.legs.find((leg) => leg.source === 'eval_override' && leg.resolveFailure !== undefined) ?? null;
}

export function hasBindingWork(plan: BindingLegsPlan): boolean {
  return plan.legs.length > 0 || plan.controlLeg !== null || plan.failures.length > 0;
}

/** The retrieval config hash fields of a plan: present only when a leg or the control leg is planned. */
export function bindingHashFields(plan: BindingLegsPlan): { embeddingBindings?: Record<string, string>; domainControlLeg?: string } {
  return {
    ...(plan.legs.length > 0 ? { embeddingBindings: Object.fromEntries(plan.legs.map((leg) => [leg.docType, leg.profileId])) } : {}),
    ...(plan.controlLeg !== null ? { domainControlLeg: plan.controlLeg } : {}),
  };
}

function raceWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<{ value: T } | { failure: BindingLegFailureReason }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: { value: T } | { failure: BindingLegFailureReason }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      controller.abort(parent.reason);
      finish({ failure: 'error' });
    };
    const timer = setTimeout(() => {
      controller.abort(new DOMException('binding leg timeout', 'TimeoutError'));
      finish({ failure: 'timeout' });
    }, timeoutMs);
    if (parent.aborted) {
      onAbort();
      return;
    }
    parent.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = run(AbortSignal.any([parent, controller.signal]));
    } catch (error) {
      finish({ failure: failureReason(error) });
      return;
    }
    pending.then(
      (value) => finish({ value }),
      (error) => finish({ failure: failureReason(error) }),
    );
  });
}

/**
 * Starts one query embed per planned leg with the binding profile, each under its own timeout (D-18). The returned promises never
 * reject: each resolves to the vector or to the failure reason.
 */
export function startBindingEmbeds(
  legs: readonly BindingLegPlan[],
  text: string,
  signal: AbortSignal,
  timeoutMs: number,
  embed: BindingEmbedFn = embedQueryForEvalProfile,
): Promise<BindingEmbed>[] {
  return legs.map(async (leg): Promise<BindingEmbed> => {
    const profile = leg.profile;
    if (!profile) return { failure: leg.resolveFailure ?? 'error' };
    const outcome = await raceWithTimeout((legSignal) => embed(text, legSignal, profile), signal, timeoutMs);
    return 'failure' in outcome ? outcome : { vector: outcome.value.vector };
  });
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
  /** Bounds each leg's backend call; a leg past it is dropped as a timeout. */
  timeoutMs: number;
  chunkingProfileOverride?: Record<string, string>;
}

export interface BindingLegsOutput {
  lists: RankedList[];
  failures: BindingLegFailure[];
  counts: Record<string, number>;
}

function withoutSimilarity(hits: readonly RankedHit[]): RankedHit[] {
  return hits.map((hit) => ({ ...hit, similarity: null }));
}

/**
 * Runs the planned legs against the backend in parallel (D-18..D-20). Each request carries the request's own TenantScope, the leg's
 * profile and vector, docTypes narrowed to the leg's doc type with every other filter unchanged, no lexical leg and the candidate pool
 * as the dense limit. Hits carry similarity null so the floor and refusal calibration only read the global profile. Never rejects.
 */
export async function runBindingLegs(input: RunBindingLegsInput): Promise<BindingLegsOutput> {
  const { backend, scope, filters, params, plan, embeds, globalEmbedding, signal, timeoutMs } = input;
  const weight = params.leg_weights?.domain ?? 1;

  const search = (docType: string, profileId: string, vector: number[]) =>
    raceWithTimeout(
      (legSignal) =>
        backend.search({
          scope,
          embeddingProfileId: profileId,
          denseVector: vector,
          lexicalTokens: [],
          lexicalLanguages: null,
          filters: { ...filters, docTypes: [docType] },
          denseLimit: params.candidate_pool_size,
          lexicalLimit: 0,
          signal: legSignal,
          ...(input.chunkingProfileOverride ? { chunkingProfileOverride: input.chunkingProfileOverride } : {}),
        }),
      signal,
      timeoutMs,
    );

  const legResults = await Promise.all(
    plan.legs.map(async (leg, index) => {
      const embed = (await embeds[index]) ?? { failure: 'error' as const };
      if ('failure' in embed) return { leg, failure: embed.failure };
      const outcome = await search(leg.docType, leg.profileId, embed.vector);
      if ('failure' in outcome) return { leg, failure: outcome.failure };
      return { leg, hits: withoutSimilarity(outcome.value.dense) };
    }),
  );

  let control: { hits?: RankedHit[]; failure?: BindingLegFailureReason } | null = null;
  if (plan.controlLeg !== null) {
    const outcome = await search(plan.controlLeg, globalEmbedding.profile?.id ?? LEGACY_PROFILE.id, globalEmbedding.vector);
    control = 'failure' in outcome ? { failure: outcome.failure } : { hits: withoutSimilarity(outcome.value.dense) };
  }

  const lists: RankedList[] = [];
  const failures: BindingLegFailure[] = [...plan.failures];
  let domainCount = 0;
  for (const result of legResults) {
    if ('failure' in result && result.failure) {
      failures.push({ docType: result.leg.docType, reason: result.failure });
      continue;
    }
    const hits = result.hits ?? [];
    domainCount += hits.length;
    if (hits.length > 0) lists.push({ id: `dense_domain:${result.leg.docType}`, weight, hits });
  }

  const counts: Record<string, number> = { domain: domainCount };
  if (control && plan.controlLeg !== null) {
    if (control.failure) {
      failures.push({ docType: plan.controlLeg, reason: control.failure });
    } else {
      const hits = control.hits ?? [];
      counts.domain_control = hits.length;
      if (hits.length > 0) lists.push({ id: `dense_domain_control:${plan.controlLeg}`, weight, hits });
    }
  }

  return { lists, failures, counts };
}

/** The stage detail of the first failure: binding_leg_<timeout|error|mismatch>:<doc_type> (D-19). */
export function bindingFailureDetail(failures: readonly BindingLegFailure[]): string | undefined {
  const first = failures[0];
  return first ? `binding_leg_${first.reason}:${first.docType}` : undefined;
}
