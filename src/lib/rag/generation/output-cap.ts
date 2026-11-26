import type { AnswerConfig } from './answer-config';

export type OutputCapReason = string;
export interface OutputCapDecision {
  readonly applied: boolean;
  readonly cap: number | null;
  readonly concise: boolean;
  readonly reason: OutputCapReason;
}
export interface OutputCapContext {
  config: AnswerConfig;
  mode: string;
  knowledgeContext: boolean;
  userMaxTokens: boolean;
  reasoning: boolean;
  approvalContinuation: boolean;
  channel: string;
  caps?: unknown;
}

export function resolveOutputCap(_input: { config: AnswerConfig; mode: string; caps?: unknown }): number | null {
  return null;
}
export function outputCapFloor(): number {
  return 0;
}
export function decideOutputCap(_input: OutputCapContext): OutputCapDecision {
  return { applied: false, cap: null, concise: false, reason: 'off' };
}
export function effectiveMaxOutputTokens(limit: number, _cap: number | null): number {
  return limit;
}
export function answerReserveTokens(input: { decision: OutputCapDecision; modelLimit: number }): number {
  return input.modelLimit;
}
export function resetOutputCapWarningsForTests(): void {}
