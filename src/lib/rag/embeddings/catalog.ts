import type { EmbeddingProviderId } from './types';
import {
  BGE_M3_MODEL_ID,
  BGE_M3_NATIVE_DIMS,
  OPENAI_NATIVE_DIMS,
  QWEN_MODEL_ID,
  QWEN_NATIVE_DIMS,
  QWEN_SUPPORTED_DIMS,
  VOYAGE_FINANCE_MODEL_ID,
  VOYAGE_LAW_MODEL_ID,
  VOYAGE_MODEL_ID,
  VOYAGE_SUPPORTED_DIMS,
  canonicalModelId,
} from './types';

export type EmbeddingServingMode = 'hosted' | 'sidecar';

export interface EmbeddingHostedEndpoint {
  readonly host: string;
  /** Name of the environment variable that holds the key; never the key itself. */
  readonly apiKeyEnv: string;
  readonly baseUrlEnv: string | null;
}

/**
 * Vendor facts for one embedding model. Values come from the vendor's documentation on `readOn`.
 * The catalog says which serving modes a model supports; the provider factory picks the one in use.
 */
export interface EmbeddingModelEntry {
  readonly provider: EmbeddingProviderId;
  readonly model: string;
  readonly nativeDims: number;
  readonly supportedDims: readonly number[];
  /** True when the vendor API accepts an output dimension for this model. */
  readonly sendsOutputDimension: boolean;
  readonly maxInputTokens: number;
  /** Null when the limit depends on the host. */
  readonly maxTokensPerRequest: number | null;
  /** input_type values the vendor API accepts; empty when the API has none. */
  readonly inputTypes: readonly string[];
  readonly usdPerMillionTokens: number;
  /** True when our cl100k_base count differs from the vendor's billed count. */
  readonly tokensAreEstimates: boolean;
  readonly freeTokensNote: string | null;
  /** Lower-case language codes the vendor documents for the model. */
  readonly supportedLanguages: readonly string[];
  readonly languagesNote: string;
  readonly servingModes: readonly EmbeddingServingMode[];
  readonly hostedEndpoint: EmbeddingHostedEndpoint | null;
  readonly sidecarPath: string | null;
  /** The vendor's own description of the model's specialty, for people only; no code reads it. */
  readonly vendorDomainNote: string | null;
  readonly readOn: string;
}

const OPENAI_HOSTED: EmbeddingHostedEndpoint = { host: 'api.openai.com', apiKeyEnv: 'OPENAI_API_KEY', baseUrlEnv: null };
const VOYAGE_HOSTED: EmbeddingHostedEndpoint = { host: 'api.voyageai.com', apiKeyEnv: 'VOYAGE_API_KEY', baseUrlEnv: 'VOYAGE_BASE_URL' };
const DEEPINFRA_HOSTED: EmbeddingHostedEndpoint = {
  host: 'api.deepinfra.com',
  apiKeyEnv: 'DEEPINFRA_API_KEY',
  baseUrlEnv: 'DEEPINFRA_BASE_URL',
};

const VOYAGE_INPUT_TYPES: readonly string[] = ['query', 'document'];

function freezeEntry(entry: EmbeddingModelEntry): EmbeddingModelEntry {
  Object.freeze(entry.supportedDims);
  Object.freeze(entry.inputTypes);
  Object.freeze(entry.supportedLanguages);
  Object.freeze(entry.servingModes);
  if (entry.hostedEndpoint) Object.freeze(entry.hostedEndpoint);
  return Object.freeze(entry);
}

/** Bumped whenever a model fact below changes; comparisons record it (D-23). */
export const EMBEDDING_CATALOG_VERSION = 1;

export const EMBEDDING_MODEL_CATALOG: readonly EmbeddingModelEntry[] = Object.freeze(
  [
    {
      provider: 'openai',
      model: 'text-embedding-3-small',
      nativeDims: OPENAI_NATIVE_DIMS,
      supportedDims: [OPENAI_NATIVE_DIMS],
      sendsOutputDimension: false,
      maxInputTokens: 8191,
      maxTokensPerRequest: 300_000,
      inputTypes: [],
      usdPerMillionTokens: 0.02,
      tokensAreEstimates: false,
      freeTokensNote: null,
      supportedLanguages: ['zh', 'en', 'it'],
      languagesNote: 'Multilingual; evaluated on the zh, en and it slices.',
      servingModes: ['hosted'],
      hostedEndpoint: OPENAI_HOSTED,
      sidecarPath: null,
      vendorDomainNote: 'General purpose.',
      readOn: '2026-11-24',
    },
    {
      provider: 'voyage',
      model: VOYAGE_MODEL_ID,
      nativeDims: 1024,
      supportedDims: [...VOYAGE_SUPPORTED_DIMS],
      sendsOutputDimension: true,
      maxInputTokens: 32_000,
      maxTokensPerRequest: 120_000,
      inputTypes: VOYAGE_INPUT_TYPES,
      usdPerMillionTokens: 0.12,
      tokensAreEstimates: true,
      freeTokensNote: 'First 200M tokens free per account.',
      supportedLanguages: ['zh', 'en', 'it'],
      languagesNote: 'Vendor markets it as multilingual; evaluated on the zh, en and it slices.',
      servingModes: ['hosted'],
      hostedEndpoint: VOYAGE_HOSTED,
      sidecarPath: null,
      vendorDomainNote: 'General purpose and multilingual.',
      readOn: '2026-11-24',
    },
    {
      provider: 'voyage',
      model: VOYAGE_LAW_MODEL_ID,
      nativeDims: 1024,
      supportedDims: [1024],
      sendsOutputDimension: false,
      maxInputTokens: 16_000,
      maxTokensPerRequest: 120_000,
      inputTypes: VOYAGE_INPUT_TYPES,
      usdPerMillionTokens: 0.12,
      tokensAreEstimates: true,
      freeTokensNote: 'First 50M tokens free per account.',
      supportedLanguages: ['en', 'zh', 'de'],
      languagesNote: 'Vendor evaluation sets cover English, Chinese and German; none covers Italian; not marketed as multilingual.',
      servingModes: ['hosted'],
      hostedEndpoint: VOYAGE_HOSTED,
      sidecarPath: null,
      vendorDomainNote: 'Vendor describes it as optimised for legal retrieval.',
      readOn: '2026-11-24',
    },
    {
      provider: 'voyage',
      model: VOYAGE_FINANCE_MODEL_ID,
      nativeDims: 1024,
      supportedDims: [1024],
      sendsOutputDimension: false,
      maxInputTokens: 32_000,
      maxTokensPerRequest: 120_000,
      inputTypes: VOYAGE_INPUT_TYPES,
      usdPerMillionTokens: 0.12,
      tokensAreEstimates: true,
      freeTokensNote: 'First 50M tokens free per account.',
      supportedLanguages: ['en'],
      languagesNote: 'Vendor evaluation sets are English only.',
      servingModes: ['hosted'],
      hostedEndpoint: VOYAGE_HOSTED,
      sidecarPath: null,
      vendorDomainNote: 'Vendor describes it as optimised for financial retrieval.',
      readOn: '2026-11-24',
    },
    {
      provider: 'qwen3',
      model: QWEN_MODEL_ID,
      nativeDims: QWEN_NATIVE_DIMS,
      supportedDims: [...QWEN_SUPPORTED_DIMS],
      sendsOutputDimension: false,
      maxInputTokens: 32_768,
      maxTokensPerRequest: null,
      inputTypes: [],
      usdPerMillionTokens: 0.01,
      tokensAreEstimates: true,
      freeTokensNote: null,
      supportedLanguages: ['zh', 'en', 'it'],
      languagesNote: 'Multilingual open-weights model; queries carry an instruction prefix instead of an input_type.',
      servingModes: ['hosted'],
      hostedEndpoint: DEEPINFRA_HOSTED,
      sidecarPath: null,
      vendorDomainNote: 'General purpose and multilingual.',
      readOn: '2026-11-24',
    },
    {
      provider: 'bge-m3',
      model: BGE_M3_MODEL_ID,
      nativeDims: BGE_M3_NATIVE_DIMS,
      supportedDims: [BGE_M3_NATIVE_DIMS],
      sendsOutputDimension: false,
      maxInputTokens: 8192,
      maxTokensPerRequest: null,
      inputTypes: [],
      usdPerMillionTokens: 0.01,
      tokensAreEstimates: true,
      freeTokensNote: null,
      supportedLanguages: ['zh', 'en', 'it'],
      languagesNote: 'Multilingual open-weights model (MIT licence); dense output only, no query instruction.',
      servingModes: ['hosted'],
      hostedEndpoint: DEEPINFRA_HOSTED,
      sidecarPath: null,
      vendorDomainNote: 'General purpose and multilingual.',
      readOn: '2026-11-26',
    },
  ].map((entry) => freezeEntry(entry as EmbeddingModelEntry)),
);

const DEFAULT_MODELS: Readonly<Record<EmbeddingProviderId, string>> = Object.freeze({
  openai: 'text-embedding-3-small',
  voyage: VOYAGE_MODEL_ID,
  qwen3: QWEN_MODEL_ID,
  'bge-m3': BGE_M3_MODEL_ID,
});

/** The catalog entry for a provider and model (host-specific spellings accepted); undefined when not listed. */
export function catalogEntry(provider: string, model: string): EmbeddingModelEntry | undefined {
  const canonical = canonicalModelId(model);
  return EMBEDDING_MODEL_CATALOG.find((entry) => entry.provider === provider && entry.model === canonical);
}

/** The model a provider serves when no model is named; undefined for an unknown provider. */
export function defaultModelFor(provider: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(DEFAULT_MODELS, provider) ? DEFAULT_MODELS[provider as EmbeddingProviderId] : undefined;
}
