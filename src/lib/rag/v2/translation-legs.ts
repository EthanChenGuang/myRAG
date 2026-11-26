import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';
import { TranslationRowInvalidError } from '../backend/pgvector';
import type { RpcClient } from '../backend/supabase-rpc';
import type { RankedHit, RetrievalBackend, RetrievalFilters, TranslationHit } from '../backend/types';
import type { RagConfig } from '../config';
import { getRagDeps } from '../deps';
import type { QueryEmbedding } from '../embeddings/query-embedding';
import type { RankedList } from '../fusion/rrf';
import { registryOrder } from '../lang/registry';
import { queryLexicalTokens } from '../lexical/tokenize';
import { scopeKey, type TenantScope } from '../tenant/scope';
import type { Profile } from '../types';

/**
 * Chunk translations as additive retrieval legs (XLG-04, D-28, D-30). A translation hit is mapped to its source chunk before fusion,
 * so the context, citations, snapshots and source_images only ever see the original text. A failed leg is dropped and the search
 * stage is recorded degraded; the request never fails because of it. Translation-only hits carry similarity null, so the similarity
 * floor and the refusal calibration read the original legs only (Phase 3.1.1 D-20).
 */
export type TranslationLegFailureReason = 'error' | 'timeout' | 'invalid';

export interface TranslationLegFailure {
  language: string;
  reason: TranslationLegFailureReason;
}

export interface TranslationLegsPlan {
  /** Languages whose legs run, in registry order. */
  languages: string[];
  /** Languages with translations but no vector under the active profile (a profile flip before the re-embed): skipped. */
  stale: string[];
  /** The state lookup failed: no leg runs and the stage is degraded. */
  failures: TranslationLegFailure[];
}

export interface TranslationQueryState {
  language: string;
  enabled: boolean;
  targeted: boolean;
  hasTranslations: boolean;
  hasProfileVectors: boolean;
}

export type TranslationStateReader = (
  tenantKey: string,
  profileId: string,
  languages: string[],
  signal: AbortSignal,
) => Promise<TranslationQueryState[]>;

/** D-30: only these v2 profiles use translations; voice and the legacy pipeline never do. */
export const TRANSLATION_LEG_PROFILES: readonly Profile[] = ['chat', 'embed', 'eval'];

export const TRANSLATION_STALE = 'translation_stale';

const EMPTY_PLAN: TranslationLegsPlan = Object.freeze({ languages: [], stale: [], failures: [] }) as unknown as TranslationLegsPlan;

export function emptyTranslationPlan(): TranslationLegsPlan {
  return EMPTY_PLAN;
}

export function hasTranslationWork(plan: TranslationLegsPlan | null | undefined): plan is TranslationLegsPlan {
  return !!plan && (plan.languages.length > 0 || plan.stale.length > 0 || plan.failures.length > 0);
}

/** The one per-request lookup (0821): settings, rows in the language and vectors under the profile, for every candidate language. */
export async function readTranslationQueryState(
  tenantKey: string,
  profileId: string,
  languages: string[],
  signal: AbortSignal,
): Promise<TranslationQueryState[]> {
  const client = getRagDeps().adminClient() as unknown as RpcClient | null;
  if (!client) throw new Error('[RAG Translation] admin client unavailable');
  const response = await client
    .rpc('rag_translation_query_state', { p_tenant_key: tenantKey, p_profile_id: profileId, p_languages: languages })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (response.error) throw new Error(`[RAG Translation] state lookup failed (${response.error.code ?? 'unknown'})`);
  const rows = Array.isArray(response.data) ? (response.data as Record<string, unknown>[]) : [];
  return rows
    .filter((row) => typeof row.language === 'string')
    .map((row) => ({
      language: String(row.language),
      enabled: row.enabled === true,
      targeted: row.targeted === true,
      hasTranslations: row.has_translations === true,
      hasProfileVectors: row.has_profile_vectors === true,
    }));
}

export interface PlanTranslationLegsInput {
  profile: Profile;
  config: RagConfig;
  scope: TenantScope;
  queryLanguage: string | null;
  embeddingProfileId: string;
  signal: AbortSignal;
}

/**
 * Which translation legs one request runs. No lookup at all with the deployment switch off, in monolingual mode, for the voice
 * profile or without a detected query language; otherwise one lookup, and a leg only for a language the tenant's enabled setting
 * targets and has translations in. Never throws: a failed lookup gives no leg and one failure.
 */
export async function planTranslationLegs(
  input: PlanTranslationLegsInput,
  reader: TranslationStateReader = readTranslationQueryState,
): Promise<TranslationLegsPlan> {
  const { profile, config, scope, queryLanguage } = input;
  if (config.docTranslation !== 'on' || config.monolingual) return EMPTY_PLAN;
  if (!TRANSLATION_LEG_PROFILES.includes(profile) || !queryLanguage) return EMPTY_PLAN;
  const candidates = registryOrder([queryLanguage]);
  if (candidates.length === 0) return EMPTY_PLAN;

  let rows: TranslationQueryState[];
  try {
    rows = await reader(scopeKey(scope), input.embeddingProfileId, candidates, input.signal);
  } catch (error) {
    console.error('[RAG Translation] state lookup failed', { error: error instanceof Error ? error.name : 'unknown' });
    return { languages: [], stale: [], failures: candidates.map((language) => ({ language, reason: 'error' as const })) };
  }

  const byLanguage = new Map(rows.map((row) => [row.language, row]));
  const languages: string[] = [];
  const stale: string[] = [];
  for (const language of candidates) {
    const row = byLanguage.get(language);
    if (!row || !row.enabled || !row.targeted || !row.hasTranslations) continue;
    if (row.hasProfileVectors) languages.push(language);
    else stale.push(language);
  }
  if (languages.length === 0 && stale.length === 0) return EMPTY_PLAN;
  return { languages, stale, failures: [] };
}

export interface TranslationHashField {
  docTranslation?: { switch: 'on'; languages: string[]; weight: number };
}

/** The retrieval config hash part: present only when a leg runs, so every other request keeps today's hash. */
export function translationHashFields(plan: TranslationLegsPlan | null | undefined, params: RetrievalParams): TranslationHashField {
  if (!plan || plan.languages.length === 0) return {};
  return { docTranslation: { switch: 'on', languages: [...plan.languages], weight: translationWeight(params) } };
}

function translationWeight(params: RetrievalParams): number {
  return params.leg_weights?.translation ?? 1;
}

function legHits(hits: readonly TranslationHit[], leg: TranslationHit['leg']): RankedHit[] {
  return hits
    .filter((entry) => entry.leg === leg)
    .sort((a, b) => a.hit.rank - b.hit.rank || (a.hit.chunkId < b.hit.chunkId ? -1 : a.hit.chunkId > b.hit.chunkId ? 1 : 0))
    .map((entry, index) => ({ ...entry.hit, rank: index + 1, similarity: null, lexicalScore: null }));
}

/**
 * The ranked lists dense_tr:<lang> and lexical_tr:<lang> of source chunk ids. A hit on a chunk already written in the language is
 * dropped (it has no translation into its own language); scores are cleared, ranks are renumbered in their own order.
 */
export function translationLists(hits: readonly TranslationHit[], language: string, options: { weight?: number } = {}): RankedList[] {
  const usable = hits.filter((entry) => entry.translationLanguage === language && entry.hit.language !== language);
  const weight = options.weight ?? 1;
  const lists: RankedList[] = [];
  const dense = legHits(usable, 'dense');
  if (dense.length > 0) lists.push({ id: `dense_tr:${language}`, weight, hits: dense });
  const lexical = legHits(usable, 'lexical');
  if (lexical.length > 0) lists.push({ id: `lexical_tr:${language}`, weight, hits: lexical });
  return lists;
}

/** A chunk also hit by an original leg is one candidate that keeps the original's hit (and its similarity), whichever list RRF reads first. */
export function preferOriginalHits(lists: readonly RankedList[], known: ReadonlyMap<string, RankedHit>): RankedList[] {
  return lists.map((list) => ({
    ...list,
    hits: list.hits.map((hit) => {
      const original = known.get(hit.chunkId);
      return original ? { ...original, rank: hit.rank } : hit;
    }),
  }));
}

export interface RunTranslationLegsInput {
  backend: RetrievalBackend;
  scope: TenantScope;
  plan: TranslationLegsPlan;
  queryText: string;
  queryEmbedding: QueryEmbedding;
  embeddingProfileId: string;
  filters: RetrievalFilters;
  params: RetrievalParams;
  lexicalEnabled: boolean;
  signal: AbortSignal;
  /** Bounds each leg inside the search stage's own budget; a leg past it is dropped as a timeout. */
  timeoutMs: number;
  chunkingProfileOverride?: Record<string, string>;
}

export interface TranslationLegsOutput {
  lists: RankedList[];
  failures: TranslationLegFailure[];
  stale: string[];
  counts: Record<string, number>;
}

function failureReason(error: unknown): TranslationLegFailureReason {
  if (error instanceof TranslationRowInvalidError) return 'invalid';
  return 'error';
}

function raceWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  timeoutMs: number,
): Promise<{ value: T } | { failure: TranslationLegFailureReason }> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: { value: T } | { failure: TranslationLegFailureReason }) => {
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
      controller.abort(new DOMException('translation leg timeout', 'TimeoutError'));
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
 * One hybrid_search_translations call per planned language, in parallel, reusing the query embedding and the request's filters
 * unchanged. Lists follow the registry order of languages. Never rejects.
 */
export async function runTranslationLegs(input: RunTranslationLegsInput): Promise<TranslationLegsOutput> {
  const { backend, scope, plan, filters, params, signal, timeoutMs } = input;
  const failures: TranslationLegFailure[] = [...plan.failures];
  const languages = registryOrder(plan.languages);
  if (languages.length === 0 || !backend.searchTranslations) {
    return { lists: [], failures, stale: [...plan.stale], counts: { translation: 0 } };
  }
  const searchTranslations = backend.searchTranslations.bind(backend);
  const tokens = input.lexicalEnabled ? queryLexicalTokens(input.queryText) : [];
  const weight = translationWeight(params);

  const results = await Promise.all(
    languages.map(async (language) => {
      const outcome = await raceWithTimeout(
        (legSignal) =>
          searchTranslations({
            scope,
            embeddingProfileId: input.embeddingProfileId,
            language,
            denseVector: input.queryEmbedding.vector,
            lexicalTokens: tokens,
            filters,
            denseLimit: params.candidate_pool_size,
            lexicalLimit: params.candidate_pool_size,
            signal: legSignal,
            ...(input.chunkingProfileOverride ? { chunkingProfileOverride: input.chunkingProfileOverride } : {}),
          }),
        signal,
        timeoutMs,
      );
      return { language, outcome };
    }),
  );

  const lists: RankedList[] = [];
  let total = 0;
  for (const { language, outcome } of results) {
    if ('failure' in outcome) {
      failures.push({ language, reason: outcome.failure });
      continue;
    }
    const built = translationLists(outcome.value, language, { weight });
    for (const list of built) total += list.hits.length;
    lists.push(...built);
  }
  return { lists, failures, stale: [...plan.stale], counts: { translation: total } };
}

/** The stage detail: translation_leg_<error|timeout|invalid> for the first failure, else translation_stale when a leg was skipped. */
export function translationDetail(output: TranslationLegsOutput | null): string | undefined {
  if (!output) return undefined;
  const first = output.failures[0];
  if (first) return `translation_leg_${first.reason}`;
  return output.stale.length > 0 ? TRANSLATION_STALE : undefined;
}
