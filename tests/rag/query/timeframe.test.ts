import { describe, expect, it } from 'vitest';
import { timeframeToDateRange } from '@/lib/rag/query/timeframe';

const NOW = new Date('2025-06-15T12:00:00.000Z');

describe('timeframeToDateRange', () => {
  it('maps a calendar year', () => {
    expect(timeframeToDateRange('2024', NOW)).toEqual({
      from: '2024-01-01',
      to: '2024-12-31',
    });
  });

  it('maps a quarter with year', () => {
    expect(timeframeToDateRange('Q3 2023', NOW)).toEqual({
      from: '2023-07-01',
      to: '2023-09-30',
    });
  });

  it('maps a Chinese year and month', () => {
    expect(timeframeToDateRange('2024年3月', NOW)).toEqual({
      from: '2024-03-01',
      to: '2024-03-31',
    });
  });

  it('returns null for unparseable or null input', () => {
    expect(timeframeToDateRange(null, NOW)).toBeNull();
    expect(timeframeToDateRange('sometime soon', NOW)).toBeNull();
  });
});