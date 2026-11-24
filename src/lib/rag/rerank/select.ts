import type { Profile, RetrievalOverrides } from '../types';
import type { RagConfig, RagEnvInput, RerankerKind, RerankTier } from '../config';
import { createCohereReranker } from './cohere';
import { createLocalBm25Reranker } from './local-bm25';
import type { Reranker } from './types';
import { createVoyageReranker } from './voyage';

export type ResolveRerankerReason = 'disabled' | 'missing_key';

export interface ResolveRerankerResult {
  reranker: Reranker | null;
  provider: RerankerKind;
  model: string | null;
  tier: RerankTier;
  reason?: ResolveRerankerReason;
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

function effectiveProvider(profile: Profile, config: RagConfig, overrides?: RetrievalOverrides): RerankerKind {
  if (profile === 'eval' && overrides?.reranker !== undefined) {
    return overrides.reranker;
  }
  return config.v2.reranker;
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

export function setRerankerFactoryForTests(factory: RerankerFactory): void {
  customFactory = factory;
}

export function resetRerankerFactoryForTests(): void {
  customFactory = null;
  warnedMissingKeys.clear();
}

export function resolveReranker(
  config: RagConfig,
  profile: Profile,
  queryLanguage: string,
  overrides: RetrievalOverrides | undefined,
  env: RagEnvInput,
  fetchImpl: FetchFn,
): ResolveRerankerResult {
  const provider = effectiveProvider(profile, config, overrides);
  const tier = resolveTier(profile, config, overrides);

  if (provider === 'none') {
    return { reranker: null, provider, model: null, tier, reason: 'disabled' };
  }

  const model = resolveModel(provider, tier, queryLanguage, config, profile, overrides);
  if (model === null) {
    return { reranker: null, provider, model: null, tier, reason: 'disabled' };
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
  return { reranker, provider, model, tier };
}