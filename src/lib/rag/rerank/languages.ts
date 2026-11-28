import { getLanguageRegistry } from '../lang/registry';
import type { RerankProviderId } from './types';

export const RERANK_PROVIDER_IDS: readonly RerankProviderId[] = ['cohere', 'voyage', 'local_bm25'];

let overrides: Partial<Record<RerankProviderId, readonly string[]>> = {};

/**
 * D-07 language declarations. The hosted rerankers declare the packs they are evaluated on (packs with golden
 * slices); local_bm25 declares every pack with a segmentation method. Registry order, read from the registry.
 */
export function rerankerSupportedLanguages(id: RerankProviderId): readonly string[] {
  const override = overrides[id];
  if (override) return override;
  const packs = getLanguageRegistry().packs;
  if (id === 'local_bm25') return packs.filter((pack) => pack.segmentation !== null).map((pack) => pack.code);
  return packs.filter((pack) => pack.fixtures.golden_slices).map((pack) => pack.code);
}

/** The RAG_RERANKER value as loadRagConfig reads it; null for none or an unsupported value. */
export function parseRerankProviderId(raw: string | undefined): RerankProviderId | null {
  const value = (raw ?? '').trim().toLowerCase();
  return RERANK_PROVIDER_IDS.find((id) => id === value) ?? null;
}

export function setRerankerLanguagesForTests(id: RerankProviderId, languages: readonly string[]): void {
  overrides = { ...overrides, [id]: [...languages] };
}

export function resetRerankerLanguagesForTests(): void {
  overrides = {};
}
