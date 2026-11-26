import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase';
import { loadRagConfig, pipelineSourceOf, type RagEnvInput } from './config';
import type { RawPipelineEnv } from './lang/resolve';
import { getLanguageSettings } from './lang/settings';
import type { EmbeddingProfile } from './embeddings/active-profile';
import { EmbeddingProfileMismatch } from './embeddings/mrl';
import { embedText } from './embeddings/openai';
import { getEmbeddingProviderFor } from './embeddings/registry';
import { isMultiTenant } from '@/lib/deployment-mode';
import { readSecurityConfig, type SecurityConfig } from './security/config';
import { loadInjectionDetectorConfig, type Detector } from './security/detectors';
import type { PromptGuardClassifier } from './security/injection-check';
import { createLakeraDetector, lakeraSettingsFrom } from './security/lakera';
import { classifyWithPromptGuard } from './security/prompt-guard-client';
import { createQueryLlm, type QueryLlm } from './query/llm';
import type { RpcClient } from './backend/supabase-rpc';
import { createSemanticCacheBackend, getSemanticCache, type SemanticCacheIo } from './cache/index';
import type { SemanticCache } from './cache/types';

export interface ProfileQueryEmbedding {
  vector: number[];
  /** The model the provider reports having used, compared with the profile's model on every request. */
  model: string;
}

export interface RagDeps {
  adminClient: () => SupabaseClient | null;
  embedder: (text: string, opts: { signal: AbortSignal }) => Promise<number[]>;
  /** Used for a non-legacy active profile only: the profile's provider embeds the query at the profile's dims. */
  profileEmbedder: (text: string, opts: { signal: AbortSignal; profile: EmbeddingProfile }) => Promise<ProfileQueryEmbedding>;
  /** Optional: embeds several queries in one provider call. Null means the provider offers none and the caller embeds them in parallel. */
  profileBatchEmbedder?: (
    texts: string[],
    opts: { signal: AbortSignal; profile: EmbeddingProfile },
  ) => Promise<ProfileQueryEmbedding[] | null>;
  now: () => number;
  randomId: () => string;
  ragEnv: () => RagEnvInput;
  /** Phase 5.1 switches, read at call time. */
  securityConfig: () => SecurityConfig;
  /** The Lakera adapter; its own gate re-checks lakeraAllowed with the real deployment mode before every request. */
  lakeraDetector: () => Detector;
  /** The sidecar Prompt Guard client; answers not_configured without RAG_SIDECAR_URL and RAG_SIDECAR_SECRET. */
  promptGuardClassifier: PromptGuardClassifier;
  /** The only way pipeline code reaches the query LLM (D-13); tests and eval inject the deterministic fake. */
  queryLlm: () => QueryLlm;
  fetch: typeof fetch;
  /** The two pipeline variables exactly as the process has them (undefined when unset), for the D-02 startup check. */
  rawPipelineEnv: () => RawPipelineEnv;
  /**
   * D-24: whether the deployment has chosen its supported languages, from the Phase 3.2 reader at call time. A test override of null
   * means no reader, and the resolver then applies no language fallback of its own.
   */
  languagesConfigured: () => boolean | null;
  /** The semantic answer cache for RAG_SEMANTIC_CACHE, wrapped fail-open; null when the cache is off (D-34, D-35). */
  semanticCache: () => SemanticCache | null;
  /** The same backend without the fail-open wrapper, for the admin clear action that must report failures (D-44). */
  semanticCacheAdmin: () => SemanticCache | null;
}

function semanticCacheIo(deps: RagDeps): SemanticCacheIo {
  return {
    adminClient: () => deps.adminClient() as unknown as RpcClient | null,
    fetch: (input, init) => deps.fetch(input, init),
    sidecarUrl: process.env.RAG_SIDECAR_URL ?? env.RAG_SIDECAR_URL ?? '',
    sidecarSecret: process.env.RAG_SIDECAR_SECRET ?? env.RAG_SIDECAR_SECRET ?? '',
  };
}

/** LangSmith/LangChain tracing switches as LangChain itself reads them (process.env); names only matter to the config check. */
export function langchainTracingEnv(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(source).filter(([name]) => /^(?:LANGSMITH_|LANGCHAIN_TRACING)/u.test(name)));
}

function readRagEnvInput(): RagEnvInput {
  return {
    ...langchainTracingEnv(),
    RAG_PIPELINE: process.env.RAG_PIPELINE ?? env.RAG_PIPELINE,
    pipelineSourceHint: pipelineSourceOf(getRagDeps().rawPipelineEnv().RAG_PIPELINE),
    RAG_DISABLED_STAGES: process.env.RAG_DISABLED_STAGES ?? env.RAG_DISABLED_STAGES,
    RAG_STAGE_TIMEOUTS: process.env.RAG_STAGE_TIMEOUTS ?? env.RAG_STAGE_TIMEOUTS,
    RAG_EXACT_ID_LOOKUP: process.env.RAG_EXACT_ID_LOOKUP ?? env.RAG_EXACT_ID_LOOKUP,
    RAG_LEXICAL_SEARCH: process.env.RAG_LEXICAL_SEARCH ?? env.RAG_LEXICAL_SEARCH,
    RAG_RERANKER: process.env.RAG_RERANKER ?? env.RAG_RERANKER,
    RAG_RERANK_TIER_CHAT: process.env.RAG_RERANK_TIER_CHAT ?? env.RAG_RERANK_TIER_CHAT,
    RAG_RERANK_TIER_VOICE: process.env.RAG_RERANK_TIER_VOICE ?? env.RAG_RERANK_TIER_VOICE,
    RAG_RERANK_VOYAGE_MODEL_BY_LANG: process.env.RAG_RERANK_VOYAGE_MODEL_BY_LANG ?? env.RAG_RERANK_VOYAGE_MODEL_BY_LANG,
    COHERE_API_KEY: process.env.COHERE_API_KEY ?? env.COHERE_API_KEY,
    COHERE_BASE_URL: process.env.COHERE_BASE_URL ?? env.COHERE_BASE_URL,
    RAG_REFUSAL_THRESHOLD: process.env.RAG_REFUSAL_THRESHOLD ?? env.RAG_REFUSAL_THRESHOLD,
    RAG_REFUSAL_FLOOR: process.env.RAG_REFUSAL_FLOOR,
    RAG_CONTEXT_EDGE_ORDER: process.env.RAG_CONTEXT_EDGE_ORDER ?? env.RAG_CONTEXT_EDGE_ORDER,
    RAG_CONTEXT_COMPRESSION: process.env.RAG_CONTEXT_COMPRESSION ?? env.RAG_CONTEXT_COMPRESSION,
    RAG_CONTEXT_TOKEN_BUDGET: process.env.RAG_CONTEXT_TOKEN_BUDGET ?? env.RAG_CONTEXT_TOKEN_BUDGET,
    RAG_PARENT_CHILD: process.env.RAG_PARENT_CHILD ?? env.RAG_PARENT_CHILD,
    RAG_HNSW_ITERATIVE_SCAN: process.env.RAG_HNSW_ITERATIVE_SCAN ?? env.RAG_HNSW_ITERATIVE_SCAN,
    RAG_EXACT_SCAN_CUTOFF: process.env.RAG_EXACT_SCAN_CUTOFF ?? env.RAG_EXACT_SCAN_CUTOFF,
    RAG_LEXICAL_TRANSLATION: process.env.RAG_LEXICAL_TRANSLATION ?? env.RAG_LEXICAL_TRANSLATION,
    RAG_LEXICAL_DICTIONARY: process.env.RAG_LEXICAL_DICTIONARY ?? env.RAG_LEXICAL_DICTIONARY,
    RAG_LEXICAL_STEM_IT: process.env.RAG_LEXICAL_STEM_IT ?? env.RAG_LEXICAL_STEM_IT,
    RAG_VERSION_SCOPE: process.env.RAG_VERSION_SCOPE ?? env.RAG_VERSION_SCOPE,
    RAG_TABLE_LOOKUP: process.env.RAG_TABLE_LOOKUP ?? env.RAG_TABLE_LOOKUP,
    RAG_DUP_CLUSTERS: process.env.RAG_DUP_CLUSTERS ?? env.RAG_DUP_CLUSTERS,
    RAG_RESULT_DIVERSITY: process.env.RAG_RESULT_DIVERSITY ?? env.RAG_RESULT_DIVERSITY,
    RAG_IDENTIFIER_INDEX: process.env.RAG_IDENTIFIER_INDEX ?? env.RAG_IDENTIFIER_INDEX,
    RAG_IDENTIFIER_FILTER: process.env.RAG_IDENTIFIER_FILTER ?? env.RAG_IDENTIFIER_FILTER,
    RAG_RETRIEVAL_PARAMS_OVERRIDE: process.env.RAG_RETRIEVAL_PARAMS_OVERRIDE ?? env.RAG_RETRIEVAL_PARAMS_OVERRIDE,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY ?? env.VOYAGE_API_KEY,
    VOYAGE_BASE_URL: process.env.VOYAGE_BASE_URL ?? env.VOYAGE_BASE_URL,
    RAG_EFFECTIVE_DATES: process.env.RAG_EFFECTIVE_DATES ?? env.RAG_EFFECTIVE_DATES,
    RAG_SCOPE_TAGS: process.env.RAG_SCOPE_TAGS ?? env.RAG_SCOPE_TAGS,
    RAG_DOC_TRANSLATION: process.env.RAG_DOC_TRANSLATION ?? env.RAG_DOC_TRANSLATION,
    RAG_BGE_M3_SERVING: process.env.RAG_BGE_M3_SERVING ?? env.RAG_BGE_M3_SERVING,
    RAG_OUTPUT_LINK_ALLOWLIST: process.env.RAG_OUTPUT_LINK_ALLOWLIST ?? env.RAG_OUTPUT_LINK_ALLOWLIST,
    RAG_EMBEDDING_PROFILES: process.env.RAG_EMBEDDING_PROFILES ?? env.RAG_EMBEDDING_PROFILES,
    RAG_DOMAIN_EMBEDDINGS: process.env.RAG_DOMAIN_EMBEDDINGS ?? env.RAG_DOMAIN_EMBEDDINGS,
    RAG_DOMAIN_EMBEDDING_MAX_LEGS: process.env.RAG_DOMAIN_EMBEDDING_MAX_LEGS ?? env.RAG_DOMAIN_EMBEDDING_MAX_LEGS,
    RAG_DOMAIN_EMBEDDING_TIMEOUT_MS: process.env.RAG_DOMAIN_EMBEDDING_TIMEOUT_MS ?? env.RAG_DOMAIN_EMBEDDING_TIMEOUT_MS,
    RAG_QUERY_LAYER: process.env.RAG_QUERY_LAYER ?? env.RAG_QUERY_LAYER,
    RAG_QUERY_FRAMEWORK: process.env.RAG_QUERY_FRAMEWORK ?? env.RAG_QUERY_FRAMEWORK,
    RAG_QUERY_LLM_MODEL: process.env.RAG_QUERY_LLM_MODEL ?? env.RAG_QUERY_LLM_MODEL,
    RAG_QUERY_CONDENSE: process.env.RAG_QUERY_CONDENSE ?? env.RAG_QUERY_CONDENSE,
    RAG_QUERY_EXPAND: process.env.RAG_QUERY_EXPAND ?? env.RAG_QUERY_EXPAND,
    RAG_QUERY_DECOMPOSE: process.env.RAG_QUERY_DECOMPOSE ?? env.RAG_QUERY_DECOMPOSE,
    RAG_QUERY_TRANSLATE: process.env.RAG_QUERY_TRANSLATE ?? env.RAG_QUERY_TRANSLATE,
    RAG_QUERY_DATE_NORMALIZE: process.env.RAG_QUERY_DATE_NORMALIZE ?? env.RAG_QUERY_DATE_NORMALIZE,
    RAG_QUERY_HYDE: process.env.RAG_QUERY_HYDE ?? env.RAG_QUERY_HYDE,
    RAG_QUERY_TRANSLATE_DISABLED_PROFILES: process.env.RAG_QUERY_TRANSLATE_DISABLED_PROFILES ?? env.RAG_QUERY_TRANSLATE_DISABLED_PROFILES,
    RAG_QUERY_VOICE_TRANSFORMS: process.env.RAG_QUERY_VOICE_TRANSFORMS ?? env.RAG_QUERY_VOICE_TRANSFORMS,
    RAG_SEMANTIC_CACHE: process.env.RAG_SEMANTIC_CACHE ?? env.RAG_SEMANTIC_CACHE,
    RAG_SEMANTIC_CACHE_TTL: process.env.RAG_SEMANTIC_CACHE_TTL ?? env.RAG_SEMANTIC_CACHE_TTL,
    RAG_SEMANTIC_CACHE_REFUSAL_TTL: process.env.RAG_SEMANTIC_CACHE_REFUSAL_TTL ?? env.RAG_SEMANTIC_CACHE_REFUSAL_TTL,
    RAG_SEMANTIC_CACHE_MAX_DISTANCE: process.env.RAG_SEMANTIC_CACHE_MAX_DISTANCE ?? env.RAG_SEMANTIC_CACHE_MAX_DISTANCE,
    RAG_SEMANTIC_CACHE_EMBED_STORE: process.env.RAG_SEMANTIC_CACHE_EMBED_STORE ?? env.RAG_SEMANTIC_CACHE_EMBED_STORE,
    RAG_RETRIEVAL_BACKEND: process.env.RAG_RETRIEVAL_BACKEND ?? env.RAG_RETRIEVAL_BACKEND,
    RAG_RETRIEVAL_BACKEND_VOICE: process.env.RAG_RETRIEVAL_BACKEND_VOICE ?? env.RAG_RETRIEVAL_BACKEND_VOICE,
    RAG_VECTOR_SYNC_MAX_LAG_SECONDS: process.env.RAG_VECTOR_SYNC_MAX_LAG_SECONDS ?? env.RAG_VECTOR_SYNC_MAX_LAG_SECONDS,
  };
}

let defaultQueryLlm: QueryLlm | null = null;

/** Built on first use for the configured RAG_QUERY_LLM_MODEL; the provider module itself loads on the first call. */
function defaultQueryLlmClient(): QueryLlm {
  const model = loadRagConfig(getRagDeps().ragEnv()).queryLayer.model;
  if (!defaultQueryLlm || defaultQueryLlm.model !== model) defaultQueryLlm = createQueryLlm({ model });
  return defaultQueryLlm;
}

const defaults: RagDeps = {
  adminClient: () => getSupabaseAdmin() as SupabaseClient | null,
  embedder: embedText,
  profileEmbedder: async (text, { signal, profile }) => {
    const output = await getEmbeddingProviderFor(profile.provider, profile.model).embedQuery(text, { dims: profile.dims, signal });
    const vector = output.vectors[0];
    if (!vector) throw new EmbeddingProfileMismatch('dims', 0, profile.dims);
    return { vector, model: output.model };
  },
  profileBatchEmbedder: async (texts, { signal, profile }) => {
    const provider = getEmbeddingProviderFor(profile.provider, profile.model);
    if (!provider.embedQueries) return null;
    const output = await provider.embedQueries(texts, { dims: profile.dims, signal });
    return output.vectors.map((vector) => ({ vector, model: output.model }));
  },
  now: () => Date.now(),
  randomId: () => randomUUID(),
  ragEnv: () => readRagEnvInput(),
  securityConfig: () => readSecurityConfig(),
  lakeraDetector: () =>
    createLakeraDetector({
      config: loadInjectionDetectorConfig().lakera,
      fetch: (input, init) => getRagDeps().fetch(input, init),
      gate: () => lakeraSettingsFrom(getRagDeps().securityConfig(), isMultiTenant()),
    }),
  promptGuardClassifier: (items, opts) => classifyWithPromptGuard(items, { ...opts, fetch: getRagDeps().fetch }),
  queryLlm: defaultQueryLlmClient,
  fetch: globalThis.fetch.bind(globalThis),
  rawPipelineEnv: () => ({ RAG_PIPELINE: process.env.RAG_PIPELINE, RAG_INGEST_PIPELINE: process.env.RAG_INGEST_PIPELINE }),
  languagesConfigured: () => getLanguageSettings().configured,
  semanticCache: () => {
    const deps = getRagDeps();
    return getSemanticCache(loadRagConfig(deps.ragEnv()).semanticCache, semanticCacheIo(deps));
  },
  semanticCacheAdmin: () => {
    const deps = getRagDeps();
    return createSemanticCacheBackend(loadRagConfig(deps.ragEnv()).semanticCache, semanticCacheIo(deps))?.backend ?? null;
  },
};

let overrides: Partial<RagDeps> = {};

export function getRagDeps(): RagDeps {
  return { ...defaults, ...overrides };
}

export function setRagDepsForTests(partial: Partial<RagDeps>): void {
  overrides = { ...overrides, ...partial };
}

export function resetRagDepsForTests(): void {
  overrides = {};
  defaultQueryLlm = null;
}