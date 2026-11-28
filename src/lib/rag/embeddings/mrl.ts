export type EmbeddingMismatchKind = 'dims' | 'zero_norm' | 'model' | 'probe';

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

/**
 * Matryoshka truncation: keep the first `dims` components and rescale them to unit length.
 */
export function truncateAndNormalize(vector: number[], dims: number): number[] {
  if (vector.length < dims) throw new EmbeddingProfileMismatch('dims', vector.length, dims);
  const head = vector.slice(0, dims);
  let sumSquares = 0;
  for (const x of head) sumSquares += x * x;
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingProfileMismatch('zero_norm', 0, dims);
  return head.map((x) => x / norm);
}
