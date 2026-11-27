import crypto from 'node:crypto';
import type { AnswerNotice, AnswerSentence, OutputGuardSummary, RagTrace } from './contracts.generated';

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

type TraceResidualOutputFindings = NonNullable<RagTrace['residual_output_findings']>;

const RESIDUAL_RULE_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const FINISH_REASON = /^[a-z][a-z0-9_-]{0,31}$/;

/** The guard counts the trace may carry; the summary's in-memory targets and phrases are never read here. */
export interface GuardCounts {
  mode: OutputGuardSummary['mode'];
  rules_version: string;
  links_checked: number;
  links_removed: number;
  credential_blocked: number;
  credential_warned: number;
  rule_ids: readonly string[];
}

/** D-41 on the eval trace: counts, rule ids and attributed chunk ids only, never a removed target or matched phrase. */
export function outputGuardTraceSummary(summary: GuardCounts, sourceChunkIds: readonly string[] = []): OutputGuardSummary {
  return {
    mode: summary.mode,
    rules_version: summary.rules_version,
    links_checked: summary.links_checked,
    links_removed: summary.links_removed,
    credential_blocked: summary.credential_blocked,
    credential_warned: summary.credential_warned,
    rule_ids: [...summary.rule_ids],
    source_chunk_ids: [...sourceChunkIds],
  };
}

/** D-42: what a flag-mode guard pass still finds in the final answer, as counts and rule ids. */
export function residualOutputFindings(summary: GuardCounts): TraceResidualOutputFindings {
  return {
    links: summary.links_removed,
    credential_matches: summary.credential_blocked + summary.credential_warned,
    rule_ids: [...new Set(summary.rule_ids.filter((id) => RESIDUAL_RULE_ID.test(id)))],
  };
}

export interface AnswerRulesTraceInput {
  /** Any Phase 5.2 switch is on (AnswerConfig.anyNonDefault); false gives no field at all (D-62 a). */
  anyNonDefault: boolean;
  answerLanguage: string | null;
  /** The retrieval refused before generation (the server refusal). */
  refusedByServer: boolean;
  /** D-16: the model wrote the no-answer sentinel and the registry refusal replaced it. */
  refusedByModel: boolean;
  finishReason?: string | null;
  parts?: readonly string[];
  notices?: readonly AnswerNotice[];
  sentences?: readonly AnswerSentence[] | null;
  outputGuard?: OutputGuardSummary | null;
  residual?: TraceResidualOutputFindings | null;
  mixedVersions?: boolean | null;
}

export type AnswerRulesTraceFields = Pick<
  RagTrace,
  | 'answer_language'
  | 'sentences'
  | 'refusal_origin'
  | 'output_guard'
  | 'residual_output_findings'
  | 'mixed_versions'
  | 'finish_reason'
  | 'answer_rules_parts'
  | 'notices'
>;

/** The Phase 5.2 trace fields of one eval answer; each is present only when it carries something. */
export function answerRulesTraceFields(input: AnswerRulesTraceInput): Partial<AnswerRulesTraceFields> {
  if (!input.anyNonDefault) return {};
  const origin = input.refusedByModel ? 'model_relevance' : input.refusedByServer ? 'server' : null;
  return {
    ...(input.answerLanguage ? { answer_language: input.answerLanguage } : {}),
    ...(input.sentences ? { sentences: [...input.sentences] } : {}),
    ...(origin ? { refusal_origin: origin } : {}),
    ...(input.outputGuard ? { output_guard: input.outputGuard } : {}),
    ...(input.residual ? { residual_output_findings: input.residual } : {}),
    ...(typeof input.mixedVersions === 'boolean' ? { mixed_versions: input.mixedVersions } : {}),
    ...(input.finishReason ? { finish_reason: FINISH_REASON.test(input.finishReason) ? input.finishReason : 'other' } : {}),
    ...(input.parts && input.parts.length > 0 ? { answer_rules_parts: [...input.parts] } : {}),
    ...(input.notices && input.notices.length > 0 ? { notices: input.notices.map((notice) => ({ ...notice })) } : {}),
  };
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
