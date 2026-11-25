import type { Lang } from '../rewrite-gate';
import type { PostCheckLimits, PostCheckSkip } from '../post-checks';
import type { NativeDeps, NativeTransformSkip } from './call';

export type HydeVariant = { text: string; language: Lang; kind: 'hyde'; legs: 'dense'; protectedOk: boolean };
export type HydeInput = {
  query: string;
  language: Lang;
  protectedTokens: readonly string[];
  signal: AbortSignal;
  deps: NativeDeps;
  limits?: PostCheckLimits;
};
export type HydeResult = { variant: HydeVariant | null; truncated: boolean; skipped: Array<PostCheckSkip | NativeTransformSkip> };

export async function nativeHyde(_input: HydeInput): Promise<HydeResult> {
  return { variant: null, truncated: false, skipped: [] };
}
