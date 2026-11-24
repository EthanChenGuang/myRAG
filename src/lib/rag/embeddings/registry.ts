import { createOpenAiProvider } from './openai-provider';
import { createQwenProvider } from './qwen';
import type {
  EmbeddingProvider,
  EmbeddingProviderId,
  ProfileShape,
  ProfileShapeFailure,
  ProfileShapeResult,
} from './types';
import { OPENAI_NATIVE_DIMS, QWEN_SUPPORTED_DIMS, VOYAGE_SUPPORTED_DIMS, canonicalModelId } from './types';
import { createVoyageProvider } from './voyage';

export { canonicalModelId };

const MAX_HALFVEC_DIMS = 4000;
const MAX_VECTOR_DIMS = 2000;
const STORAGES: readonly string[] = ['legacy_column', 'halfvec'];
const KNOWN_DIMS: Record<EmbeddingProviderId, readonly number[]> = {
  openai: [OPENAI_NATIVE_DIMS],
  voyage: VOYAGE_SUPPORTED_DIMS,
  qwen3: QWEN_SUPPORTED_DIMS,
};

const KNOWN_LIMITS: Record<EmbeddingProviderId, { maxInputTokens: number }> = {
  openai: { maxInputTokens: 8191 },
  voyage: { maxInputTokens: 32000 },
  qwen3: { maxInputTokens: 32768 },
};

let defaults: Partial<Record<EmbeddingProviderId, EmbeddingProvider>> | null = null;
let overrides: Partial<Record<EmbeddingProviderId, EmbeddingProvider>> = {};

function defaultProviders(): Partial<Record<EmbeddingProviderId, EmbeddingProvider>> {
  if (!defaults) defaults = { openai: createOpenAiProvider(), voyage: createVoyageProvider(), qwen3: createQwenProvider() };
  return defaults;
}

function findProvider(id: string): EmbeddingProvider | undefined {
  const table = { ...defaultProviders(), ...overrides } as Record<string, EmbeddingProvider | undefined>;
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : undefined;
}

export function getEmbeddingProvider(id: string): EmbeddingProvider {
  const provider = findProvider(id);
  if (!provider) throw new Error(`[Embedding Profile] unknown embedding provider "${id}"`);
  return provider;
}

function supportedDimsFor(id: string): readonly number[] | undefined {
  const registered = findProvider(id);
  if (registered) return registered.supportedDims;
  return Object.prototype.hasOwnProperty.call(KNOWN_DIMS, id) ? KNOWN_DIMS[id as EmbeddingProviderId] : undefined;
}

/** The provider's documented input limit in tokens; throws for an id that is not a registered provider. */
export function maxInputTokensFor(providerId: string): number {
  const registered = findProvider(providerId);
  if (registered) return registered.maxInputTokens;
  if (Object.prototype.hasOwnProperty.call(KNOWN_LIMITS, providerId)) return KNOWN_LIMITS[providerId as EmbeddingProviderId].maxInputTokens;
  throw new Error(`[Embedding Profile] unknown provider ${providerId}`);
}

function reject(reason: ProfileShapeFailure, detail: string): ProfileShapeResult {
  return { ok: false, reason, detail };
}

/**
 * Registry rules for a profile row: dims the provider supports, halfvec HNSW stops at 4000 and the
 * legacy vector column at 2000.
 */
export function validateProfileShape(shape: ProfileShape): ProfileShapeResult {
  const supported = supportedDimsFor(shape.provider);
  if (!supported) return reject('provider_unknown', `unknown provider ${shape.provider}`);
  if (!STORAGES.includes(shape.storage)) return reject('storage_unknown', `unknown storage ${shape.storage}`);
  if (!Number.isInteger(shape.dims) || shape.dims < 1) return reject('dims_invalid', `dims ${shape.dims} is not a positive integer`);
  if (shape.dims > MAX_HALFVEC_DIMS) return reject('dims_above_limit', `dims ${shape.dims} exceeds ${MAX_HALFVEC_DIMS}`);
  if (shape.storage === 'legacy_column' && shape.dims > MAX_VECTOR_DIMS) {
    return reject('legacy_column_dims', `legacy_column holds at most ${MAX_VECTOR_DIMS} dims, got ${shape.dims}`);
  }
  if (!supported.includes(shape.dims)) {
    return reject('dims_unsupported', `${shape.provider} does not support ${shape.dims} dims`);
  }
  return { ok: true };
}

export function setEmbeddingProvidersForTests(partial: Partial<Record<EmbeddingProviderId, EmbeddingProvider>>): void {
  overrides = { ...overrides, ...partial };
}

export function resetEmbeddingProvidersForTests(): void {
  overrides = {};
  defaults = null;
}
