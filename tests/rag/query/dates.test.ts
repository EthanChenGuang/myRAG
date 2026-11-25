import { describe, expect, it } from 'vitest';
import { normalizeRelativeDates, resolveTimeZone } from '@/lib/rag/query/dates';

function range(q: string, now: string, timeZone?: string) {
  return normalizeRelativeDates(q, { now: new Date(now), timeZone }).range;
}

function span(q: string, now: string, timeZone?: string): [string, string] | null {
  const r = range(q, now, timeZone);
  return r === null ? null : [r.from, r.to];
}

describe('resolveTimeZone', () => {
  it('keeps a valid IANA zone', () => {
    expect(resolveTimeZone('Europe/Rome')).toBe('Europe/Rome');
    expect(resolveTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai');
    expect(resolveTimeZone('UTC')).toBe('UTC');
  });

  it('falls back to UTC for an unknown, empty, missing or non-IANA zone', () => {
    expect(resolveTimeZone('Mars/Base')).toBe('UTC');
    expect(resolveTimeZone('')).toBe('UTC');
    expect(resolveTimeZone(undefined)).toBe('UTC');
    expect(resolveTimeZone('+01:00')).toBe('UTC');
    expect(resolveTimeZone('Europe/Rome'.repeat(20))).toBe('UTC');
    expect(resolveTimeZone(42 as unknown as string)).toBe('UTC');
  });

  it('returns the zone actually used with the result', () => {
    const now = new Date('2026-03-31T23:30:00Z');
    expect(normalizeRelativeDates('last month', { now, timeZone: 'Mars/Base' }).timeZone).toBe('UTC');
    expect(normalizeRelativeDates('last month', { now, timeZone: 'Mars/Base' }).range?.timeZone).toBe('UTC');
    expect(normalizeRelativeDates('last month', { now, timeZone: 'Asia/Shanghai' }).range?.timeZone).toBe(
      'Asia/Shanghai'
    );
    expect(normalizeRelativeDates('hello', { now, timeZone: 'Europe/Rome' }).timeZone).toBe('Europe/Rome');
  });
});

describe('calendar arithmetic in the request time zone', () => {
  it('last month depends on the local date of now', () => {
    expect(span('last month', '2026-03-31T23:30:00Z', 'UTC')).toEqual(['2026-02-01', '2026-02-28']);
    expect(span('last month', '2026-03-31T23:30:00Z', 'Asia/Shanghai')).toEqual(['2026-03-01', '2026-03-31']);
  });

  it('handles a leap day and the previous year', () => {
    expect(span('last year', '2024-02-29T12:00:00Z')).toEqual(['2023-01-01', '2023-12-31']);
    expect(span('last month', '2024-03-15T12:00:00Z')).toEqual(['2024-02-01', '2024-02-29']);
    expect(span('last month', '2026-01-10T12:00:00Z')).toEqual(['2025-12-01', '2025-12-31']);
  });

  it('handles quarter boundaries', () => {
    expect(span('last quarter', '2026-01-15T12:00:00Z')).toEqual(['2025-10-01', '2025-12-31']);
    expect(span('this quarter', '2026-05-20T12:00:00Z')).toEqual(['2026-04-01', '2026-06-30']);
    expect(span('上季度', '2026-09-30T12:00:00Z')).toEqual(['2026-04-01', '2026-06-30']);
  });

  it('weeks start on Monday', () => {
    // 2026-11-29 is a Sunday.
    expect(span('this week', '2026-11-29T12:00:00Z')).toEqual(['2026-11-23', '2026-11-29']);
    expect(span('this week', '2026-11-23T12:00:00Z')).toEqual(['2026-11-23', '2026-11-29']);
    expect(span('last week', '2026-11-29T12:00:00Z')).toEqual(['2026-11-16', '2026-11-22']);
    expect(span('上周', '2026-01-01T12:00:00Z')).toEqual(['2025-12-22', '2025-12-28']);
  });

  it('yesterday across the Europe/Rome DST change is the local calendar day', () => {
    // 2026-03-29T22:30Z is 00:30 on 2026-03-30 in Rome (CEST); 24 hours earlier was still 2026-03-28 locally.
    expect(span('yesterday', '2026-03-29T22:30:00Z', 'Europe/Rome')).toEqual(['2026-03-29', '2026-03-29']);
    expect(span('today', '2026-03-29T22:30:00Z', 'Europe/Rome')).toEqual(['2026-03-30', '2026-03-30']);
    expect(span('ieri', '2026-10-25T23:30:00Z', 'Europe/Rome')).toEqual(['2026-10-25', '2026-10-25']);
  });

  it('a negative-offset zone can still be on the previous day', () => {
    expect(span('today', '2026-01-01T03:00:00Z', 'America/New_York')).toEqual(['2025-12-31', '2025-12-31']);
    expect(span('this year', '2026-01-01T03:00:00Z', 'America/New_York')).toEqual(['2025-01-01', '2025-12-31']);
  });
});
