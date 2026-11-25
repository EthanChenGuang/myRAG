import type { AnswerRecord } from '@/lib/rag-eval/contracts.generated';

export type GroundednessBadgeState = 'verified' | 'possibly_unreliable' | 'not_checked';

/** D-14/D-20: which badge an answer shows, or null when it shows none. Never carries a score. */
export function groundednessBadgeState(
  _groundedness: Partial<AnswerRecord['groundedness']> | null | undefined,
  _ragMode: AnswerRecord['ragMode'] | null | undefined,
): GroundednessBadgeState | null {
  return null;
}
