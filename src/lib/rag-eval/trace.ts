import crypto from 'node:crypto';
import type { RagTrace } from './contracts.generated';

export const ENDPOINT_VERSION = 'rag-eval/1';

const PROMPT_VARIABLES = ['RAG_SYSTEM_PROMPT', 'RAG_PRE_CONTEXT', 'RAG_POST_CONTEXT'] as const;
const SENSITIVE_NAME = /SECRET|KEY|TOKEN|PASSWORD|PASSWD|PWD|CRED|AUTH|DSN|PRIVATE|COOKIE|SESSION/;
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i;
const ACCESS_PREFIXES = ['RAG_EVAL_', 'RAG_SIDECAR_'] as const;

export interface EffectiveConfig {
  deployment_mode: string;
  embedding_model: string;
  endpoint_version: string;
  generator_model: string | null;
  rag_env: Record<string, string>;
  rag_prompt_sha256: Record<string, string>;
  /** Present only while RAG_INJECTION_CHECK is not off (D-18). */
  security?: { rules_version: string; detectors_version: string };
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export interface EffectiveConfigOptions {
  /** injectionTraceVersions() from @/lib/rag: rules_version and detectors_version while the check is on, else null. */
  security?: { rules_version: string; detectors_version: string } | null;
}

export function buildEffectiveConfig(options: EffectiveConfigOptions = {}): EffectiveConfig {
  const ragEnv: Record<string, string> = {};
  for (const name of Object.keys(process.env).sort()) {
    if (!name.startsWith('RAG_') && !name.startsWith('NEXT_PUBLIC_RAG_')) continue;
    if (SENSITIVE_NAME.test(name)) continue;
    if (ACCESS_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if ((PROMPT_VARIABLES as readonly string[]).includes(name)) continue;
    const value = process.env[name];
    if (value === undefined) continue;
    if (URL_WITH_CREDENTIALS.test(value.trim())) continue;
    ragEnv[name] = value;
  }

  const promptDigests: Record<string, string> = {};
  for (const name of PROMPT_VARIABLES) {
    promptDigests[name] = sha256Hex(process.env[name] ?? '');
  }

  const security = options.security ? { security: { rules_version: options.security.rules_version, detectors_version: options.security.detectors_version } } : {};

  return {
    ...security,
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

type TraceBackend = NonNullable<RagTrace['retrieval_backend']>;

const TRACE_BACKENDS: ReadonlySet<string> = new Set<TraceBackend['backend']>(['pgvector', 'weaviate', 'qdrant']);
const TRACE_FALLBACKS: ReadonlySet<string> = new Set<NonNullable<TraceBackend['fallback_reason']>>([
  'backend_not_ready',
  'backend_error',
  'backend_slow',
  'filter_unsupported',
]);

interface StageAttributesLike {
  name: string;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * D-25: RagTrace.retrieval_backend from the search span (the last search record wins, as with the identifier rerun). Absent when no
 * search stage recorded a backend, so a trace without a v2 search keeps its shape.
 */
export function retrievalBackendTrace(stages: readonly StageAttributesLike[]): TraceBackend | undefined {
  const search = [...stages].reverse().find((stage) => stage.name === 'search' && typeof stage.attributes?.backend === 'string');
  const attributes = search?.attributes;
  if (!attributes || !TRACE_BACKENDS.has(String(attributes.backend))) return undefined;
  const reason = attributes.fallback_reason;
  const dropped = attributes.tenant_validation_dropped;
  return {
    backend: attributes.backend as TraceBackend['backend'],
    fallback_reason: typeof reason === 'string' && TRACE_FALLBACKS.has(reason) ? (reason as TraceBackend['fallback_reason']) : null,
    tenant_validation_dropped: typeof dropped === 'number' && Number.isInteger(dropped) && dropped >= 0 ? dropped : 0,
  };
}
