export type EffectiveDateDecision = 'apply' | 'await_confirmation' | 'ignore' | 'keep_admin';

export function decideEffectiveDateProposal(_proposal: unknown, _current: unknown, _today: string): EffectiveDateDecision {
  return 'ignore';
}

export function todayUtc(_now: Date): string {
  return '';
}
