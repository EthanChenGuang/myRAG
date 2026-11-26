import { env } from '@/lib/env';
import type { EmbeddingProvider, FinetuneSlotProviderId } from './types';
import { FT_SLOT_SUPPORTED_DIMS } from './types';

export type FinetuneSlot = 'a' | 'b';

const MAX_INPUT_TOKENS = 8192;

export const FINETUNE_PROBE_MIN_COSINE = 0.999;
export const FINETUNE_PROBE_ROLES: readonly ('query' | 'document')[] = ['query', 'document', 'query'];

export interface FinetuneSlotConfig {
  baseUrl: string;
  model: string;
  queryPrompt: string;
  documentPrompt: string;
  apiKey: string;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

export interface FinetuneSlotProviderOptions {
  config?: () => FinetuneSlotConfig;
}

export interface FinetuneProbeResult {
  ok: boolean;
  minCosine: number | null;
  reason: string;
}

export async function checkFinetuneProbe(_slot: FinetuneSlot, _options: FinetuneSlotProviderOptions = {}): Promise<FinetuneProbeResult> {
  return { ok: false, minCosine: null, reason: 'not_implemented' };
}

export function resetFinetuneProbeCacheForTests(): void {}

function slotModel(slot: FinetuneSlot): string {
  return (slot === 'a' ? env.RAG_FT_SLOT_A_MODEL : env.RAG_FT_SLOT_B_MODEL).trim();
}

export function createFinetuneSlotProvider(slot: FinetuneSlot, _options: FinetuneSlotProviderOptions = {}): EmbeddingProvider {
  const id: FinetuneSlotProviderId = slot === 'a' ? 'ft_slot_a' : 'ft_slot_b';
  const notReady = () => Promise.reject(new Error('[Embedding Profile] fine-tune slot provider not implemented'));
  return {
    id,
    get model() {
      return slotModel(slot);
    },
    maxInputTokens: MAX_INPUT_TOKENS,
    supportedDims: FT_SLOT_SUPPORTED_DIMS,
    normalize: true,
    embedDocuments: notReady,
    embedQuery: notReady,
    embedQueries: notReady,
  };
}
