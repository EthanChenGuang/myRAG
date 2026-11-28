import { describe, expect, it } from 'vitest';
import { ReviewItemSchema } from '@/lib/rag-eval/contracts.generated';
import { ReviewListQuerySchema } from '@/lib/rag/feedback-loop/review-access';

const CALC_REASONS = ['calc_mismatch', 'calc_unverified'] as const;

describe('review read side accepts the reasons mining writes (0984)', () => {
  it.each(CALC_REASONS)('ReviewItem.reasons accepts %s', (reason) => {
    expect(ReviewItemSchema.shape.reasons.safeParse([reason]).success).toBe(true);
  });

  it.each(CALC_REASONS)('the list filter accepts reason=%s', (reason) => {
    expect(ReviewListQuerySchema.safeParse({ reason }).success).toBe(true);
  });

  it('still rejects an unknown reason', () => {
    expect(ReviewItemSchema.shape.reasons.safeParse(['calc_other']).success).toBe(false);
    expect(ReviewListQuerySchema.safeParse({ reason: 'calc_other' }).success).toBe(false);
  });
});
