import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import * as store from '@/lib/answers/store';
import { appendReviewReason, type ReviewReason } from '@/lib/answers/store';
import { ReviewQueueItemSchema } from '@/lib/rag-eval/contracts.generated';

const CALC_REASONS = ['calc_mismatch', 'calc_unverified'] as const;
const MIGRATION = path.join(process.cwd(), 'supabase/migrations/0950_calc_review_reasons.sql');

function fakeAdmin(current: string[] = []) {
  const updates: unknown[] = [];
  const client = {
    from() {
      const builder = {
        update(payload: unknown) {
          updates.push(payload);
          return builder;
        },
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        async maybeSingle() {
          return { data: { id: 'x', review_reasons: current }, error: null };
        },
        then(resolve: (value: unknown) => void) {
          resolve({ data: [{ id: 'x' }], error: null });
        },
      };
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, updates };
}

function exportedReasons(): readonly string[] {
  const list = (store as unknown as { REVIEW_REASONS?: readonly string[] }).REVIEW_REASONS;
  expect(Array.isArray(list)).toBe(true);
  return list ?? [];
}

function answerRecordCheckValues(): string[] {
  expect(fs.existsSync(MIGRATION)).toBe(true);
  if (!fs.existsSync(MIGRATION)) return [];
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const match = /CHECK \(review_reasons <@ ARRAY\[([^\]]*)\]::text\[\]\)/.exec(sql);
  expect(match).not.toBeNull();
  return [...(match?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

describe('answer-record review reasons (D-55, GEN-17)', () => {
  it.each(CALC_REASONS)('appendReviewReason accepts %s', async (reason) => {
    const admin = fakeAdmin(['claim_unsupported']);
    await expect(appendReviewReason(admin.client, { id: crypto.randomUUID(), reason: reason as ReviewReason })).resolves.toBe(true);
    expect(admin.updates).toHaveLength(1);
    expect((admin.updates[0] as { review_reasons: string[] }).review_reasons).toEqual(['claim_unsupported', reason]);
  });

  it('an unknown reason still throws the existing error', async () => {
    await expect(appendReviewReason(fakeAdmin().client, { id: crypto.randomUUID(), reason: 'calc_other' as ReviewReason })).rejects.toThrow(
      'unknown review reason',
    );
  });

  it('the TypeScript list equals the database check of 0950', () => {
    expect([...exportedReasons()].sort()).toEqual(answerRecordCheckValues().sort());
  });

  it('every TypeScript reason is a value of the generated contract enum, and the calculation reasons are in both', () => {
    const reasons = exportedReasons();
    for (const reason of CALC_REASONS) expect(reasons).toContain(reason);
    for (const reason of reasons) {
      expect(ReviewQueueItemSchema.shape.reasons.safeParse([reason]).success, reason).toBe(true);
    }
    expect(ReviewQueueItemSchema.shape.reasons.safeParse(['calc_other']).success).toBe(false);
  });
});
