import crypto from 'node:crypto';

export const ENDPOINT_VERSION = 'rag-eval/1';

const PROMPT_VARIABLES = ['RAG_SYSTEM_PROMPT', 'RAG_PRE_CONTEXT', 'RAG_POST_CONTEXT'] as const;
const SENSITIVE_NAME = /SECRET|KEY|TOKEN|PASSWORD/;
const ACCESS_PREFIXES = ['RAG_EVAL_', 'RAG_SIDECAR_'] as const;

export interface EffectiveConfig {
  deployment_mode: string;
  embedding_model: string;
  endpoint_version: string;
  generator_model: string | null;
  rag_env: Record<string, string>;
  rag_prompt_sha256: Record<string, string>;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildEffectiveConfig(): EffectiveConfig {
  const ragEnv: Record<string, string> = {};
  for (const name of Object.keys(process.env).sort()) {
    if (!name.startsWith('RAG_') && !name.startsWith('NEXT_PUBLIC_RAG_')) continue;
    if (SENSITIVE_NAME.test(name)) continue;
    if (ACCESS_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if ((PROMPT_VARIABLES as readonly string[]).includes(name)) continue;
    const value = process.env[name];
    if (value === undefined) continue;
    ragEnv[name] = value;
  }

  const promptDigests: Record<string, string> = {};
  for (const name of PROMPT_VARIABLES) {
    promptDigests[name] = sha256Hex(process.env[name] ?? '');
  }

  return {
    deployment_mode: process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE || 'single-tenant',
    embedding_model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    endpoint_version: ENDPOINT_VERSION,
    generator_model: null,
    rag_env: ragEnv,
    rag_prompt_sha256: promptDigests,
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function configHash(config: unknown): string {
  return sha256Hex(canonicalJson(config));
}
