import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { queryLanguage } from '@/lib/rag/query/language';

const GOLDEN_PATH = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'),
  'eval/fixtures/golden.jsonl'
);

describe('queryLanguage', () => {
  it('detects zh, en and it on representative questions', () => {
    expect(queryLanguage('请问保修期多久')).toBe('zh');
    expect(queryLanguage('What is the refund window?')).toBe('en');
    expect(queryLanguage('Qual è il periodo di garanzia?')).toBe('it');
  });

  it('returns null when there is no language evidence', () => {
    expect(queryLanguage('XR-2000')).toBeNull();
  });

  it('agrees with golden language on at least 90% of approved items', () => {
    const lines = fs
      .readFileSync(GOLDEN_PATH, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');

    let approved = 0;
    let agreed = 0;
    const mismatches: string[] = [];

    for (const line of lines) {
      const item = JSON.parse(line) as {
        id: string;
        question: string;
        language: string;
        review_status: string;
      };
      if (item.review_status !== 'approved') continue;
      approved += 1;
      const detected = queryLanguage(item.question);
      if (detected === item.language) {
        agreed += 1;
      } else {
        mismatches.push(`${item.id}: expected ${item.language}, got ${String(detected)}`);
      }
    }

    const rate = approved > 0 ? agreed / approved : 0;
    // eslint-disable-next-line no-console -- plan requires printing the agreement rate
    console.log(`queryLanguage golden agreement: ${agreed}/${approved} (${(rate * 100).toFixed(1)}%)`);
    if (mismatches.length > 0) {
      // eslint-disable-next-line no-console -- diagnostic for calibration drift
      console.log('mismatches:', mismatches.slice(0, 10).join('; '));
    }
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });
});