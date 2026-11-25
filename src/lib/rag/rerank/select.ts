import type { Profile, RetrievalOverrides } from '../types';
import type { RagConfig, RagEnvInput, RerankerKind, RerankTier } from '../config';
import { createCohereReranker } from './cohere';
import { createLocalBm25Reranker } from './local-bm25';
import type { Reranker } from './types';
import { createVoyageReranker } from './voyage';

export type ResolveRerankerReason = 'disabled' | 'missing_key' | 'auto_fallback';

/** Profiles that use Cohere under RAG_RERANKER=auto when COHERE_API_KEY is set; the rest take the no-key fallback. */
export const AUTO_HOSTED_PROFILES: readonly Profile[] = ['chat', 'embed', 'eval', 'voice'];

/** What RAG_RERANKER=auto runs without a Cohere key (or for a profile outside AUTO_HOSTED_PROFILES). */
export const AUTO_NO_KEY_FALLBACK: 'local_bm25' | 'none' = 'local_bm25';

let autoHostedProfiles: readonly Profile[] = AUTO_HOSTED_PROFILES;
let autoNoKeyFallback: 'local_bm25' | 'none' = AUTO_NO_KEY_FALLBACK;

export interface ResolveRerankerResult {
  reranker: Reranker | null;
  provider: RerankerKind;
  model: string | null;
  tier: RerankTier;
  reason?: ResolveRerankerReason;
  /** Set when RAG_RERANKER=auto chose the provider. */
  auto?: true;
}

type FetchFn = typeof globalThis.fetch;

type RerankerFactory = (provider: RerankerKind, model: string, env: RagEnvInput, fetchImpl: FetchFn) => Reranker | null;

let customFactory: RerankerFactory | null = null;
const warnedMissingKeys = new Set<string>();

function warnMissingKey(variable: 'COHERE_API_KEY' | 'VOYAGE_API_KEY'): void {
  if (warnedMissingKeys.has(variable)) return;
  warnedMissingKeys.add(variable);
  console.warn(`[RAG Config] Hosted reranker unavailable, set ${variable}`, { variable });
}

interface EffectiveProvider {
  provider: RerankerKind;
  auto: boolean;
}

/** Resolves RAG_RERANKER=auto from key presence only (config.v2.hasCohereKey); a Voyage key never selects Voyage here. */
function effectiveProvider(profile: Profile, config: RagConfig, overrides?: RetrievalOverrides): EffectiveProvider {
  if (profile === 'eval' && overrides?.reranker !== undefined) {
    return { provider: overrides.reranker, auto: false };
  }
  const configured = config.v2.reranker;
  if (configured !== 'auto') return { provider: configured, auto: false };
  if (config.v2.hasCohereKey && autoHostedProfiles.includes(profile)) return { provider: 'cohere', auto: true };
  return { provider: autoNoKeyFallback, auto: true };
}

function resolveTier(profile: Profile, config: RagConfig, overrides?: RetrievalOverrides): RerankTier {
  const tier = profile === 'voice' ? config.v2.rerankTier.voice : config.v2.rerankTier.chat;
  if (profile === 'eval' && overrides?.rerankTier !== undefined) {
    return overrides.rerankTier;
  }
  return tier;
}

function resolveModel(
  provider: RerankerKind,
  tier: RerankTier,
  queryLanguage: string,
  config: RagConfig,
  profile: Profile,
  overrides?: RetrievalOverrides,
): string | null {
  if (provider === 'none') return null;
  if (profile === 'eval' && overrides?.rerankModel !== undefined) {
    return overrides.rerankModel;
  }
  if (provider === 'cohere') {
    return tier === 'quality' ? 'rerank-v5.0-pro' : 'rerank-v5.0-fast';
  }
  if (provider === 'voyage') {
    if (tier === 'fast') return 'rerank-3-lite';
    const lang = queryLanguage.trim().toLowerCase();
    return config.v2.voyageModelByLang[lang] ?? 'rerank-3';
  }
  if (provider === 'local_bm25') return 'bm25-v2';
  return null;
}

function defaultFactory(provider: RerankerKind, model: string, env: RagEnvInput, fetchImpl: FetchFn): Reranker | null {
  if (provider === 'local_bm25') {
    return createLocalBm25Reranker();
  }
  if (provider === 'cohere') {
    const apiKey = (env.COHERE_API_KEY ?? '').trim();
    if (!apiKey) return null;
    return createCohereReranker({
      fetch: fetchImpl,
      apiKey,
      baseUrl: env.COHERE_BASE_URL ?? '',
      model,
    });
  }
  if (provider === 'voyage') {
    const apiKey = (env.VOYAGE_API_KEY ?? '').trim();
    if (!apiKey) return null;
    return createVoyageReranker({
      fetch: fetchImpl,
      apiKey,
      baseUrl: env.VOYAGE_BASE_URL ?? '',
      model,
    });
  }
  return null;
}

/** The provider and model a request resolves to, for the retrieval config hash; builds no adapter and reads no key. */
export function describeReranker(
  config: RagConfig,
  profile: Profile,
  queryLanguage: string,
  overrides?: RetrievalOverrides,
): { id: RerankerKind; model: string } {
  const { provider } = effectiveProvider(profile, config, overrides);
  const tier = resolveTier(profile, config, overrides);
  const model = resolveModel(provider, tier, queryLanguage, config, profile, overrides);
  return { id: provider, model: model ?? 'none' };
}

export function setRerankerFactoryForTests(factory: RerankerFactory): void {
  customFactory = factory;
}

export function setAutoHostedProfilesForTests(profiles: readonly Profile[]): void {
  autoHostedProfiles = profiles;
}

export function setAutoNoKeyFallbackForTests(fallback: 'local_bm25' | 'none'): void {
  autoNoKeyFallback = fallback;
}

export function resetRerankerFactoryForTests(): void {
  customFactory = null;
  warnedMissingKeys.clear();
  autoHostedProfiles = AUTO_HOSTED_PROFILES;
  autoNoKeyFallback = AUTO_NO_KEY_FALLBACK;
}

export function resolveReranker(
  config: RagConfig,
  profile: Profile,
  queryLanguage: string,
  overrides: RetrievalOverrides | undefined,
  env: RagEnvInput,
  fetchImpl: FetchFn,
): ResolveRerankerResult {
  const { provider, auto } = effectiveProvider(profile, config, overrides);
  const tier = resolveTier(profile, config, overrides);
  const autoFields = auto ? { auto: true as const } : {};
  const fallback = auto && provider !== 'cohere';

  if (provider === 'none') {
    return { reranker: null, provider, model: null, tier, reason: fallback ? 'auto_fallback' : 'disabled', ...autoFields };
  }

  const model = resolveModel(provider, tier, queryLanguage, config, profile, overrides);
  if (model === null) {
    return { reranker: null, provider, model: null, tier, reason: 'disabled', ...autoFields };
  }

  if (provider === 'cohere' && (env.COHERE_API_KEY ?? '').trim() === '') {
    warnMissingKey('COHERE_API_KEY');
    return { reranker: null, provider, model, tier, reason: 'missing_key' };
  }
  if (provider === 'voyage' && (env.VOYAGE_API_KEY ?? '').trim() === '') {
    warnMissingKey('VOYAGE_API_KEY');
    return { reranker: null, provider, model, tier, reason: 'missing_key' };
  }

  const factory = customFactory ?? defaultFactory;
  const reranker = factory(provider, model, env, fetchImpl);
  return { reranker, provider, model, tier, ...(fallback ? { reason: 'auto_fallback' as const } : {}), ...autoFields };
}