import { createHash } from 'node:crypto';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';
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

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function paramsForHash(params: RetrievalParams): Record<string, unknown> {
  const { config_hash: _hash, provenance: _prov, ...rest } = params;
  return rest as Record<string, unknown>;
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
  };
}

export function computeRetrievalConfigHash(input: RetrievalConfigHashInput): string {
  const payload = buildPayload(input);
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}