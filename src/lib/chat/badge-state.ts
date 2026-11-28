import type { AnswerRecord } from '@/lib/rag-eval/contracts.generated';

export type GroundednessBadgeState = 'verified' | 'possibly_unreliable' | 'not_checked';

type GroundednessLike = Partial<Pick<AnswerRecord['groundedness'], 'status' | 'label' | 'reason'>>;

const SHOWN_MODES = new Set<string>(['strict', 'balanced']);
const HIDDEN_REASONS = new Set<string>(['disabled', 'not_eligible', 'aborted']);

/** D-14/D-20: which badge an answer shows, or null when it shows none. Never carries a score. */
export function groundednessBadgeState(
  groundedness: GroundednessLike | null | undefined,
  ragMode: AnswerRecord['ragMode'] | null | undefined,
): GroundednessBadgeState | null {
  if (ragMode != null && !SHOWN_MODES.has(ragMode)) return null;
  if (!groundedness) return null;
  if (groundedness.status === 'scored') {
    const label = groundedness.label;
    return label === 'verified' || label === 'possibly_unreliable' || label === 'not_checked' ? label : null;
  }
  if (groundedness.status === 'not_checked') {
    const reason = groundedness.reason;
    if (typeof reason === 'string' && HIDDEN_REASONS.has(reason)) return null;
    return 'not_checked';
  }
  return null;
}
