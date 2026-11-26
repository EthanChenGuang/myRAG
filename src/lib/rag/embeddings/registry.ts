import { env } from '@/lib/env';
import { createBgeM3Provider } from './bge-m3';
import { createFinetuneSlotProvider } from './finetune-slot';
import { createOpenAiProvider } from './openai-provider';
import { createQwenProvider } from './qwen';
import type {
  EmbeddingProvider,
  EmbeddingProviderId,
  ProfileShape,
  ProfileShapeFailure,
  ProfileShapeResult,
} from './types';
import { catalogEntry, defaultModelFor } from './catalog';
import type { EmbeddingModelEntry } from './catalog';
import { FT_SLOT_SUPPORTED_DIMS, canonicalModelId, isFinetuneSlotProvider } from './types';
import { createVoyageProvider } from './voyage';

export { canonicalModelId };

const MAX_HALFVEC_DIMS = 4000;
const MAX_VECTOR_DIMS = 2000;
const STORAGES: readonly string[] = ['legacy_column', 'halfvec'];
const PROVIDER_IDS: readonly EmbeddingProviderId[] = ['openai', 'voyage', 'qwen3', 'bge-m3', 'ft_slot_a', 'ft_slot_b'];

function isProviderId(id: string): id is EmbeddingProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

function defaultEntry(id: EmbeddingProviderId): EmbeddingModelEntry {
  const entry = catalogEntry(id, defaultModelFor(id) as string);
  if (!entry) throw new Error(`[Embedding Profile] no catalog entry for the default model of ${id}`);
  return entry;
}

/** Overrides are keyed by provider id (the Phase 3 form) or by `provider:model`. */
type OverrideKey = EmbeddingProviderId | `${EmbeddingProviderId}:${string}`;

let defaults: Partial<Record<EmbeddingProviderId, EmbeddingProvider>> | null = null;
let modelProviders = new Map<string, EmbeddingProvider>();
let overrides: Partial<Record<string, EmbeddingProvider>> = {};

/** The fine-tune slot providers exist only while RAG_FINETUNE is on (06.1 D-02). */
function defaultProviders(): Partial<Record<EmbeddingProviderId, EmbeddingProvider>> {
  if (!defaults) {
    defaults = {
      openai: createOpenAiProvider(),
      voyage: createVoyageProvider(),
      qwen3: createQwenProvider(),
      'bge-m3': createBgeM3Provider(),
    };
    if (env.RAG_FINETUNE === 'on') {
      defaults.ft_slot_a = createFinetuneSlotProvider('a');
      defaults.ft_slot_b = createFinetuneSlotProvider('b');
    }
  }
  return defaults;
}

function findProvider(id: string): EmbeddingProvider | undefined {
  if (!isProviderId(id)) return undefined;
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
  return defaultProviders()[id];
}

/** The provider's default model. Every Phase 3 caller and test fake resolves through this. */
export function getEmbeddingProvider(id: string): EmbeddingProvider {
  const provider = findProvider(id);
  if (!provider) throw new Error(`[Embedding Profile] unknown embedding provider "${id}"`);
  return provider;
}

function sameModel(a: string, b: string): boolean {
  return canonicalModelId(a) === canonicalModelId(b);
}

function createForModel(entry: EmbeddingModelEntry): EmbeddingProvider {
  switch (entry.provider) {
    case 'voyage':
      return createVoyageProvider({ model: entry.model });
    default:
      throw new Error(`[Embedding Profile] unknown embedding model for provider ${entry.provider}`);
  }
}

/**
 * The provider serving one model: a `provider:model` override, then a provider override or default
 * whose model matches, then a provider built from the catalog. A pair outside the catalog throws.
 * The provider slot (override or default) always answers for the provider's default model, so a
 * slot configured with another model is caught by the caller's model check, not replaced silently.
 */
export function getEmbeddingProviderFor(provider: string, model: string): EmbeddingProvider {
  const unknown = () => new Error(`[Embedding Profile] unknown embedding model for provider ${provider}`);
  if (!isProviderId(provider)) throw unknown();
  if (isFinetuneSlotProvider(provider)) {
    // A slot serves whichever version its env names; the caller's model check catches a version other than the profile's.
    const slot = overrides[`${provider}:${model.trim()}`] ?? findProvider(provider);
    if (!slot) throw unknown();
    return slot;
  }
  const entry = catalogEntry(provider, model);
  const canonical = entry ? entry.model : canonicalModelId(model);
  const keyed = overrides[`${provider}:${canonical}`];
  if (keyed) return keyed;
  const base = findProvider(provider);
  if (base && (sameModel(base.model, canonical) || sameModel(defaultModelFor(provider) as string, canonical))) return base;
  if (!entry) throw unknown();
  const cacheKey = `${provider}:${entry.model}`;
  let built = modelProviders.get(cacheKey);
  if (!built) {
    built = createForModel(entry);
    modelProviders.set(cacheKey, built);
  }
  return built;
}

function supportedDimsFor(id: string, model?: string): readonly number[] | undefined {
  if (!isProviderId(id)) return undefined;
  if (isFinetuneSlotProvider(id)) return FT_SLOT_SUPPORTED_DIMS;
  if (model !== undefined) {
    const registered = findProvider(id);
    if (registered && sameModel(registered.model, model)) return registered.supportedDims;
    return catalogEntry(id, model)?.supportedDims;
  }
  return findProvider(id)?.supportedDims ?? defaultEntry(id).supportedDims;
}

/** The provider's documented input limit in tokens; throws for an id that is not a registered provider. */
export function maxInputTokensFor(providerId: string): number {
  const registered = findProvider(providerId);
  if (registered) return registered.maxInputTokens;
  if (isProviderId(providerId)) return defaultEntry(providerId).maxInputTokens;
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
  if (!isProviderId(shape.provider)) return reject('provider_unknown', `unknown provider ${shape.provider}`);
  const supported = supportedDimsFor(shape.provider, shape.model);
  if (!supported) return reject('model_unknown', `${shape.provider} does not serve model ${shape.model}`);
  if (!STORAGES.includes(shape.storage)) return reject('storage_unknown', `unknown storage ${shape.storage}`);
  if (isFinetuneSlotProvider(shape.provider) && shape.storage !== 'halfvec') {
    return reject('storage_unknown', `${shape.provider} profiles use halfvec storage, got ${shape.storage}`);
  }
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

export function setEmbeddingProvidersForTests(partial: Partial<Record<OverrideKey, EmbeddingProvider>>): void {
  overrides = { ...overrides, ...partial };
}

export function resetEmbeddingProvidersForTests(): void {
  overrides = {};
  defaults = null;
  modelProviders = new Map();
}
