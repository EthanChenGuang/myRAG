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

export const OPENAI_NATIVE_DIMS = 1536;
export const QWEN_NATIVE_DIMS = 4096;
export const VOYAGE_SUPPORTED_DIMS: readonly number[] = [256, 512, 1024, 2048];
export const QWEN_SUPPORTED_DIMS: readonly number[] = [256, 512, 1024, 1536, 2048, QWEN_NATIVE_DIMS];
export const VOYAGE_MODEL_ID = 'voyage-4-large';
export const QWEN_MODEL_ID = 'Qwen/Qwen3-Embedding-8B';

/**
 * Maps host-specific spellings of one model to a single id so a same-dimension model swap is detectable.
 */
export function canonicalModelId(model: string): string {
  const id = model.trim();
  const lower = id.toLowerCase();
  if (lower === QWEN_MODEL_ID.toLowerCase()) return QWEN_MODEL_ID;
  if (lower === VOYAGE_MODEL_ID || lower === `mongodb/${VOYAGE_MODEL_ID}`) return VOYAGE_MODEL_ID;
  return id;
}

/**
 * A failed vendor request. The message carries the host and the HTTP status only, never the vendor's
 * response text, because vendors echo parts of the key in their error bodies.
 */
export class EmbeddingProviderError extends Error {
  readonly host: string;
  readonly status: number | undefined;

  constructor(host: string, status: number | undefined) {
    super(`[Embedding Profile] ${host} request failed (${status === undefined ? 'no response' : `status ${status}`})`);
    this.name = 'EmbeddingProviderError';
    this.host = host;
    this.status = status;
  }
}

export function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

export function toProviderError(error: unknown, host: string, signal: AbortSignal): unknown {
  if (error instanceof EmbeddingProviderError) return error;
  if (isAbortError(error, signal)) return error;
  if (error instanceof Error && error.name === 'EmbeddingProfileMismatch') return error;
  return new EmbeddingProviderError(host, statusOf(error));
}
