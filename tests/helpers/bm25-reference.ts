export interface Bm25Stats {
  N: number;
  avgdl: number;
  df: Map<string, number> | Record<string, number>;
}

export interface Bm25ReferenceInput {
  docs: readonly (readonly string[])[];
  query: readonly string[];
  k1: number;
  b: number;
  stats?: Bm25Stats;
}

export function bm25Reference(input: Bm25ReferenceInput): number[] {
  return input.docs.map(() => -1);
}
