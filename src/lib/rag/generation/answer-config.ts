export type MaxOutputTokens = { readonly kind: 'off' } | { readonly kind: 'auto' } | { readonly kind: 'fixed'; readonly value: number };
export type OutputGuardMode = 'off' | 'flag' | 'enforce';
export type UploaderHoldMode = 'off' | 'manual' | 'auto';
export interface AnswerConfigWarning {
  readonly code: string;
  readonly message: string;
}
export interface AnswerConfig {
  readonly warnings: readonly AnswerConfigWarning[];
  readonly [key: string]: unknown;
}
export const MIN_OUTPUT_TOKENS_FLOOR = 0;
export function readAnswerConfig(_source: Record<string, string | undefined> = process.env): AnswerConfig {
  return Object.freeze({ warnings: Object.freeze([]) });
}
export function warnAnswerConfigOnce(_config: AnswerConfig = readAnswerConfig()): void {}
export function resetAnswerConfigWarningsForTests(): void {}
