import { createOpenAiProvider } from './openai-provider';
import type { EmbeddingProvider, EmbeddingProviderId, ProfileShape, ProfileShapeResult } from './types';
import { canonicalModelId } from './types';

export { canonicalModelId };

let overrides: Partial<Record<EmbeddingProviderId, EmbeddingProvider>> = {};

export function getEmbeddingProvider(id: string): EmbeddingProvider {
  void id;
  return overrides.openai ?? createOpenAiProvider();
}

export function validateProfileShape(shape: ProfileShape): ProfileShapeResult {
  void shape;
  return { ok: true };
}

export function setEmbeddingProvidersForTests(partial: Partial<Record<EmbeddingProviderId, EmbeddingProvider>>): void {
  overrides = { ...overrides, ...partial };
}

export function resetEmbeddingProvidersForTests(): void {
  overrides = {};
}
