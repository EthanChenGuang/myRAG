import { describe, expect, test } from 'vitest';
import { groundednessBadgeState } from '@/lib/chat/badge-state';

const scored = (label: string | null, score = 0.91) => ({ status: 'scored' as const, label: label as never, score, threshold: 0.5, reason: null });
const notChecked = (reason: string | null) => ({ status: 'not_checked' as const, label: 'not_checked' as const, score: null, reason });

describe('groundednessBadgeState', () => {
  test('scored verified and possibly_unreliable map to their states', () => {
    expect(groundednessBadgeState(scored('verified'), 'strict')).toBe('verified');
    expect(groundednessBadgeState(scored('possibly_unreliable', 0.12), 'balanced')).toBe('possibly_unreliable');
  });

  test.each(['unsupported_language', 'scorer_unavailable', 'too_long', 'timeout', 'error', 'expired', 'tool_output', 'scorer_busy'])(
    'not_checked with reason %s shows not checked',
    (reason) => {
      expect(groundednessBadgeState(notChecked(reason), 'strict')).toBe('not_checked');
      expect(groundednessBadgeState(notChecked(reason), 'balanced')).toBe('not_checked');
    },
  );

  test.each(['disabled', 'not_eligible', 'aborted'])('not_checked with reason %s is hidden', (reason) => {
    expect(groundednessBadgeState(notChecked(reason), 'strict')).toBeNull();
    expect(groundednessBadgeState(notChecked(reason), null)).toBeNull();
  });

  test('pending and missing groundedness are hidden', () => {
    expect(groundednessBadgeState({ status: 'pending' }, 'strict')).toBeNull();
    expect(groundednessBadgeState(undefined, 'strict')).toBeNull();
    expect(groundednessBadgeState(null, 'balanced')).toBeNull();
  });

  test.each(['flexible', 'bypass'] as const)('a known %s ragMode hides the badge whatever the groundedness', (mode) => {
    expect(groundednessBadgeState(scored('verified'), mode)).toBeNull();
    expect(groundednessBadgeState(scored('possibly_unreliable'), mode)).toBeNull();
    expect(groundednessBadgeState(notChecked('timeout'), mode)).toBeNull();
  });

  test('an unknown ragMode (shared chat, metadata only) follows the reason rules', () => {
    expect(groundednessBadgeState(scored('verified'), null)).toBe('verified');
    expect(groundednessBadgeState(scored('possibly_unreliable'), undefined)).toBe('possibly_unreliable');
    expect(groundednessBadgeState(notChecked('unsupported_language'), undefined)).toBe('not_checked');
    expect(groundednessBadgeState(notChecked('not_eligible'), undefined)).toBeNull();
  });

  test('scored without a usable label is hidden; scored with label not_checked shows not checked', () => {
    expect(groundednessBadgeState(scored(null), 'strict')).toBeNull();
    expect(groundednessBadgeState(scored('not_checked'), 'strict')).toBe('not_checked');
  });

  test('the result is never a number and never contains the score', () => {
    for (const g of [scored('verified', 0.9731), scored('possibly_unreliable', 0.2), notChecked('timeout')]) {
      const state = groundednessBadgeState(g, 'strict');
      expect(typeof state).toBe('string');
      expect(String(state)).not.toMatch(/\d/);
    }
  });
});
