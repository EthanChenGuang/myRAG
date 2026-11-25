import type { RagDeps } from '../../deps';
import type { PostCheckLimits, PostCheckSkipReason } from '../post-checks';
import type { Lang } from '../rewrite-gate';

export type TranslateSkipReason = PostCheckSkipReason | 'invalid_output' | 'unavailable' | 'aborted' | 'error';
export type TranslateSkip = { kind: 'translate'; target: Lang; reason: TranslateSkipReason };
export type TranslatedVariant = { kind: 'translated'; language: Lang; text: string };
export type NativeTranslateResult = { variants: TranslatedVariant[]; skipped: TranslateSkip[] };

export interface NativeTranslateInput {
  query: string;
  language: Lang;
  targets: readonly Lang[];
  protectedTokens: readonly string[];
  signal: AbortSignal;
  maxItems?: number;
  limits?: PostCheckLimits;
  deps?: Pick<RagDeps, 'queryLlm'>;
}

export async function nativeTranslate(_input: NativeTranslateInput): Promise<NativeTranslateResult> {
  return { variants: [], skipped: [] };
}
