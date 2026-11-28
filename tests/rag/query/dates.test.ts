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

describe('R2 expressions in zh, en and it', () => {
  const NOW = '2026-11-25T10:00:00Z';

  it.each([['去年的营收是多少？'], ['What was revenue last year?'], ["Qual è stato il fatturato l'anno scorso?"]])(
    'previous calendar year: %s',
    (q) => {
      const r = range(q, NOW);
      expect(r).toEqual({ from: '2025-01-01', to: '2025-12-31', includeUndated: true, timeZone: 'UTC' });
    }
  );

  it.each([['近30天的订单'], ['orders in the past 30 days'], ['ordini negli ultimi 30 giorni']])(
    'past 30 days ends today: %s',
    (q) => {
      expect(span(q, NOW)).toEqual(['2026-10-27', '2026-11-25']);
    }
  );

  it.each([['最近的公告'], ['what changed recently'], ['cosa è cambiato di recente'], ['lately'], ['recentemente']])(
    'recent means the last 90 days: %s',
    (q) => {
      expect(span(q, NOW)).toEqual(['2026-08-28', '2026-11-25']);
    }
  );

  it('parses N for months, years and weeks, including Chinese numerals', () => {
    expect(span('近三个月', NOW)).toEqual(['2026-08-26', '2026-11-25']);
    expect(span('past 2 years', NOW)).toEqual(['2024-11-26', '2026-11-25']);
    expect(span('negli ultimi 6 mesi', '2026-08-31T10:00:00Z')).toEqual(['2026-03-01', '2026-08-31']);
    expect(span('negli ultimi 2 anni', NOW)).toEqual(['2024-11-26', '2026-11-25']);
    expect(span('近2周', NOW)).toEqual(['2026-11-12', '2026-11-25']);
    expect(span('近十二个月', NOW)).toEqual(['2025-11-26', '2026-11-25']);
  });

  it('maps fixed expressions in every language', () => {
    expect(span('前年', NOW)).toEqual(['2024-01-01', '2024-12-31']);
    expect(span('the year before last', NOW)).toEqual(['2024-01-01', '2024-12-31']);
    expect(span('due anni fa', NOW)).toEqual(['2024-01-01', '2024-12-31']);
    expect(span('il mese scorso', NOW)).toEqual(['2026-10-01', '2026-10-31']);
    expect(span('questo mese', NOW)).toEqual(['2026-11-01', '2026-11-30']);
    expect(span('本月', NOW)).toEqual(['2026-11-01', '2026-11-30']);
    expect(span('la settimana scorsa', NOW)).toEqual(['2026-11-16', '2026-11-22']);
    expect(span('lo scorso trimestre', NOW)).toEqual(['2026-07-01', '2026-09-30']);
    expect(span("quest'anno", NOW)).toEqual(['2026-01-01', '2026-12-31']);
    expect(span('昨天', NOW)).toEqual(['2026-11-24', '2026-11-24']);
    expect(span('oggi', NOW)).toEqual(['2026-11-25', '2026-11-25']);
  });

  it('two expressions give the union range', () => {
    expect(span('今年和上个月的销售额', NOW)).toEqual(['2026-01-01', '2026-12-31']);
    expect(span('今年和上个月的销售额', '2026-01-15T10:00:00Z')).toEqual(['2025-12-01', '2026-12-31']);
    const result = normalizeRelativeDates('今年和上个月的销售额', { now: new Date(NOW) });
    expect(result.matched).toEqual(['今年', '上个月']);
  });

  it('returns the absolute dates as a dense-query suffix', () => {
    const result = normalizeRelativeDates('What was revenue last year?', { now: new Date(NOW) });
    expect(result.denseSuffix).toBe('(2025-01-01 to 2025-12-31)');
    expect(result.matched).toEqual(['last year']);
    const n = normalizeRelativeDates('近30天的订单', { now: new Date(NOW) });
    expect(n.matched).toEqual(['近30天']);
  });

  it('a query without an R2 term returns no range and no suffix', () => {
    for (const q of ['What is the refund policy?', '退款政策是什么？', 'Qual è la politica di rimborso?', '2025-01-01 report']) {
      const result = normalizeRelativeDates(q, { now: new Date(NOW) });
      expect(result.range).toBeNull();
      expect(result.denseSuffix).toBeNull();
      expect(result.matched).toEqual([]);
    }
  });

  it('ignores a zero count and an invalid now', () => {
    expect(normalizeRelativeDates('past 0 days', { now: new Date(NOW) }).range).toBeNull();
    expect(normalizeRelativeDates('last year', { now: new Date('not a date') }).range).toBeNull();
  });

  it('clamps very large counts to year 0001', () => {
    expect(span('past 9999 years', NOW)).toEqual(['0001-01-01', '2026-11-25']);
  });
});

describe('overlapping R2 spans', () => {
  it('最近30天 is the 30-day window, not the wider 最近 default', () => {
    expect(span('最近30天的订单', '2026-11-25T10:00:00Z')).toEqual(['2026-10-27', '2026-11-25']);
    expect(normalizeRelativeDates('最近30天的订单', { now: new Date('2026-11-25T10:00:00Z') }).matched).toEqual([
      '近30天',
    ]);
  });
});
