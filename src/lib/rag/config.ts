import type { Profile } from './types';
import { RETRIEVAL_BACKEND_IDS, type BackendId } from './backend/types';
import { getLanguageSettings } from './lang/settings';
import { LEXICAL_VERSION } from './lexical/tokenize';
import { LANGUAGES_NOT_CONFIGURED, pipelineSourceOf, resolvePipelines, type LanguagesNotConfigured, type PipelineSource } from './lang/resolve';

export const CORE_STAGES = ['embed', 'search', 'fuse'] as const;
export const OPTIONAL_STAGES = [
  'refs',
  'analyze',
  'legacy_rank',
  'post_filter',
  'assemble',
  'voice_keyword_fallback',
  'local_rerank',
  'exact_id_lookup',
  'translate',
  'dedupe',
  'rerank',
  'refusal',
  'expand_parents',
  'compress',
  'injection_check',
  'query_gate',
  'condense',
  'normalize_dates',
  'expand',
  'hyde',
  'decompose',
  'semantic_cache',
  'table_lookup',
  'diversify',
  'identifier_resolve',
  'identifier_guard',
  'terminology',
  'attribute_resolve',
] as const;

/** Phase 6 query-layer stages (D-05); translate is the shared Phase 4 slot and is not listed here. */
export const QUERY_LAYER_STAGES = [
  'query_gate',
  'condense',
  'normalize_dates',
  'expand',
  'hyde',
  'decompose',
  'semantic_cache',
] as const satisfies readonly OptionalStageName[];

export type QueryLayerStageName = (typeof QUERY_LAYER_STAGES)[number];

export type CoreStageName = (typeof CORE_STAGES)[number];
export type OptionalStageName = (typeof OPTIONAL_STAGES)[number];
export type StageName = CoreStageName | OptionalStageName;

export type StageTimeouts = Partial<Record<StageName, number>>;

const LEGACY_STANDARD: StageTimeouts = {
  refs: 5000,
  analyze: 1000,
  embed: 15000,
  search: 15000,
  legacy_rank: 2000,
  post_filter: 10000,
  assemble: 10000,
  exact_id_lookup: 1000,
};

const V2_STANDARD: StageTimeouts = {
  translate: 1000,
  terminology: 50,
  fuse: 1000,
  dedupe: 1000,
  rerank: 600,
  refusal: 1000,
  expand_parents: 3000,
  compress: 1000,
  table_lookup: 1000,
  diversify: 1000,
  identifier_resolve: 1000,
  identifier_guard: 1000,
  attribute_resolve: 1000,
};

const V2_VOICE: StageTimeouts = {
  translate: 300,
  terminology: 30,
  fuse: 300,
  dedupe: 300,
  rerank: 250,
  refusal: 300,
  expand_parents: 1000,
  compress: 1000,
  table_lookup: 500,
  diversify: 300,
  identifier_resolve: 500,
  identifier_guard: 300,
  attribute_resolve: 500,
};

const V2_EVAL: StageTimeouts = {
  rerank: 60000,
  expand_parents: 10000,
};

/** The injection_check stage budget per profile; eval uses the registry maximum as a safety ceiling (Phase 4 F-16). */
const INJECTION_CHECK_TIMEOUTS: Record<Profile, number> = {
  chat: 400,
  embed: 400,
  media: 400,
  voice: 1000,
  eval: 60000,
};

/** D-27 query-layer budgets; query_gate and normalize_dates are pure. Eval has no effective timeout (Phase 4 precedent). */
const QUERY_STANDARD: StageTimeouts = {
  query_gate: 50,
  condense: 600,
  normalize_dates: 50,
  expand: 700,
  hyde: 900,
  decompose: 800,
  semantic_cache: 150,
};

const QUERY_VOICE: StageTimeouts = {
  query_gate: 50,
  condense: 300,
  normalize_dates: 50,
};

const QUERY_EVAL: StageTimeouts = {
  query_gate: 60000,
  condense: 60000,
  normalize_dates: 60000,
  expand: 60000,
  hyde: 60000,
  decompose: 60000,
  semantic_cache: 60000,
};

/** The translate budget while the query layer serves the slot (D-27); with the layer off the Phase 4 value stays. */
const QUERY_LAYER_TRANSLATE: Partial<Record<Profile, number>> = {
  chat: 600,
  embed: 600,
  media: 600,
  eval: 60000,
};

function mergeProfileDefaults(legacy: StageTimeouts, v2: StageTimeouts, extra?: StageTimeouts): StageTimeouts {
  return { ...legacy, ...v2, ...extra };
}

export const PROFILE_STAGE_DEFAULTS: Record<Profile, StageTimeouts> = {
  chat: mergeProfileDefaults(LEGACY_STANDARD, V2_STANDARD, { injection_check: INJECTION_CHECK_TIMEOUTS.chat, ...QUERY_STANDARD }),
  embed: mergeProfileDefaults(LEGACY_STANDARD, V2_STANDARD, { injection_check: INJECTION_CHECK_TIMEOUTS.embed, ...QUERY_STANDARD }),
  eval: mergeProfileDefaults(LEGACY_STANDARD, V2_STANDARD, {
    ...V2_EVAL,
    translate: 1000,
    terminology: 1000,
    fuse: 1000,
    dedupe: 1000,
    refusal: 1000,
    compress: 1000,
    injection_check: INJECTION_CHECK_TIMEOUTS.eval,
    ...QUERY_EVAL,
  }),
  media: mergeProfileDefaults(LEGACY_STANDARD, V2_STANDARD, { injection_check: INJECTION_CHECK_TIMEOUTS.media, ...QUERY_STANDARD }),
  voice: {
    ...mergeProfileDefaults(
      {
        refs: 5000,
        analyze: 500,
        embed: 5000,
        search: 5000,
        voice_keyword_fallback: 3000,
        local_rerank: 1000,
        post_filter: 3000,
        assemble: 3000,
        exact_id_lookup: 500,
      },
      V2_VOICE,
      { injection_check: INJECTION_CHECK_TIMEOUTS.voice, ...QUERY_VOICE },
    ),
  },
};

export const FALLBACK_STAGE_TIMEOUT_MS = 10000;

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60000;
const PROFILES = Object.keys(PROFILE_STAGE_DEFAULTS) as Profile[];

export type RerankerKind = 'none' | 'cohere' | 'voyage' | 'local_bm25';
/** RAG_RERANKER as configured; `auto` resolves per request to a RerankerKind (src/lib/rag/rerank/select.ts). */
export type RerankerSetting = RerankerKind | 'auto';
export type RerankTier = 'quality' | 'fast';
export type IterativeScanMode = 'off' | 'relaxed_order' | 'strict_order';
export type BgeM3Serving = 'hosted' | 'sidecar';

export interface RetrievalParamsOverride {
  candidate_pool_size?: number;
  rerank_input_cap?: number;
  final_top_k?: number;
  rrf_k?: number;
}

export interface DomainEmbeddingsConfig {
  enabled: boolean;
  maxLegs: number;
  timeoutMs: number;
}

export const REFUSAL_FLOOR_POLICIES = ['similarity', 'legacy_rule'] as const;

export type RefusalFloorPolicy = (typeof REFUSAL_FLOOR_POLICIES)[number];

export const RESULT_DIVERSITY_MODES = ['off', 'collapse', 'mmr'] as const;

export type ResultDiversityMode = (typeof RESULT_DIVERSITY_MODES)[number];

export const ATTRIBUTE_FILTER_MODES = ['off', 'hard', 'soft'] as const;

export type AttributeFilterMode = (typeof ATTRIBUTE_FILTER_MODES)[number];

export interface V2Config {
  lexicalSearch: boolean;
  reranker: RerankerSetting;
  rerankTier: { chat: RerankTier; voice: RerankTier };
  voyageModelByLang: Record<string, string>;
  refusalThreshold: boolean;
  refusalFloor: RefusalFloorPolicy;
  edgeOrder: boolean;
  compression: boolean;
  tokenBudget: number;
  parentChild: boolean;
  iterativeScan: IterativeScanMode;
  exactScanCutoff: number;
  lexicalTranslation: boolean;
  /** D-15: the terminology stage; acts only inside the v2 graph. */
  terminology: boolean;
  /** D-18: the dense terminology variant; requires terminology, never in voice (see terminologyDenseFor). */
  terminologyDense: boolean;
  terminologyMining: boolean;
  paramsOverride: RetrievalParamsOverride;
  hasCohereKey: boolean;
  hasVoyageKey: boolean;
  domainEmbeddings: DomainEmbeddingsConfig;
  lexicalDictionary: boolean;
  lexicalStemIt: boolean;
  /** Effective: false while RAG_LEXICAL_SEARCH is off (D-40). */
  versionScope: boolean;
  tableLookup: boolean;
  dupClusters: boolean;
  resultDiversity: ResultDiversityMode;
  identifierIndex: boolean;
  /** Effective: false while RAG_IDENTIFIER_INDEX is off (D-04). */
  identifierFilter: boolean;
  /** Effective: 'off' unless RAG_DOC_ATTRIBUTES=true and the effective pipeline is v2. */
  attributeFilter: AttributeFilterMode;
  lexicalQuantity: boolean;
  /** D-42: LEXICAL_VERSION plus 1 for the dictionary, 2 for Italian stemming and 4 for quantity tokens. */
  lexicalVersion: number;
}

export type QueryFramework = 'llamaindex' | 'langchain';
export type VoiceTransform = 'condense_history' | 'normalize_dates' | 'translate';
export type SemanticCacheBackend = 'off' | 'pgvector' | 'redisvl';

export interface QueryTransformSwitches {
  condense: boolean;
  expand: boolean;
  decompose: boolean;
  translate: boolean;
  normalizeDates: boolean;
  hyde: boolean;
}

/** Sub-switches keep their parsed values while the layer is off; only `enabled` and disabledStages gate them. */
export interface QueryLayerConfig {
  enabled: boolean;
  framework: QueryFramework;
  model: string;
  transforms: QueryTransformSwitches;
  /** Embedding-profile ids (D-24), not pipeline profiles. */
  translateDisabledProfiles: string[];
  voiceTransforms: VoiceTransform[];
}

export interface SemanticCacheConfig {
  backend: SemanticCacheBackend;
  ttl: number;
  refusalTtl: number;
  maxDistance: number;
  embedStore: boolean;
}

export const DEFAULT_QUERY_LLM_MODEL = 'openai/gpt-4.1-nano';
export const DEFAULT_SEMANTIC_CACHE_MAX_DISTANCE = 0.05;
export const MAX_SEMANTIC_CACHE_DISTANCE = 0.2;

export interface RagEnvInput {
  RAG_PIPELINE?: string;
  /**
   * D-07: whether RAG_PIPELINE is set and non-empty in the process environment. The deps reader fills it from the raw process value,
   * because RAG_PIPELINE above may carry the env.ts fallback; absent, the source follows RAG_PIPELINE itself.
   */
  pipelineSourceHint?: PipelineSource;
  RAG_DISABLED_STAGES?: string;
  RAG_STAGE_TIMEOUTS?: string;
  RAG_EXACT_ID_LOOKUP?: string;
  RAG_LEXICAL_SEARCH?: string;
  RAG_RERANKER?: string;
  RAG_RERANK_TIER_CHAT?: string;
  RAG_RERANK_TIER_VOICE?: string;
  RAG_RERANK_VOYAGE_MODEL_BY_LANG?: string;
  COHERE_API_KEY?: string;
  COHERE_BASE_URL?: string;
  RAG_REFUSAL_THRESHOLD?: string;
  RAG_REFUSAL_FLOOR?: string;
  RAG_CONTEXT_EDGE_ORDER?: string;
  RAG_CONTEXT_COMPRESSION?: string;
  RAG_CONTEXT_TOKEN_BUDGET?: string;
  RAG_PARENT_CHILD?: string;
  RAG_HNSW_ITERATIVE_SCAN?: string;
  RAG_EXACT_SCAN_CUTOFF?: string;
  RAG_LEXICAL_TRANSLATION?: string;
  RAG_LEXICAL_DICTIONARY?: string;
  RAG_LEXICAL_STEM_IT?: string;
  RAG_VERSION_SCOPE?: string;
  RAG_TABLE_LOOKUP?: string;
  RAG_DUP_CLUSTERS?: string;
  RAG_RESULT_DIVERSITY?: string;
  RAG_IDENTIFIER_INDEX?: string;
  RAG_IDENTIFIER_FILTER?: string;
  RAG_ATTRIBUTE_FILTER?: string;
  RAG_LEXICAL_QUANTITY?: string;
  RAG_DOC_ATTRIBUTES?: string;
  RAG_TERMINOLOGY?: string;
  RAG_TERMINOLOGY_DENSE?: string;
  RAG_TERMINOLOGY_MINING?: string;
  RAG_RETRIEVAL_PARAMS_OVERRIDE?: string;
  VOYAGE_API_KEY?: string;
  VOYAGE_BASE_URL?: string;
  RAG_EFFECTIVE_DATES?: string;
  RAG_SCOPE_TAGS?: string;
  RAG_DOC_TRANSLATION?: string;
  RAG_BGE_M3_SERVING?: string;
  RAG_OUTPUT_LINK_ALLOWLIST?: string;
  RAG_EMBEDDING_PROFILES?: string;
  RAG_DOMAIN_EMBEDDINGS?: string;
  RAG_DOMAIN_EMBEDDING_MAX_LEGS?: string;
  RAG_DOMAIN_EMBEDDING_TIMEOUT_MS?: string;
  RAG_QUERY_LAYER?: string;
  RAG_QUERY_FRAMEWORK?: string;
  RAG_QUERY_LLM_MODEL?: string;
  RAG_QUERY_CONDENSE?: string;
  RAG_QUERY_EXPAND?: string;
  RAG_QUERY_DECOMPOSE?: string;
  RAG_QUERY_TRANSLATE?: string;
  RAG_QUERY_DATE_NORMALIZE?: string;
  RAG_QUERY_HYDE?: string;
  RAG_QUERY_TRANSLATE_DISABLED_PROFILES?: string;
  RAG_QUERY_VOICE_TRANSFORMS?: string;
  RAG_SEMANTIC_CACHE?: string;
  RAG_SEMANTIC_CACHE_TTL?: string;
  RAG_SEMANTIC_CACHE_REFUSAL_TTL?: string;
  RAG_SEMANTIC_CACHE_MAX_DISTANCE?: string;
  RAG_SEMANTIC_CACHE_EMBED_STORE?: string;
  RAG_RETRIEVAL_BACKEND?: string;
  RAG_RETRIEVAL_BACKEND_VOICE?: string;
  RAG_VECTOR_SYNC_MAX_LAG_SECONDS?: string;
}

/** D-11, D-24: where retrieval runs per profile, and the sync lag bound for index readiness. Keys never live here. */
export interface BackendConfig {
  default: BackendId;
  voice: BackendId;
  maxLagSeconds: number;
}

export const DEFAULT_MAX_LAG_SECONDS = 300;

export interface RagConfig {
  pipeline: 'legacy' | 'v2';
  /** D-07: 'explicit' when RAG_PIPELINE is set and non-empty, 'default' when the shipped default applies. */
  pipelineSource: PipelineSource;
  /** D-02/D-24: a defaulted v2 that the language gate turned into legacy (the languages are not chosen). */
  pipelineServedLegacy: boolean;
  /** D-02: an explicit RAG_PIPELINE=v2 without chosen languages; retrieval answers status error with this reason. */
  pipelineBlocked: LanguagesNotConfigured | null;
  /** D-03: exactly one supported language; the translate stage and lexical translation are then no-ops. */
  monolingual: boolean;
  disabledStages: ReadonlySet<StageName>;
  /** Only the stages RAG_DISABLED_STAGES lists (disabledStages also holds stages turned off by their own switches). */
  operatorDisabledStages?: ReadonlySet<StageName>;
  timeouts: Record<Profile, StageTimeouts>;
  exactIdLookup: boolean;
  v2: V2Config;
  effectiveDates: boolean;
  scopeTags: boolean;
  /** The raw RAG_DOC_ATTRIBUTES flag; v2.attributeFilter carries the effective filter. */
  docAttributes: boolean;
  docTranslation: 'off' | 'on';
  bgeM3Serving: BgeM3Serving;
  /** Raw comma-separated domains; the output link filter parses it. */
  outputLinkAllowlist: string;
  queryLayer: QueryLayerConfig;
  semanticCache: SemanticCacheConfig;
  backend: BackendConfig;
  warnings: string[];
}

const loggedProblems = new Set<string>();
const memo = new Map<string, RagConfig>();

type LogPrefix = '[RAG Config]' | '[Query Layer]' | '[Semantic Cache]';

function problem(warnings: string[], key: string, message: string, data: Record<string, unknown>, prefix: LogPrefix = '[RAG Config]'): void {
  warnings.push(`${message} (${Object.values(data).join(', ')})`);
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`${prefix} ${message}`, data);
}

function isStageName(value: string): value is StageName {
  return (CORE_STAGES as readonly string[]).includes(value) || (OPTIONAL_STAGES as readonly string[]).includes(value);
}

function isProfile(value: string): value is Profile {
  return (PROFILES as readonly string[]).includes(value);
}

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** The pipeline an unset RAG_PIPELINE runs (the shipped default). */
export const DEFAULT_PIPELINE: 'legacy' | 'v2' = 'legacy';

let defaultPipelineOverride: 'legacy' | 'v2' | null = null;

/** The shipped default in force: DEFAULT_PIPELINE, or the test setter's value. */
export function shippedDefaultPipeline(): 'legacy' | 'v2' {
  return defaultPipelineOverride ?? DEFAULT_PIPELINE;
}

/** Test-only: change the shipped default; null restores DEFAULT_PIPELINE. */
export function setDefaultPipelineForTests(next: 'legacy' | 'v2' | null): void {
  defaultPipelineOverride = next;
  memo.clear();
}

export { pipelineSourceOf };

function pipelineSource(env: RagEnvInput): PipelineSource {
  return env.pipelineSourceHint ?? pipelineSourceOf(env.RAG_PIPELINE);
}

/** The value the pipeline parsers read: empty when the source is default, so the env.ts fallback never counts as a choice. */
function rawPipeline(env: RagEnvInput): string {
  return pipelineSource(env) === 'default' ? '' : (env.RAG_PIPELINE ?? '');
}

function parsePipeline(raw: string | undefined, warnings: string[]): 'legacy' | 'v2' {
  const value = (raw ?? '').trim();
  if (value === '') return shippedDefaultPipeline();
  if (value === 'legacy') return 'legacy';
  if (value === 'v2') return 'v2';
  problem(warnings, `pipeline:${value}`, 'Unsupported RAG_PIPELINE value, running legacy', { value });
  return 'legacy';
}

function parseBooleanSwitch(raw: string | undefined, defaultValue: boolean, warnKey: string, warnings: string[]): boolean {
  const value = (raw ?? '').trim();
  if (value === '') return defaultValue;
  const normalised = value.toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  problem(warnings, warnKey, `Unsupported switch value, using default ${defaultValue}`, { value });
  return defaultValue;
}

function parseNamedFlag(name: string, raw: string | undefined, warnings: string[]): boolean {
  const value = (raw ?? '').trim();
  if (value === '') return false;
  const normalised = value.toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  problem(warnings, `${name}:${value}`, `Unsupported ${name} value, expected true or false, using false`, { value });
  return false;
}

function parseNamedChoice<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T, warnings: string[]): T {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  const match = allowed.find((candidate) => candidate === value.toLowerCase());
  if (match !== undefined) return match;
  problem(warnings, `${name}:${value}`, `Unsupported ${name} value, using ${fallback}`, { value });
  return fallback;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number, warnings: string[]): number {
  const value = (raw ?? '').trim();
  if (value === '') return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isSafeInteger(n) && n > 0) return n;
  problem(warnings, `${name}:${value}`, `Invalid ${name} value, using ${fallback}`, { value });
  return fallback;
}

function parseBackend(env: RagEnvInput, warnings: string[]): BackendConfig {
  return {
    default: parseNamedChoice('RAG_RETRIEVAL_BACKEND', env.RAG_RETRIEVAL_BACKEND, RETRIEVAL_BACKEND_IDS, 'pgvector', warnings),
    voice: parseNamedChoice('RAG_RETRIEVAL_BACKEND_VOICE', env.RAG_RETRIEVAL_BACKEND_VOICE, RETRIEVAL_BACKEND_IDS, 'pgvector', warnings),
    maxLagSeconds: parsePositiveInt('RAG_VECTOR_SYNC_MAX_LAG_SECONDS', env.RAG_VECTOR_SYNC_MAX_LAG_SECONDS, DEFAULT_MAX_LAG_SECONDS, warnings),
  };
}

function parseExactIdSwitch(raw: string | undefined, warnings: string[]): boolean {
  const value = (raw ?? '').trim();
  if (value === '') return false;
  const normalised = value.toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  problem(warnings, `exact-id-switch:${value}`, 'Unsupported RAG_EXACT_ID_LOOKUP value, expected true or false, using false', { value });
  return false;
}

function parseReranker(raw: string | undefined, warnings: string[]): RerankerSetting {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'none') return 'none';
  if (value === 'cohere' || value === 'voyage' || value === 'local_bm25' || value === 'auto') return value;
  problem(warnings, `reranker:${value}`, 'Unsupported RAG_RERANKER value, using none', { value });
  return 'none';
}

function parseRerankTier(raw: string | undefined, field: string, defaultTier: RerankTier, warnings: string[]): RerankTier {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return defaultTier;
  if (value === 'quality' || value === 'fast') return value;
  problem(warnings, `tier:${field}:${value}`, `Unsupported ${field}, using ${defaultTier}`, { value });
  return defaultTier;
}

const VOYAGE_RERANK_MODELS = new Set(['rerank-3', 'rerank-2.5']);

function parseVoyageModelByLang(raw: string | undefined, warnings: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of parseList(raw)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const lang = entry.slice(0, eq).trim().toLowerCase();
    const model = entry.slice(eq + 1).trim();
    if (!lang) continue;
    if (!VOYAGE_RERANK_MODELS.has(model)) {
      problem(warnings, `voyage-model:${lang}:${model}`, 'Unsupported voyage rerank model for language, entry ignored', { lang, model });
      continue;
    }
    out[lang] = model;
  }
  return out;
}

function parseIterativeScan(raw: string | undefined, warnings: string[]): IterativeScanMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'off') return 'off';
  if (value === 'relaxed_order' || value === 'strict_order') return value;
  problem(warnings, `iterative-scan:${value}`, 'Unsupported RAG_HNSW_ITERATIVE_SCAN value, using off', { value });
  return 'off';
}

function parseNonNegativeInt(raw: string | undefined, defaultValue: number, max: number, warnKey: string, warnings: string[]): number {
  const value = (raw ?? '').trim();
  if (value === '') return defaultValue;
  if (!/^\d+$/.test(value)) {
    problem(warnings, warnKey, `Invalid integer value, using ${defaultValue}`, { value });
    return defaultValue;
  }
  const n = Number(value);
  if (n < 0 || n > max) {
    problem(warnings, warnKey, `Integer out of range 0..${max}, using ${defaultValue}`, { value });
    return defaultValue;
  }
  return n;
}

function parseBoundedInt(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string,
  warnings: string[],
): number {
  const value = (raw ?? '').trim();
  if (value === '') return defaultValue;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    problem(warnings, `${name}:${value}`, `Invalid ${name}, expected an integer from ${min} to ${max}, using ${defaultValue}`, { value });
    return defaultValue;
  }
  return n;
}

function parseOnOff(raw: string | undefined, name: string, warnings: string[]): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'off') return false;
  if (value === 'on') return true;
  problem(warnings, `${name}:${value}`, `Unsupported ${name} value, using off`, { value });
  return false;
}

export const DEFAULT_DOMAIN_EMBEDDING_MAX_LEGS = 2;
export const DEFAULT_DOMAIN_EMBEDDING_TIMEOUT_MS = 800;

/** Domain bindings need the embedding profile registry, so RAG_EMBEDDING_PROFILES=off keeps them off. */
function parseDomainEmbeddings(env: RagEnvInput, warnings: string[]): DomainEmbeddingsConfig {
  const requested = parseOnOff(env.RAG_DOMAIN_EMBEDDINGS, 'RAG_DOMAIN_EMBEDDINGS', warnings);
  const profilesOn = (env.RAG_EMBEDDING_PROFILES ?? '').trim().toLowerCase() === 'on';
  if (requested && !profilesOn) {
    problem(warnings, 'domain-embeddings-profiles-off', 'domain-embeddings needs embedding profiles; RAG_DOMAIN_EMBEDDINGS stays off', {
      RAG_EMBEDDING_PROFILES: (env.RAG_EMBEDDING_PROFILES ?? '').trim() || 'off',
    });
  }
  return {
    enabled: requested && profilesOn,
    maxLegs: parseBoundedInt(env.RAG_DOMAIN_EMBEDDING_MAX_LEGS, DEFAULT_DOMAIN_EMBEDDING_MAX_LEGS, 0, 5, 'RAG_DOMAIN_EMBEDDING_MAX_LEGS', warnings),
    timeoutMs: parseBoundedInt(
      env.RAG_DOMAIN_EMBEDDING_TIMEOUT_MS,
      DEFAULT_DOMAIN_EMBEDDING_TIMEOUT_MS,
      100,
      5000,
      'RAG_DOMAIN_EMBEDDING_TIMEOUT_MS',
      warnings,
    ),
  };
}

const PARAM_KEYS: Record<string, keyof RetrievalParamsOverride> = {
  pool: 'candidate_pool_size',
  cap: 'rerank_input_cap',
  topk: 'final_top_k',
  rrf_k: 'rrf_k',
};

function parseParamsOverride(raw: string | undefined, warnings: string[]): RetrievalParamsOverride {
  const out: RetrievalParamsOverride = {};
  for (const entry of parseList(raw)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim().toLowerCase();
    const text = entry.slice(eq + 1).trim();
    const field = PARAM_KEYS[key];
    if (!field) {
      problem(warnings, `params-key:${key}`, 'Unknown key in RAG_RETRIEVAL_PARAMS_OVERRIDE, entry ignored', { key });
      continue;
    }
    if (!/^\d+$/.test(text)) {
      problem(warnings, `params-value:${key}=${text}`, 'Invalid numeric value in RAG_RETRIEVAL_PARAMS_OVERRIDE, entry ignored', { key, value: text });
      continue;
    }
    const n = Number(text);
    if (field === 'rerank_input_cap' && (n < 25 || n > 100)) {
      problem(warnings, `params-cap:${n}`, 'rerank_input_cap must be 25..100, entry ignored', { cap: n });
      continue;
    }
    out[field] = n;
  }
  return out;
}

function parseDisabled(raw: string | undefined, warnings: string[]): Set<StageName> {
  const disabled = new Set<StageName>();
  for (const name of parseList(raw)) {
    if ((CORE_STAGES as readonly string[]).includes(name)) {
      problem(warnings, `core:${name}`, 'Core stage cannot be disabled, entry ignored', { stage: name });
    } else if (!isStageName(name)) {
      problem(warnings, `unknown:${name}`, 'Unknown stage in RAG_DISABLED_STAGES, entry ignored', { stage: name });
    } else {
      disabled.add(name);
    }
  }
  return disabled;
}

function parseTimeoutMs(text: string, stage: string, warnings: string[]): number | null {
  const ms = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(ms) || ms < MIN_TIMEOUT_MS || ms > MAX_TIMEOUT_MS) {
    problem(
      warnings,
      `timeout-value:${stage}=${text}`,
      `Invalid RAG_STAGE_TIMEOUTS value, expected an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}, entry ignored`,
      { stage },
    );
    return null;
  }
  return ms;
}

function parseTimeouts(raw: string | undefined, warnings: string[]): Partial<Record<Profile, StageTimeouts>> {
  const byProfile: Partial<Record<Profile, StageTimeouts>> = {};
  const global: StageTimeouts = {};

  for (const entry of parseList(raw)) {
    const separator = entry.indexOf('=');
    const left = (separator === -1 ? entry : entry.slice(0, separator)).trim();
    const text = separator === -1 ? '' : entry.slice(separator + 1).trim();
    const dot = left.indexOf('.');
    if (dot > 0) {
      const profileText = left.slice(0, dot).trim().toLowerCase();
      const stage = left.slice(dot + 1).trim();
      if (!isProfile(profileText)) {
        problem(warnings, `timeout-profile:${profileText}`, 'Unknown profile prefix in RAG_STAGE_TIMEOUTS, entry ignored', { profile: profileText });
        continue;
      }
      if (!isStageName(stage)) {
        problem(warnings, `timeout-unknown:${stage}`, 'Unknown stage in RAG_STAGE_TIMEOUTS, entry ignored', { stage });
        continue;
      }
      const ms = parseTimeoutMs(text, `${profileText}.${stage}`, warnings);
      if (ms === null) continue;
      byProfile[profileText] = { ...byProfile[profileText], [stage]: ms };
      continue;
    }
    const name = left;
    if (!isStageName(name)) {
      problem(warnings, `timeout-unknown:${name}`, 'Unknown stage in RAG_STAGE_TIMEOUTS, entry ignored', { stage: name });
      continue;
    }
    const ms = parseTimeoutMs(text, name, warnings);
    if (ms === null) continue;
    global[name] = ms;
  }

  if (Object.keys(global).length > 0) {
    const merged: Partial<Record<Profile, StageTimeouts>> = { ...byProfile };
    for (const profile of PROFILES) {
      merged[profile] = { ...global, ...merged[profile] };
    }
    return merged;
  }
  return byProfile;
}

function parsePrefixedBoolean(name: string, raw: string | undefined, defaultValue: boolean, prefix: LogPrefix, warnings: string[]): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  problem(warnings, `${name}:${value}`, `Unsupported ${name} value, expected true or false, using ${defaultValue}`, { value }, prefix);
  return defaultValue;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const VOICE_TRANSFORMS: readonly VoiceTransform[] = ['condense_history', 'normalize_dates', 'translate'];
const VOICE_FORBIDDEN = new Set(['expand', 'hyde', 'decompose']);
const DEFAULT_VOICE_TRANSFORMS = 'condense_history,normalize_dates';

function parseVoiceTransforms(raw: string | undefined, warnings: string[]): VoiceTransform[] {
  const source = (raw ?? '').trim() === '' ? DEFAULT_VOICE_TRANSFORMS : (raw as string);
  const kept: VoiceTransform[] = [];
  const dropped: string[] = [];
  for (const name of parseList(source)) {
    const normalised = name.toLowerCase();
    const match = VOICE_TRANSFORMS.find((candidate) => candidate === normalised);
    if (match) {
      if (!kept.includes(match)) kept.push(match);
    } else {
      dropped.push(VOICE_FORBIDDEN.has(normalised) ? normalised : 'unknown');
    }
  }
  if (dropped.length > 0) {
    problem(
      warnings,
      `voice-transforms:${dropped.join(',')}`,
      'RAG_QUERY_VOICE_TRANSFORMS lists transforms voice cannot run; entries dropped',
      { dropped: dropped.join(',') },
      '[Query Layer]',
    );
  }
  return kept;
}

const EMBEDDING_PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Embedding-profile ids (D-24) whose multilingual embedding makes query translation unnecessary. */
function parseTranslateDisabledProfiles(raw: string | undefined, warnings: string[]): string[] {
  const out: string[] = [];
  let invalid = 0;
  for (const name of parseList(raw)) {
    if (EMBEDDING_PROFILE_ID_PATTERN.test(name)) {
      if (!out.includes(name)) out.push(name);
    } else {
      invalid += 1;
    }
  }
  if (invalid > 0) {
    problem(warnings, `translate-disabled-profiles:${raw}`, 'Malformed embedding-profile id in RAG_QUERY_TRANSLATE_DISABLED_PROFILES, entry ignored', { invalid }, '[Query Layer]');
  }
  return out;
}

function parseQueryLayer(env: RagEnvInput, pipeline: 'legacy' | 'v2', warnings: string[]): QueryLayerConfig {
  const requested = parsePrefixedBoolean('RAG_QUERY_LAYER', env.RAG_QUERY_LAYER, false, '[Query Layer]', warnings);
  if (requested && pipeline !== 'v2') {
    problem(warnings, 'query-layer-legacy', 'RAG_QUERY_LAYER needs RAG_PIPELINE=v2; the query layer stays off', { pipeline }, '[Query Layer]');
  }
  const frameworkRaw = (env.RAG_QUERY_FRAMEWORK ?? '').trim().toLowerCase();
  let framework: QueryFramework = 'llamaindex';
  if (frameworkRaw === 'langchain') framework = 'langchain';
  else if (frameworkRaw !== '' && frameworkRaw !== 'llamaindex') {
    problem(warnings, `query-framework:${frameworkRaw}`, 'Unsupported RAG_QUERY_FRAMEWORK value, using llamaindex', { value: frameworkRaw.slice(0, 32) }, '[Query Layer]');
  }
  const modelRaw = (env.RAG_QUERY_LLM_MODEL ?? '').trim();
  let model = DEFAULT_QUERY_LLM_MODEL;
  if (MODEL_ID_PATTERN.test(modelRaw)) model = modelRaw;
  else if (modelRaw !== '') {
    problem(warnings, 'query-llm-model-invalid', `Invalid RAG_QUERY_LLM_MODEL, using ${DEFAULT_QUERY_LLM_MODEL}`, { length: modelRaw.length }, '[Query Layer]');
  }
  const flag = (name: string, raw: string | undefined, defaultValue: boolean) => parsePrefixedBoolean(name, raw, defaultValue, '[Query Layer]', warnings);
  return {
    enabled: requested && pipeline === 'v2',
    framework,
    model,
    transforms: {
      condense: flag('RAG_QUERY_CONDENSE', env.RAG_QUERY_CONDENSE, true),
      expand: flag('RAG_QUERY_EXPAND', env.RAG_QUERY_EXPAND, true),
      decompose: flag('RAG_QUERY_DECOMPOSE', env.RAG_QUERY_DECOMPOSE, true),
      translate: flag('RAG_QUERY_TRANSLATE', env.RAG_QUERY_TRANSLATE, true),
      normalizeDates: flag('RAG_QUERY_DATE_NORMALIZE', env.RAG_QUERY_DATE_NORMALIZE, true),
      hyde: flag('RAG_QUERY_HYDE', env.RAG_QUERY_HYDE, false),
    },
    translateDisabledProfiles: parseTranslateDisabledProfiles(env.RAG_QUERY_TRANSLATE_DISABLED_PROFILES, warnings),
    voiceTransforms: parseVoiceTransforms(env.RAG_QUERY_VOICE_TRANSFORMS, warnings),
  };
}

function parseCacheDistance(raw: string | undefined, warnings: string[]): number {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_SEMANTIC_CACHE_MAX_DISTANCE;
  const n = /^\d*\.?\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_SEMANTIC_CACHE_DISTANCE) {
    problem(
      warnings,
      `cache-distance:${value}`,
      `Invalid RAG_SEMANTIC_CACHE_MAX_DISTANCE, expected a number above 0 and at most ${MAX_SEMANTIC_CACHE_DISTANCE}, using ${DEFAULT_SEMANTIC_CACHE_MAX_DISTANCE}`,
      { value: value.slice(0, 32) },
      '[Semantic Cache]',
    );
    return DEFAULT_SEMANTIC_CACHE_MAX_DISTANCE;
  }
  return n;
}

function parseCacheTtl(name: string, raw: string | undefined, defaultValue: number, warnings: string[]): number {
  const value = (raw ?? '').trim();
  if (value === '') return defaultValue;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 604800) {
    problem(warnings, `${name}:${value}`, `Invalid ${name}, expected seconds from 1 to 604800, using ${defaultValue}`, { value: value.slice(0, 32) }, '[Semantic Cache]');
    return defaultValue;
  }
  return n;
}

function parseSemanticCache(env: RagEnvInput, pipeline: 'legacy' | 'v2', warnings: string[]): SemanticCacheConfig {
  const raw = (env.RAG_SEMANTIC_CACHE ?? '').trim().toLowerCase();
  let backend: SemanticCacheBackend = 'off';
  if (raw === 'pgvector' || raw === 'redisvl') backend = raw;
  else if (raw !== '' && raw !== 'off') {
    problem(warnings, `cache-backend:${raw}`, 'Unsupported RAG_SEMANTIC_CACHE value, using off', { value: raw.slice(0, 32) }, '[Semantic Cache]');
  }
  if (backend !== 'off' && pipeline !== 'v2') {
    problem(warnings, 'cache-legacy', 'RAG_SEMANTIC_CACHE needs RAG_PIPELINE=v2; the cache stays off', { pipeline, backend }, '[Semantic Cache]');
    backend = 'off';
  }
  return {
    backend,
    ttl: parseCacheTtl('RAG_SEMANTIC_CACHE_TTL', env.RAG_SEMANTIC_CACHE_TTL, 3600, warnings),
    refusalTtl: parseCacheTtl('RAG_SEMANTIC_CACHE_REFUSAL_TTL', env.RAG_SEMANTIC_CACHE_REFUSAL_TTL, 600, warnings),
    maxDistance: parseCacheDistance(env.RAG_SEMANTIC_CACHE_MAX_DISTANCE, warnings),
    embedStore: parsePrefixedBoolean('RAG_SEMANTIC_CACHE_EMBED_STORE', env.RAG_SEMANTIC_CACHE_EMBED_STORE, false, '[Semantic Cache]', warnings),
  };
}

/** Off layer: every query-layer stage is disabled. On: only the stages whose sub-switch is off. The cache stage follows its backend. */
function applyQueryLayerDisabledStages(queryLayer: QueryLayerConfig, cache: SemanticCacheConfig, disabled: Set<StageName>): void {
  if (cache.backend === 'off') disabled.add('semantic_cache');
  if (!queryLayer.enabled) {
    for (const stage of QUERY_LAYER_STAGES) if (stage !== 'semantic_cache') disabled.add(stage);
    return;
  }
  const t = queryLayer.transforms;
  if (!t.condense) disabled.add('condense');
  if (!t.normalizeDates) disabled.add('normalize_dates');
  if (!t.expand) disabled.add('expand');
  if (!t.hyde) disabled.add('hyde');
  if (!t.decompose) disabled.add('decompose');
}

function applyV2DisabledStages(v2: V2Config, disabled: Set<StageName>): void {
  if (v2.reranker === 'none') disabled.add('rerank');
  if (!v2.compression) disabled.add('compress');
  if (!v2.parentChild) disabled.add('expand_parents');
  if (!v2.lexicalTranslation) disabled.add('translate');
  if (!v2.tableLookup) disabled.add('table_lookup');
  if (v2.resultDiversity === 'off') disabled.add('diversify');
  if (!v2.identifierFilter) {
    disabled.add('identifier_resolve');
    disabled.add('identifier_guard');
  }
  if (!v2.terminology) disabled.add('terminology');
  if (v2.attributeFilter === 'off') disabled.add('attribute_resolve');
}

/** D-42: the version stored with lexical text and refusal cells; LEXICAL_VERSION (2) itself never changes. */
export function lexicalVersionFor(dictionary: boolean, stemIt: boolean, quantity = false): number {
  return LEXICAL_VERSION + (dictionary ? 1 : 0) + (stemIt ? 2 : 0) + (quantity ? 4 : 0);
}

export function effectiveLexicalVersion(config: Pick<RagConfig, 'v2'>): number {
  return config.v2.lexicalVersion;
}

interface TuningSwitches {
  lexicalDictionary: boolean;
  lexicalStemIt: boolean;
  versionScope: boolean;
  tableLookup: boolean;
  dupClusters: boolean;
  resultDiversity: ResultDiversityMode;
  identifierIndex: boolean;
  identifierFilter: boolean;
  lexicalQuantity: boolean;
  lexicalVersion: number;
}

/** D-04, D-40: invalid combinations resolve here, so every consumer reads one effective value. */
function parseTuningSwitches(env: RagEnvInput, lexicalSearch: boolean, warnings: string[]): TuningSwitches {
  const lexicalDictionary = parseBooleanSwitch(env.RAG_LEXICAL_DICTIONARY, false, 'lexical-dictionary', warnings);
  const lexicalStemIt = parseBooleanSwitch(env.RAG_LEXICAL_STEM_IT, false, 'lexical-stem-it', warnings);
  const versionRequested = parseBooleanSwitch(env.RAG_VERSION_SCOPE, false, 'version-scope', warnings);
  const tableLookup = parseBooleanSwitch(env.RAG_TABLE_LOOKUP, false, 'table-lookup', warnings);
  const dupClusters = parseBooleanSwitch(env.RAG_DUP_CLUSTERS, false, 'dup-clusters', warnings);
  const resultDiversity = parseNamedChoice('RAG_RESULT_DIVERSITY', env.RAG_RESULT_DIVERSITY, RESULT_DIVERSITY_MODES, 'off', warnings);
  const identifierIndex = parseBooleanSwitch(env.RAG_IDENTIFIER_INDEX, false, 'identifier-index', warnings);
  const filterRequested = parseBooleanSwitch(env.RAG_IDENTIFIER_FILTER, false, 'identifier-filter', warnings);
  const lexicalQuantity = parseNamedFlag('RAG_LEXICAL_QUANTITY', env.RAG_LEXICAL_QUANTITY, warnings);

  if (filterRequested && !identifierIndex) {
    problem(warnings, 'identifier-filter-needs-index', 'RAG_IDENTIFIER_FILTER needs RAG_IDENTIFIER_INDEX=true; retrieval runs unfiltered', {
      RAG_IDENTIFIER_INDEX: (env.RAG_IDENTIFIER_INDEX ?? '').trim() || 'false',
    });
  }
  if (versionRequested && !lexicalSearch) {
    problem(warnings, 'version-scope-needs-lexical', 'RAG_VERSION_SCOPE needs RAG_LEXICAL_SEARCH=true; retrieval scopes to current versions only', {
      RAG_LEXICAL_SEARCH: (env.RAG_LEXICAL_SEARCH ?? '').trim() || 'false',
    });
  }
  if (resultDiversity === 'collapse' && !dupClusters) {
    problem(warnings, 'diversity-collapse-needs-clusters', 'RAG_RESULT_DIVERSITY=collapse has no clusters to act on while RAG_DUP_CLUSTERS is off', {
      RAG_DUP_CLUSTERS: (env.RAG_DUP_CLUSTERS ?? '').trim() || 'false',
    });
  }

  return {
    lexicalDictionary,
    lexicalStemIt,
    versionScope: versionRequested && lexicalSearch,
    tableLookup,
    dupClusters,
    resultDiversity,
    identifierIndex,
    identifierFilter: filterRequested && identifierIndex,
    lexicalQuantity,
    lexicalVersion: lexicalVersionFor(lexicalDictionary, lexicalStemIt, lexicalQuantity),
  };
}

/** D-03: the filter needs stored attributes and the v2 graph; each unmet need logs once and the filter is off. */
function parseAttributeFilter(env: RagEnvInput, pipeline: 'legacy' | 'v2', docAttributes: boolean, warnings: string[]): AttributeFilterMode {
  const requested = parseNamedChoice('RAG_ATTRIBUTE_FILTER', env.RAG_ATTRIBUTE_FILTER, ATTRIBUTE_FILTER_MODES, 'off', warnings);
  if (requested === 'off') return 'off';
  let met = true;
  if (!docAttributes) {
    problem(warnings, 'attribute-filter-needs-attributes', 'RAG_ATTRIBUTE_FILTER needs RAG_DOC_ATTRIBUTES=true; the filter stays off', {
      RAG_ATTRIBUTE_FILTER: requested,
      RAG_DOC_ATTRIBUTES: (env.RAG_DOC_ATTRIBUTES ?? '').trim() || 'false',
    });
    met = false;
  }
  if (pipeline !== 'v2') {
    problem(warnings, 'attribute-filter-needs-v2', 'RAG_ATTRIBUTE_FILTER needs RAG_PIPELINE=v2; the filter stays off', {
      RAG_ATTRIBUTE_FILTER: requested,
      RAG_PIPELINE: pipeline,
    });
    met = false;
  }
  return met ? requested : 'off';
}


function parseTerminologyDense(env: RagEnvInput, terminology: boolean, warnings: string[]): boolean {
  const dense = parseBooleanSwitch(env.RAG_TERMINOLOGY_DENSE, false, 'terminology-dense', warnings);
  if (dense && !terminology) {
    problem(warnings, 'terminology-dense:requires-terminology', 'RAG_TERMINOLOGY_DENSE needs RAG_TERMINOLOGY=true, using false', { RAG_TERMINOLOGY_DENSE: 'true' });
    return false;
  }
  return dense;
}

function memoKey(env: RagEnvInput): string {
  return JSON.stringify([
    env.RAG_PIPELINE ?? '',
    pipelineSource(env),
    shippedDefaultPipeline(),
    env.RAG_DISABLED_STAGES ?? '',
    env.RAG_STAGE_TIMEOUTS ?? '',
    env.RAG_EXACT_ID_LOOKUP ?? '',
    env.RAG_LEXICAL_SEARCH ?? '',
    env.RAG_RERANKER ?? '',
    env.RAG_RERANK_TIER_CHAT ?? '',
    env.RAG_RERANK_TIER_VOICE ?? '',
    env.RAG_RERANK_VOYAGE_MODEL_BY_LANG ?? '',
    (env.COHERE_API_KEY ?? '').trim() !== '',
    env.COHERE_BASE_URL ?? '',
    env.RAG_REFUSAL_THRESHOLD ?? '',
    env.RAG_REFUSAL_FLOOR ?? '',
    env.RAG_CONTEXT_EDGE_ORDER ?? '',
    env.RAG_CONTEXT_COMPRESSION ?? '',
    env.RAG_CONTEXT_TOKEN_BUDGET ?? '',
    env.RAG_PARENT_CHILD ?? '',
    env.RAG_HNSW_ITERATIVE_SCAN ?? '',
    env.RAG_EXACT_SCAN_CUTOFF ?? '',
    env.RAG_LEXICAL_TRANSLATION ?? '',
    env.RAG_LEXICAL_DICTIONARY ?? '',
    env.RAG_LEXICAL_STEM_IT ?? '',
    env.RAG_VERSION_SCOPE ?? '',
    env.RAG_TABLE_LOOKUP ?? '',
    env.RAG_DUP_CLUSTERS ?? '',
    env.RAG_RESULT_DIVERSITY ?? '',
    env.RAG_IDENTIFIER_INDEX ?? '',
    env.RAG_IDENTIFIER_FILTER ?? '',
    env.RAG_ATTRIBUTE_FILTER ?? '',
    env.RAG_LEXICAL_QUANTITY ?? '',
    env.RAG_DOC_ATTRIBUTES ?? '',
    env.RAG_TERMINOLOGY ?? '',
    env.RAG_TERMINOLOGY_DENSE ?? '',
    env.RAG_TERMINOLOGY_MINING ?? '',
    env.RAG_RETRIEVAL_PARAMS_OVERRIDE ?? '',
    (env.VOYAGE_API_KEY ?? '').trim() !== '',
    env.VOYAGE_BASE_URL ?? '',
    env.RAG_EFFECTIVE_DATES ?? '',
    env.RAG_SCOPE_TAGS ?? '',
    env.RAG_DOC_TRANSLATION ?? '',
    env.RAG_BGE_M3_SERVING ?? '',
    env.RAG_OUTPUT_LINK_ALLOWLIST ?? '',
    env.RAG_EMBEDDING_PROFILES ?? '',
    env.RAG_DOMAIN_EMBEDDINGS ?? '',
    env.RAG_DOMAIN_EMBEDDING_MAX_LEGS ?? '',
    env.RAG_DOMAIN_EMBEDDING_TIMEOUT_MS ?? '',
    env.RAG_QUERY_LAYER ?? '',
    env.RAG_QUERY_FRAMEWORK ?? '',
    env.RAG_QUERY_LLM_MODEL ?? '',
    env.RAG_QUERY_CONDENSE ?? '',
    env.RAG_QUERY_EXPAND ?? '',
    env.RAG_QUERY_DECOMPOSE ?? '',
    env.RAG_QUERY_TRANSLATE ?? '',
    env.RAG_QUERY_DATE_NORMALIZE ?? '',
    env.RAG_QUERY_HYDE ?? '',
    env.RAG_QUERY_TRANSLATE_DISABLED_PROFILES ?? '',
    env.RAG_QUERY_VOICE_TRANSFORMS ?? '',
    env.RAG_SEMANTIC_CACHE ?? '',
    env.RAG_SEMANTIC_CACHE_TTL ?? '',
    env.RAG_SEMANTIC_CACHE_REFUSAL_TTL ?? '',
    env.RAG_SEMANTIC_CACHE_MAX_DISTANCE ?? '',
    env.RAG_SEMANTIC_CACHE_EMBED_STORE ?? '',
    env.RAG_RETRIEVAL_BACKEND ?? '',
    env.RAG_RETRIEVAL_BACKEND_VOICE ?? '',
    env.RAG_VECTOR_SYNC_MAX_LAG_SECONDS ?? '',
  ]);
}

interface LanguageGate {
  blocked: LanguagesNotConfigured | null;
  /** An unset RAG_PIPELINE whose shipped default is v2 serves legacy while the languages are not chosen. */
  servedLegacy: boolean;
  monolingual: boolean;
}

const NO_LANGUAGE_GATE: LanguageGate = { blocked: null, servedLegacy: false, monolingual: false };

/** D-02: a legacy pipeline (set or defaulted) keeps today's path and never reads the language settings. */
function languageGate(env: RagEnvInput): LanguageGate {
  const raw = rawPipeline(env);
  const value = raw.trim();
  const shipped = shippedDefaultPipeline();
  if (value === 'legacy' || (value === '' && shipped === 'legacy')) return NO_LANGUAGE_GATE;
  const resolved = resolvePipelines({ RAG_PIPELINE: raw, RAG_INGEST_PIPELINE: 'legacy' }, { retrieval: shipped, ingest: 'legacy' }, getLanguageSettings);
  if (!resolved.languagesRead) return NO_LANGUAGE_GATE;
  return {
    blocked: resolved.retrieval.pipeline === LANGUAGES_NOT_CONFIGURED ? LANGUAGES_NOT_CONFIGURED : null,
    servedLegacy: resolved.retrieval.servedLegacyBecauseUnset,
    monolingual: resolved.monolingual,
  };
}

export function loadRagConfig(env: RagEnvInput): RagConfig {
  const gate = languageGate(env);
  const snapshot = gate === NO_LANGUAGE_GATE ? memoKey(env) : `${memoKey(env)}|${gate.blocked ?? ''}|${gate.servedLegacy}|${gate.monolingual}`;
  const cached = memo.get(snapshot);
  if (cached) return cached;

  const warnings: string[] = [];
  const pipeline = gate.servedLegacy ? 'legacy' : parsePipeline(rawPipeline(env), warnings);
  const disabledStages = parseDisabled(env.RAG_DISABLED_STAGES, warnings);
  const overrideByProfile = parseTimeouts(env.RAG_STAGE_TIMEOUTS, warnings);
  const queryLayer = parseQueryLayer(env, pipeline, warnings);
  const semanticCache = parseSemanticCache(env, pipeline, warnings);

  const timeouts = {} as Record<Profile, StageTimeouts>;
  for (const profile of PROFILES) {
    const layerTranslate = queryLayer.enabled ? QUERY_LAYER_TRANSLATE[profile] : undefined;
    timeouts[profile] = {
      ...PROFILE_STAGE_DEFAULTS[profile],
      ...(layerTranslate !== undefined ? { translate: layerTranslate } : {}),
      ...overrideByProfile[profile],
    };
  }

  const exactIdLookup = parseExactIdSwitch(env.RAG_EXACT_ID_LOOKUP, warnings);
  const terminology = parseBooleanSwitch(env.RAG_TERMINOLOGY, false, 'terminology', warnings);

  const lexicalSearch = parseBooleanSwitch(env.RAG_LEXICAL_SEARCH, false, 'lexical-search', warnings);
  const docAttributes = parseNamedFlag('RAG_DOC_ATTRIBUTES', env.RAG_DOC_ATTRIBUTES, warnings);
  const v2: V2Config = {
    lexicalSearch,
    reranker: parseReranker(env.RAG_RERANKER, warnings),
    rerankTier: {
      chat: parseRerankTier(env.RAG_RERANK_TIER_CHAT, 'RAG_RERANK_TIER_CHAT', 'quality', warnings),
      voice: parseRerankTier(env.RAG_RERANK_TIER_VOICE, 'RAG_RERANK_TIER_VOICE', 'fast', warnings),
    },
    voyageModelByLang: parseVoyageModelByLang(env.RAG_RERANK_VOYAGE_MODEL_BY_LANG, warnings),
    refusalThreshold: parseBooleanSwitch(env.RAG_REFUSAL_THRESHOLD, false, 'refusal-threshold', warnings),
    refusalFloor: parseNamedChoice('RAG_REFUSAL_FLOOR', env.RAG_REFUSAL_FLOOR, REFUSAL_FLOOR_POLICIES, 'similarity', warnings),
    edgeOrder: parseBooleanSwitch(env.RAG_CONTEXT_EDGE_ORDER, false, 'edge-order', warnings),
    compression: parseBooleanSwitch(env.RAG_CONTEXT_COMPRESSION, false, 'compression', warnings),
    tokenBudget: parseNonNegativeInt(env.RAG_CONTEXT_TOKEN_BUDGET, 6000, 1_000_000, 'token-budget', warnings),
    parentChild: parseBooleanSwitch(env.RAG_PARENT_CHILD, false, 'parent-child', warnings),
    iterativeScan: parseIterativeScan(env.RAG_HNSW_ITERATIVE_SCAN, warnings),
    exactScanCutoff: parseNonNegativeInt(env.RAG_EXACT_SCAN_CUTOFF, 0, 100_000, 'exact-scan-cutoff', warnings),
    lexicalTranslation: gate.monolingual ? false : parseBooleanSwitch(env.RAG_LEXICAL_TRANSLATION, false, 'lexical-translation', warnings),
    terminology,
    terminologyDense: parseTerminologyDense(env, terminology, warnings),
    terminologyMining: parseBooleanSwitch(env.RAG_TERMINOLOGY_MINING, false, 'terminology-mining', warnings),
    paramsOverride: parseParamsOverride(env.RAG_RETRIEVAL_PARAMS_OVERRIDE, warnings),
    hasCohereKey: (env.COHERE_API_KEY ?? '').trim() !== '',
    hasVoyageKey: (env.VOYAGE_API_KEY ?? '').trim() !== '',
    domainEmbeddings: parseDomainEmbeddings(env, warnings),
    ...parseTuningSwitches(env, lexicalSearch, warnings),
    attributeFilter: parseAttributeFilter(env, pipeline, docAttributes, warnings),
  };

  const operatorDisabledStages: ReadonlySet<StageName> = new Set(disabledStages);
  applyV2DisabledStages(v2, disabledStages);
  applyQueryLayerDisabledStages(queryLayer, semanticCache, disabledStages);

  const config: RagConfig = {
    pipeline,
    pipelineSource: pipelineSource(env),
    pipelineServedLegacy: gate.servedLegacy,
    pipelineBlocked: gate.blocked,
    monolingual: gate.monolingual,
    disabledStages,
    operatorDisabledStages,
    timeouts,
    exactIdLookup,
    v2,
    effectiveDates: parseNamedFlag('RAG_EFFECTIVE_DATES', env.RAG_EFFECTIVE_DATES, warnings),
    scopeTags: parseNamedFlag('RAG_SCOPE_TAGS', env.RAG_SCOPE_TAGS, warnings),
    docAttributes,
    docTranslation: parseNamedChoice('RAG_DOC_TRANSLATION', env.RAG_DOC_TRANSLATION, ['off', 'on'], 'off', warnings),
    bgeM3Serving: parseNamedChoice('RAG_BGE_M3_SERVING', env.RAG_BGE_M3_SERVING, ['hosted', 'sidecar'], 'hosted', warnings),
    outputLinkAllowlist: (env.RAG_OUTPUT_LINK_ALLOWLIST ?? '').trim(),
    queryLayer,
    semanticCache,
    backend: parseBackend(env, warnings),
    warnings,
  };
  memo.set(snapshot, config);
  return config;
}

export const DEFAULT_FINAL_RESULT_COUNT = 25;
export const MAX_FINAL_RESULT_COUNT = 100;

export function validResultCount(value: unknown): number | null {
  const count = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return null;
  return Math.min(count, MAX_FINAL_RESULT_COUNT);
}

/** A caller value wins, then RAG_FINAL_RESULT_COUNT, then 25; anything non-numeric or below 1 never reaches the search limit. */
export function resolveFinalResultCount(requested: unknown, envValue: string | undefined): number {
  const fromRequest = validResultCount(requested);
  if (fromRequest !== null) return fromRequest;
  const fromEnv = validResultCount(envValue);
  if (fromEnv === null && envValue !== undefined && envValue.trim() !== '') {
    problem([], 'result-count', 'Invalid RAG_FINAL_RESULT_COUNT, using the default', { default: DEFAULT_FINAL_RESULT_COUNT });
  }
  return fromEnv ?? DEFAULT_FINAL_RESULT_COUNT;
}

/**
 * Listing injection_check in RAG_DISABLED_STAGES while RAG_INJECTION_CHECK is on silently turns off a security
 * control, so it is allowed with one warning per process.
 */
export function warnInjectionCheckDisabled(config: RagConfig, injectionCheck: string): boolean {
  if (injectionCheck === 'off' || !config.disabledStages.has('injection_check')) return false;
  problem([], 'injection-check-disabled', 'injection_check is listed in RAG_DISABLED_STAGES while RAG_INJECTION_CHECK is on; the check is disabled', {
    mode: injectionCheck,
  });
  return true;
}

/** D-18, D-19: the dense terminology variant never runs in voice and needs the stage switch. */
export function terminologyDenseFor(config: RagConfig, profile: Profile): boolean {
  return config.v2.terminology && config.v2.terminologyDense && profile !== 'voice';
}

export function resetRagConfigForTests(): void {
  loggedProblems.clear();
  memo.clear();
}