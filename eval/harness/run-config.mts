import fs from 'node:fs';
import {
  ChunkingProfileSchema,
  RetrievalOverridesSchema,
  type ChunkingProfile,
  type RetrievalOverrides,
} from '../../src/lib/rag-eval/contracts.generated.ts';

export class RunConfigError extends Error {
  readonly names: readonly string[];

  constructor(message: string, names: readonly string[] = []) {
    super(message);
    this.name = 'RunConfigError';
    this.names = names;
  }
}

export interface RunConfig {
  name: string;
  env: Record<string, string>;
  overrides: RetrievalOverrides | null;
  /** Candidate chunking profiles the ingest-mode builder seeds as building before the first document (D-21); absent when the key is. */
  chunkingProfiles?: ChunkingProfile[];
}

/** The Phase 5.1 SEC switches (D-14) and the values each accepts; keys, acks, regions and endpoints are never among them. */
const SEC_SWITCH_VALUES: Readonly<Record<string, readonly string[]>> = {
  RAG_CONTEXT_TAGGING: ['true', 'false'],
  RAG_INJECTION_CHECK: ['off', 'flag', 'drop', 'downweight'],
  RAG_INJECTION_PROMPT_GUARD: ['true', 'false'],
  RAG_INJECTION_LAKERA: ['true', 'false'],
  RAG_TOOL_RESULT_GUARD: ['off', 'tag', 'tag_and_flag'],
};

/**
 * RAG_PIPELINE, the Phase 4 D-23 switch names and the five Phase 5.1 SEC switches. Keys, base URLs and every other variable stay
 * out of reach of a run config.
 */
export const RUN_CONFIG_ENV_ALLOWLIST: readonly string[] = [
  'RAG_PIPELINE',
  'RAG_LEXICAL_SEARCH',
  'RAG_RERANKER',
  'RAG_RERANK_TIER_CHAT',
  'RAG_RERANK_TIER_VOICE',
  'RAG_RERANK_VOYAGE_MODEL_BY_LANG',
  'RAG_REFUSAL_THRESHOLD',
  'RAG_CONTEXT_EDGE_ORDER',
  'RAG_CONTEXT_COMPRESSION',
  'RAG_CONTEXT_TOKEN_BUDGET',
  'RAG_PARENT_CHILD',
  'RAG_HNSW_ITERATIVE_SCAN',
  'RAG_EXACT_SCAN_CUTOFF',
  'RAG_LEXICAL_TRANSLATION',
  ...Object.keys(SEC_SWITCH_VALUES),
];

export const RUN_CONFIG_REJECT_MESSAGE = '[Eval Harness] run-config may only set RAG_PIPELINE, Phase 4 RAG_* switches and the Phase 5.1 SEC switches';

const TOP_LEVEL_KEYS = new Set(['name', 'env', 'overrides', 'chunking_profiles']);
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PIPELINE_VALUES = new Set(['legacy', 'v2']);
const DOC_TYPES = new Set<string>(ChunkingProfileSchema.shape.doc_type.options);
const LEGACY_CHUNKING_PROFILE = 'legacy';

export const CHUNKING_PROFILES_NEED_V2 = '[Eval Harness] chunking_profiles needs RAG_PIPELINE=v2';
export const CHUNKING_PROFILES_NEED_INGEST = '[Eval Harness] chunking_profiles needs --fixture-mode ingest';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRunConfig(raw: unknown, source: string): RunConfig {
  if (!isPlainObject(raw)) throw new RunConfigError(`[Eval Harness] run-config ${source} must be a JSON object`);
  const unknownKeys = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new RunConfigError(`[Eval Harness] run-config ${source} has unknown field(s): ${unknownKeys.join(', ')}`);
  }

  const { name, env: rawEnv = {}, overrides: rawOverrides = null, chunking_profiles: rawProfiles } = raw;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new RunConfigError(`[Eval Harness] run-config ${source} needs a name of lowercase letters, digits, dot, dash or underscore`);
  }
  if (!isPlainObject(rawEnv)) throw new RunConfigError(`[Eval Harness] run-config ${source} env must be an object`);

  const disallowed = Object.keys(rawEnv).filter((key) => !RUN_CONFIG_ENV_ALLOWLIST.includes(key));
  if (disallowed.length > 0) throw new RunConfigError(RUN_CONFIG_REJECT_MESSAGE, disallowed);

  const env: Record<string, string> = {};
  for (const key of Object.keys(rawEnv).sort()) {
    const value = rawEnv[key];
    if (typeof value !== 'string') throw new RunConfigError(`[Eval Harness] run-config ${source} env ${key} must be a string`);
    env[key] = value;
  }
  if (env.RAG_PIPELINE !== undefined && !PIPELINE_VALUES.has(env.RAG_PIPELINE)) {
    throw new RunConfigError(`[Eval Harness] run-config ${source} RAG_PIPELINE must be legacy or v2`);
  }
  for (const [name, allowed] of Object.entries(SEC_SWITCH_VALUES)) {
    // A malformed SEC value would silently fall back to off in the app; the run config fails instead (the value is never echoed).
    if (env[name] !== undefined && !allowed.includes(env[name])) {
      throw new RunConfigError(`[Eval Harness] run-config ${source} ${name} must be one of ${allowed.join(', ')}`);
    }
  }

  let overrides: RetrievalOverrides | null = null;
  if (rawOverrides !== null) {
    const checked = RetrievalOverridesSchema.safeParse(rawOverrides);
    if (!checked.success) {
      const detail = checked.error.issues.map((issue) => `${issue.path.join('.') || 'overrides'}: ${issue.message}`).join('; ');
      throw new RunConfigError(`[Eval Harness] run-config overrides are invalid: ${detail}`);
    }
    overrides = checked.data;
  }

  const chunkingProfiles = rawProfiles === undefined ? undefined : parseChunkingProfiles(rawProfiles, source);
  if (chunkingProfiles && env.RAG_PIPELINE !== 'v2') throw new RunConfigError(CHUNKING_PROFILES_NEED_V2);
  checkChunkingOverride(overrides, chunkingProfiles);

  return { name, env, overrides, ...(chunkingProfiles ? { chunkingProfiles } : {}) };
}

/**
 * The schema and the context-free hard rules of ChunkingProfile (parent_tokens required for fixed, parent at least twice the child).
 * The embedding-input limit needs the active embedding profile, so the ingest-mode builder checks it before the first document.
 */
function parseChunkingProfiles(raw: unknown, source: string): ChunkingProfile[] {
  const prefix = `[Eval Harness] run-config chunking_profiles`;
  if (!Array.isArray(raw) || raw.length === 0) throw new RunConfigError(`${prefix} in ${source} must be a non-empty list`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const checked = ChunkingProfileSchema.safeParse(entry);
    if (!checked.success) {
      const detail = checked.error.issues.map((issue) => `${issue.path.join('.') || 'entry'}: ${issue.message}`).join('; ');
      throw new RunConfigError(`${prefix}[${index}] is invalid: ${detail}`);
    }
    const profile = checked.data;
    if (profile.id === LEGACY_CHUNKING_PROFILE) throw new RunConfigError(`${prefix}[${index}] may not reuse the legacy profile id`);
    if (profile.status !== 'building') throw new RunConfigError(`${prefix}[${index}] must have status building (it is seeded before ingestion)`);
    if (profile.parent_mode === 'fixed' && profile.parent_tokens === null) {
      throw new RunConfigError(`${prefix}[${index}] is invalid: parent_tokens_required`);
    }
    if (profile.parent_tokens !== null && profile.parent_tokens < profile.child_tokens * 2) {
      throw new RunConfigError(`${prefix}[${index}] is invalid: parent_below_twice_child`);
    }
    if (seen.has(profile.id)) throw new RunConfigError(`${prefix}[${index}] repeats id ${profile.id}`);
    seen.add(profile.id);
    return profile;
  });
}

function checkChunkingOverride(overrides: RetrievalOverrides | null, profiles: ChunkingProfile[] | undefined): void {
  const map = overrides?.chunking_profile_by_doc_type;
  if (!map) return;
  const prefix = '[Eval Harness] run-config overrides.chunking_profile_by_doc_type';
  for (const [docType, profileId] of Object.entries(map)) {
    if (!DOC_TYPES.has(docType)) throw new RunConfigError(`${prefix} names unknown doc type ${docType}`);
    if (!profiles || profileId === LEGACY_CHUNKING_PROFILE) continue;
    if (!profiles.some((profile) => profile.id === profileId && profile.doc_type === docType)) {
      throw new RunConfigError(`${prefix} ${docType}: ${profileId} is not a seeded ${docType} profile`);
    }
  }
}

export function loadRunConfig(file: string): RunConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new RunConfigError(`[Eval Harness] run-config file not found or unreadable: ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RunConfigError(`[Eval Harness] run-config file is not valid JSON: ${file}`);
  }
  return parseRunConfig(raw, file);
}
