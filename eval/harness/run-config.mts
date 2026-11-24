import fs from 'node:fs';
import { RetrievalOverridesSchema, type RetrievalOverrides } from '../../src/lib/rag-eval/contracts.generated.ts';

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
}

/** RAG_PIPELINE plus the Phase 4 D-23 switch names. Keys, base URLs and every other variable stay out of reach of a run config. */
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
];

export const RUN_CONFIG_REJECT_MESSAGE = '[Eval Harness] run-config may only set RAG_PIPELINE and Phase 4 RAG_* switches';

const TOP_LEVEL_KEYS = new Set(['name', 'env', 'overrides']);
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PIPELINE_VALUES = new Set(['legacy', 'v2']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRunConfig(raw: unknown, source: string): RunConfig {
  if (!isPlainObject(raw)) throw new RunConfigError(`[Eval Harness] run-config ${source} must be a JSON object`);
  const unknownKeys = Object.keys(raw).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new RunConfigError(`[Eval Harness] run-config ${source} has unknown field(s): ${unknownKeys.join(', ')}`);
  }

  const { name, env: rawEnv = {}, overrides: rawOverrides = null } = raw;
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

  let overrides: RetrievalOverrides | null = null;
  if (rawOverrides !== null) {
    const checked = RetrievalOverridesSchema.safeParse(rawOverrides);
    if (!checked.success) {
      const detail = checked.error.issues.map((issue) => `${issue.path.join('.') || 'overrides'}: ${issue.message}`).join('; ');
      throw new RunConfigError(`[Eval Harness] run-config overrides are invalid: ${detail}`);
    }
    overrides = checked.data;
  }

  return { name, env, overrides };
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
