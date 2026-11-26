import { createHash } from 'node:crypto';
import type { RetrievalParams, TerminologyParams } from '@/lib/rag-eval/contracts.generated';
import type { IterativeScanMode, RerankerKind, RerankTier } from '../config';
import type { InjectionCheckMode, SecurityConfig, ToolResultGuardMode } from '../security/config';
import { detectorsConfigVersion } from '../security/detectors';
import { injectionRulesVersion } from '../security/injection-rules';
import { lakeraAllowed } from '../security/lakera';

export interface RetrievalConfigHashSwitches {
  lexicalSearch: boolean;
  refusalThreshold: boolean;
  edgeOrder: boolean;
  compression: boolean;
  tokenBudget: number;
  parentChild: boolean;
  iterativeScan: IterativeScanMode;
  exactScanCutoff: number;
  lexicalTranslation: boolean;
  exactIdLookup: boolean;
  rerankTierChat: RerankTier;
  rerankTierVoice: RerankTier;
  /** D-03: present only for a single-language deployment, so a multilingual hash is unchanged. */
  monolingual?: true;
}

/** The prompt-injection defense configuration a result was built under (D-18). */
export interface RetrievalConfigHashSecurity {
  contextTagging: boolean;
  injectionCheck: InjectionCheckMode;
  promptGuard: boolean;
  lakera: boolean;
  lakeraMultiTenantAck: boolean;
  /** Whether a Lakera request may actually be sent (lakeraAllowed); a boolean, never the key. */
  lakeraEffective: boolean;
  toolResultGuard: ToolResultGuardMode;
  rulesVersion: string;
  detectorsVersion: string;
}

/**
 * Null while every 5.1 switch is at its default, so the hash equals its pre-5.1 value; otherwise the switches,
 * Lakera's effective state for this deployment mode, and the rules and detector config versions.
 */
export function securityHashComponent(
  security: SecurityConfig,
  options: { multiTenant: boolean; rulesVersion?: string; detectorsVersion?: string },
): RetrievalConfigHashSecurity | null {
  if (!security.anyNonDefault) return null;
  const lakeraEffective = lakeraAllowed({
    injectionCheck: security.injectionCheck,
    lakera: security.lakera,
    multiTenant: options.multiTenant,
    ack: security.lakeraMultiTenantAck,
    apiKeyPresent: security.lakeraApiKey !== null,
  }).allowed;
  return {
    contextTagging: security.contextTagging,
    injectionCheck: security.injectionCheck,
    promptGuard: security.promptGuard,
    lakera: security.lakera,
    lakeraMultiTenantAck: security.lakeraMultiTenantAck,
    lakeraEffective,
    toolResultGuard: security.toolResultGuard,
    rulesVersion: options.rulesVersion ?? injectionRulesVersion(),
    detectorsVersion: options.detectorsVersion ?? detectorsConfigVersion(),
  };
}

/** The query layer's setup (D-04, research A-7); present only while the layer is on, so a Phase 4 hash is unchanged. */
export interface RetrievalConfigHashQueryLayer {
  framework: string;
  model: string;
  /** SHA-256 over the canonical effective query params. */
  queryParamsHash: string;
  /** Prompt file id to version. */
  prompts: Record<string, number>;
  transforms: Record<string, boolean>;
}

/** D-21: the dictionary a request was retrieved with; present only while the terminology stage is enabled for the request. */
export interface RetrievalConfigHashTerminology {
  /** The effective version (s<n> or s<n>.w<m>) when the stage ended ok; TERMINOLOGY_UNAVAILABLE when it was skipped. */
  version: string;
  /** SHA-256 over the canonical TerminologyParams, config_hash and provenance left out. */
  params_sha256: string;
  dense: boolean;
}

/** The terminology stage as the hash sees it: disabled for the request, or enabled with the version it ended with (null: skipped). */
export type TerminologyHashStage = { enabled: false } | { enabled: true; version: string | null };

export const TERMINOLOGY_UNAVAILABLE = 'terminology:unavailable';

export interface RetrievalConfigHashInput {
  backendId: string;
  embeddingProfileId: string;
  lexicalVersion: number;
  rerankTextVersion: number;
  params: RetrievalParams;
  reranker: { id: RerankerKind; model: string };
  thresholdsConfigHash: string | null;
  activeChunkingProfiles: Record<string, string> | null;
  switches: RetrievalConfigHashSwitches;
  /** Present only when a 5.1 switch is not at its default (securityHashComponent). */
  security?: RetrievalConfigHashSecurity | null;
  /** Doc type to binding profile id of the legs planned for the request; omitted (or empty) when none is planned. */
  embeddingBindings?: Record<string, string> | null;
  /** Eval only: the doc type of the control leg. */
  domainControlLeg?: string | null;
  /** D-44: the effective date passed to retrieval; absent or null while RAG_EFFECTIVE_DATES is off. */
  effectiveOn?: string | null;
  /** Present only while the query layer is on. */
  queryLayer?: RetrievalConfigHashQueryLayer | null;
  /** XLG-04: present only when translation legs run for the request (RAG_DOC_TRANSLATION on and the tenant has translations). */
  docTranslation?: { switch: 'on'; languages: string[]; weight: number } | null;
  /** D-21: present only while the terminology stage is enabled for the request (terminologyHashBlock). */
  terminology?: RetrievalConfigHashTerminology | null;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function paramsForHash(params: RetrievalParams): Record<string, unknown> {
  const { config_hash: _hash, provenance: _prov, ...rest } = params;
  return rest as Record<string, unknown>;
}

/**
 * D-21: the only builder of the terminology block. Undefined when the stage is disabled for the request (switch off, or
 * terminology among the config's or the eval request's disabled stages), so the hash equals the pre-terminology value.
 */
export function terminologyHashBlock(
  stage: TerminologyHashStage,
  params: TerminologyParams,
  dense: boolean,
): RetrievalConfigHashTerminology | undefined {
  if (!stage.enabled) return undefined;
  const { config_hash: _hash, provenance: _prov, ...rest } = params;
  return {
    version: stage.version ?? TERMINOLOGY_UNAVAILABLE,
    params_sha256: createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex'),
    dense,
  };
}

function chunkingForHash(profiles: Record<string, string> | null): unknown {
  if (profiles === null) return 'chunking:unavailable';
  return profiles;
}

function buildPayload(input: RetrievalConfigHashInput): Record<string, unknown> {
  return {
    active_chunking_profiles: chunkingForHash(input.activeChunkingProfiles),
    backend_id: input.backendId,
    embedding_profile_id: input.embeddingProfileId,
    lexical_version: input.lexicalVersion,
    params: paramsForHash(input.params),
    rerank_text_version: input.rerankTextVersion,
    reranker: input.reranker,
    switches: input.switches,
    thresholds_config_hash: input.switches.refusalThreshold ? input.thresholdsConfigHash : null,
    ...(input.security ? { security: input.security } : {}),
    ...(input.embeddingBindings && Object.keys(input.embeddingBindings).length > 0 ? { embedding_bindings: input.embeddingBindings } : {}),
    ...(input.domainControlLeg ? { domain_control_leg: input.domainControlLeg } : {}),
    ...(input.effectiveOn ? { effective_on: input.effectiveOn } : {}),
    ...(input.queryLayer ? { query_layer: input.queryLayer } : {}),
    ...(input.docTranslation ? { doc_translation: input.docTranslation } : {}),
    ...(input.terminology ? { terminology: input.terminology } : {}),
  };
}

export function computeRetrievalConfigHash(input: RetrievalConfigHashInput): string {
  const payload = buildPayload(input);
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}