import { env } from '@/lib/env';
import type { EmbeddingProvider, FinetuneSlotProviderId } from './types';
import { FT_SLOT_SUPPORTED_DIMS } from './types';

export type FinetuneSlot = 'a' | 'b';

const MAX_INPUT_TOKENS = 8192;

function slotModel(slot: FinetuneSlot): string {
  return (slot === 'a' ? env.RAG_FT_SLOT_A_MODEL : env.RAG_FT_SLOT_B_MODEL).trim();
}

export function createFinetuneSlotProvider(slot: FinetuneSlot): EmbeddingProvider {
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
