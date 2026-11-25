import type { Lang } from '../rewrite-gate';
import type { PostCheckLimits, PostCheckSkip } from '../post-checks';
import type { NativeDeps, NativeTransformSkip } from './call';

export type SubQuestionVariant = {
  text: string;
  language: Lang;
  kind: 'sub_question';
  legs: 'both';
  protectedOk: true;
  subQuestionIndex: number;
};
export type DecomposeInput = {
  query: string;
  language: Lang;
  protectedTokens: readonly string[];
  signal: AbortSignal;
  deps: NativeDeps;
  limits?: PostCheckLimits;
};
export type DecomposeResult = {
  variants: SubQuestionVariant[];
  notCompound: boolean;
  skipped: Array<PostCheckSkip | NativeTransformSkip>;
};

export async function nativeDecompose(_input: DecomposeInput): Promise<DecomposeResult> {
  return { variants: [], notCompound: false, skipped: [] };
}
