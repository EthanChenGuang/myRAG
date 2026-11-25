export interface EmbeddingModelEntry {
  readonly provider: string;
  readonly model: string;
}

export const EMBEDDING_MODEL_CATALOG: readonly EmbeddingModelEntry[] = Object.freeze([]);

export function catalogEntry(_provider: string, _model: string): EmbeddingModelEntry | undefined {
  return undefined;
}

export function defaultModelFor(_provider: string): string | undefined {
  return undefined;
}
