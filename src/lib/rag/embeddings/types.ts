export type EmbeddingProviderId = 'openai' | 'voyage' | 'qwen3';

export type EmbeddingStorage = 'legacy_column' | 'halfvec';

export interface EmbedOptions {
  dims: number;
  signal: AbortSignal;
}

export interface EmbedOutput {
  vectors: number[][];
  model: string;
  host: string;
  usage: { tokens: number };
}

export interface EmbeddingProvider {
  id: EmbeddingProviderId;
  readonly model: string;
  maxInputTokens: number;
  supportedDims: readonly number[];
  normalize: boolean;
  embedDocuments(texts: string[], opts: EmbedOptions): Promise<EmbedOutput>;
  embedQuery(text: string, opts: EmbedOptions): Promise<EmbedOutput>;
}

export interface ProfileShape {
  provider: string;
  dims: number;
  storage: string;
}

export type ProfileShapeFailure =
  | 'provider_unknown'
  | 'storage_unknown'
  | 'dims_invalid'
  | 'dims_above_limit'
  | 'legacy_column_dims'
  | 'dims_unsupported';

export type ProfileShapeResult = { ok: true } | { ok: false; reason: ProfileShapeFailure; detail: string };

export function canonicalModelId(model: string): string {
  return model;
}
