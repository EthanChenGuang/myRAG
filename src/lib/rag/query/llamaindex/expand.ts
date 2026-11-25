import type { Lang } from '../rewrite-gate';
import type { PostCheckLimits, PostCheckSkip } from '../post-checks';
import type { NativeDeps, NativeTransformSkip } from './call';

export type ExpandedVariant = { text: string; language: Lang; kind: 'expanded'; legs: 'both'; protectedOk: true };
export type ExpandInput = {
  query: string;
  language: Lang;
  protectedTokens: readonly string[];
  maxItems: number;
  signal: AbortSignal;
  deps: NativeDeps;
  limits?: PostCheckLimits;
};
export type ExpandResult = { variants: ExpandedVariant[]; skipped: Array<PostCheckSkip | NativeTransformSkip> };

export async function nativeExpand(_input: ExpandInput): Promise<ExpandResult> {
  return { variants: [], skipped: [] };
}
