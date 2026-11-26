import type { GoldenItem, RagRunRequest } from '../../src/lib/rag-eval/contracts.generated.ts';
import type { EvalRequestOptions } from './run-eval.mts';

export const CACHE_PAIRS_FILE = 'cache-pairs.json';

export interface CachePairSpec {
  pair: GoldenItem;
  anchor: GoldenItem;
}

export function cachePairSpecs(_items: GoldenItem[]): CachePairSpec[] {
  return [];
}

export function cachePairOptions(base: EvalRequestOptions): EvalRequestOptions {
  return { ...base };
}

export async function runCachePairs(_input: {
  specs: CachePairSpec[];
  options: EvalRequestOptions;
  send: (payload: RagRunRequest) => Promise<{ status: number; body: unknown }>;
  clear?: () => Promise<void>;
}): Promise<unknown[]> {
  return [];
}
