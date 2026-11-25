export interface SampleCandidate {
  sourceKey: string;
  ext: string;
  size: number;
}

export type SizeBucket = 'small' | 'medium' | 'large';

export const SAMPLE_INITIAL_SHARE = 0.01;
export const SAMPLE_MAX_SHARE = 0.05;
export const SAMPLE_MIN_PER_CLASS = 20;

export interface SampleSelection<T extends SampleCandidate> {
  entries: T[];
  initial: number;
  cap: number;
  added: number;
  byStratum: Record<string, { files: number; sampled: number }>;
}

export function sizeBucket(_size: number): SizeBucket {
  return 'small';
}

export function stratumOf(candidate: Pick<SampleCandidate, 'ext' | 'size'>): string {
  return `${candidate.ext}:${sizeBucket(candidate.size)}`;
}

export function selectSample<T extends SampleCandidate>(
  _inventory: readonly T[],
  _preflightClasses: ReadonlyMap<string, string | null>,
  _seed: string,
): SampleSelection<T> {
  return { entries: [], initial: 0, cap: 0, added: 0, byStratum: {} };
}
