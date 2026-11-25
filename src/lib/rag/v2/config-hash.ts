import { createHash } from 'node:crypto';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';
import type { IterativeScanMode, RerankerKind, RerankTier } from '../config';

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
  };
}

export function computeRetrievalConfigHash(input: RetrievalConfigHashInput): string {
  const payload = buildPayload(input);
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}