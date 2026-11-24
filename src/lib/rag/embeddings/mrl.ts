export type EmbeddingMismatchKind = 'dims' | 'zero_norm' | 'model';

export class EmbeddingProfileMismatch extends Error {
  readonly kind: EmbeddingMismatchKind;
  readonly actual: number | string;
  readonly expected: number | string;

  constructor(kind: EmbeddingMismatchKind, actual: number | string, expected: number | string) {
    super(`embedding_profile_mismatch: ${kind} (actual ${actual}, expected ${expected})`);
    this.name = 'EmbeddingProfileMismatch';
    this.kind = kind;
    this.actual = actual;
    this.expected = expected;
  }
}

export function truncateAndNormalize(vector: number[], dims: number): number[] {
  return vector.slice(0, dims);
}
