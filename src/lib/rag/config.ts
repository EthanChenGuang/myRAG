import type { Profile } from './types';

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
] as const;

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
  fuse: 1000,
  dedupe: 1000,
  rerank: 600,
  refusal: 1000,
  expand_parents: 3000,
  compress: 1000,
};

const V2_VOICE: StageTimeouts = {
  translate: 300,
  fuse: 300,
  dedupe: 300,
  rerank: 250,
  refusal: 300,
  expand_parents: 1000,
  compress: 1000,
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

function mergeProfileDefaults(legacy: StageTimeouts, v2: StageTimeouts, extra?: StageTimeouts): StageTimeouts {
  return { ...legacy, ...v2, ...extra };
}

export const PROFILE_STAGE_DEFAULTS: Record<Profile, StageTimeouts> = {
  chat: mergeProfileDefaults(LEGACY_STANDARD, V2_STANDARD, { injection_check: INJECTION_CHECK_TIMEOUTS.chat }),
  embed: mergeProfileDefaults(LEGACY_STANDARD, V2_STANDARD, { injection_check: INJECTION_CHECK_TIMEOUTS.embed }),
  eval: mergeProfileDefaults(LEGACY_STANDARD, V2_STANDARD, {
    ...V2_EVAL,
    translate: 1000,
    fuse: 1000,
    dedupe: 1000,
    refusal: 1000,
    compress: 1000,
    injection_check: INJECTION_CHECK_TIMEOUTS.eval,
  }),
  media: mergeProfileDefaults(LEGACY_STANDARD, V2_STANDARD, { injection_check: INJECTION_CHECK_TIMEOUTS.media }),
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
      { injection_check: INJECTION_CHECK_TIMEOUTS.voice },
    ),
  },
};

export const FALLBACK_STAGE_TIMEOUT_MS = 10000;

const MIN_TIMEOUT_MS = 1;
const MAX_TIMEOUT_MS = 60000;
const PROFILES = Object.keys(PROFILE_STAGE_DEFAULTS) as Profile[];

export type RerankerKind = 'none' | 'cohere' | 'voyage' | 'local_bm25';
export type RerankTier = 'quality' | 'fast';
export type IterativeScanMode = 'off' | 'relaxed_order' | 'strict_order';

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

export interface V2Config {
  lexicalSearch: boolean;
  reranker: RerankerKind;
  rerankTier: { chat: RerankTier; voice: RerankTier };
  voyageModelByLang: Record<string, string>;
  refusalThreshold: boolean;
  edgeOrder: boolean;
  compression: boolean;
  tokenBudget: number;
  parentChild: boolean;
  iterativeScan: IterativeScanMode;
  exactScanCutoff: number;
  lexicalTranslation: boolean;
  paramsOverride: RetrievalParamsOverride;
  hasCohereKey: boolean;
  hasVoyageKey: boolean;
  domainEmbeddings: DomainEmbeddingsConfig;
}

export interface RagEnvInput {
  RAG_PIPELINE?: string;
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
  RAG_CONTEXT_EDGE_ORDER?: string;
  RAG_CONTEXT_COMPRESSION?: string;
  RAG_CONTEXT_TOKEN_BUDGET?: string;
  RAG_PARENT_CHILD?: string;
  RAG_HNSW_ITERATIVE_SCAN?: string;
  RAG_EXACT_SCAN_CUTOFF?: string;
  RAG_LEXICAL_TRANSLATION?: string;
  RAG_RETRIEVAL_PARAMS_OVERRIDE?: string;
  VOYAGE_API_KEY?: string;
  VOYAGE_BASE_URL?: string;
  RAG_EMBEDDING_PROFILES?: string;
  RAG_DOMAIN_EMBEDDINGS?: string;
  RAG_DOMAIN_EMBEDDING_MAX_LEGS?: string;
  RAG_DOMAIN_EMBEDDING_TIMEOUT_MS?: string;
}

export interface RagConfig {
  pipeline: 'legacy' | 'v2';
  disabledStages: ReadonlySet<StageName>;
  timeouts: Record<Profile, StageTimeouts>;
  exactIdLookup: boolean;
  v2: V2Config;
  warnings: string[];
}

const loggedProblems = new Set<string>();
const memo = new Map<string, RagConfig>();

function problem(warnings: string[], key: string, message: string, data: Record<string, unknown>): void {
  warnings.push(`${message} (${Object.values(data).join(', ')})`);
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[RAG Config] ${message}`, data);
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

function parsePipeline(raw: string | undefined, warnings: string[]): 'legacy' | 'v2' {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'legacy') return 'legacy';
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

function parseExactIdSwitch(raw: string | undefined, warnings: string[]): boolean {
  const value = (raw ?? '').trim();
  if (value === '') return false;
  const normalised = value.toLowerCase();
  if (normalised === 'true') return true;
  if (normalised === 'false') return false;
  problem(warnings, `exact-id-switch:${value}`, 'Unsupported RAG_EXACT_ID_LOOKUP value, expected true or false, using false', { value });
  return false;
}

function parseReranker(raw: string | undefined, warnings: string[]): RerankerKind {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'none') return 'none';
  if (value === 'cohere' || value === 'voyage' || value === 'local_bm25') return value;
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
    if (field === 'rerank_input_cap' && (n < 50 || n > 100)) {
      problem(warnings, `params-cap:${n}`, 'rerank_input_cap must be 50..100, entry ignored', { cap: n });
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

function applyV2DisabledStages(v2: V2Config, disabled: Set<StageName>): void {
  if (v2.reranker === 'none') disabled.add('rerank');
  if (!v2.compression) disabled.add('compress');
  if (!v2.parentChild) disabled.add('expand_parents');
  if (!v2.lexicalTranslation) disabled.add('translate');
}

function memoKey(env: RagEnvInput): string {
  return JSON.stringify([
    env.RAG_PIPELINE ?? '',
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
    env.RAG_CONTEXT_EDGE_ORDER ?? '',
    env.RAG_CONTEXT_COMPRESSION ?? '',
    env.RAG_CONTEXT_TOKEN_BUDGET ?? '',
    env.RAG_PARENT_CHILD ?? '',
    env.RAG_HNSW_ITERATIVE_SCAN ?? '',
    env.RAG_EXACT_SCAN_CUTOFF ?? '',
    env.RAG_LEXICAL_TRANSLATION ?? '',
    env.RAG_RETRIEVAL_PARAMS_OVERRIDE ?? '',
    (env.VOYAGE_API_KEY ?? '').trim() !== '',
    env.VOYAGE_BASE_URL ?? '',
    env.RAG_EMBEDDING_PROFILES ?? '',
    env.RAG_DOMAIN_EMBEDDINGS ?? '',
    env.RAG_DOMAIN_EMBEDDING_MAX_LEGS ?? '',
    env.RAG_DOMAIN_EMBEDDING_TIMEOUT_MS ?? '',
  ]);
}

export function loadRagConfig(env: RagEnvInput): RagConfig {
  const snapshot = memoKey(env);
  const cached = memo.get(snapshot);
  if (cached) return cached;

  const warnings: string[] = [];
  const pipeline = parsePipeline(env.RAG_PIPELINE, warnings);
  const disabledStages = parseDisabled(env.RAG_DISABLED_STAGES, warnings);
  const overrideByProfile = parseTimeouts(env.RAG_STAGE_TIMEOUTS, warnings);

  const timeouts = {} as Record<Profile, StageTimeouts>;
  for (const profile of PROFILES) {
    timeouts[profile] = { ...PROFILE_STAGE_DEFAULTS[profile], ...overrideByProfile[profile] };
  }

  const exactIdLookup = parseExactIdSwitch(env.RAG_EXACT_ID_LOOKUP, warnings);

  const v2: V2Config = {
    lexicalSearch: parseBooleanSwitch(env.RAG_LEXICAL_SEARCH, false, 'lexical-search', warnings),
    reranker: parseReranker(env.RAG_RERANKER, warnings),
    rerankTier: {
      chat: parseRerankTier(env.RAG_RERANK_TIER_CHAT, 'RAG_RERANK_TIER_CHAT', 'quality', warnings),
      voice: parseRerankTier(env.RAG_RERANK_TIER_VOICE, 'RAG_RERANK_TIER_VOICE', 'fast', warnings),
    },
    voyageModelByLang: parseVoyageModelByLang(env.RAG_RERANK_VOYAGE_MODEL_BY_LANG, warnings),
    refusalThreshold: parseBooleanSwitch(env.RAG_REFUSAL_THRESHOLD, false, 'refusal-threshold', warnings),
    edgeOrder: parseBooleanSwitch(env.RAG_CONTEXT_EDGE_ORDER, false, 'edge-order', warnings),
    compression: parseBooleanSwitch(env.RAG_CONTEXT_COMPRESSION, false, 'compression', warnings),
    tokenBudget: parseNonNegativeInt(env.RAG_CONTEXT_TOKEN_BUDGET, 6000, 1_000_000, 'token-budget', warnings),
    parentChild: parseBooleanSwitch(env.RAG_PARENT_CHILD, false, 'parent-child', warnings),
    iterativeScan: parseIterativeScan(env.RAG_HNSW_ITERATIVE_SCAN, warnings),
    exactScanCutoff: parseNonNegativeInt(env.RAG_EXACT_SCAN_CUTOFF, 0, 100_000, 'exact-scan-cutoff', warnings),
    lexicalTranslation: parseBooleanSwitch(env.RAG_LEXICAL_TRANSLATION, false, 'lexical-translation', warnings),
    paramsOverride: parseParamsOverride(env.RAG_RETRIEVAL_PARAMS_OVERRIDE, warnings),
    hasCohereKey: (env.COHERE_API_KEY ?? '').trim() !== '',
    hasVoyageKey: (env.VOYAGE_API_KEY ?? '').trim() !== '',
    domainEmbeddings: parseDomainEmbeddings(env, warnings),
  };

  applyV2DisabledStages(v2, disabledStages);

  const config: RagConfig = { pipeline, disabledStages, timeouts, exactIdLookup, v2, warnings };
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

export function resetRagConfigForTests(): void {
  loggedProblems.clear();
  memo.clear();
}