const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  sept: 9,
  october: 10,
  november: 11,
  december: 12,
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
};

const MONTH_NAME_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

function isoDay(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthRange(year: number, month: number): { from: string; to: string } | null {
  if (month < 1 || month > 12 || year < 1900 || year > 2100) return null;
  return {
    from: isoDay(year, month, 1),
    to: isoDay(year, month, lastDayOfMonth(year, month)),
  };
}

function yearRange(year: number): { from: string; to: string } | null {
  if (year < 1900 || year > 2100) return null;
  return { from: isoDay(year, 1, 1), to: isoDay(year, 12, 31) };
}

function quarterRange(quarter: number, year: number): { from: string; to: string } | null {
  if (quarter < 1 || quarter > 4) return null;
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  return {
    from: isoDay(year, startMonth, 1),
    to: isoDay(year, endMonth, lastDayOfMonth(year, endMonth)),
  };
}

function parseExplicitRange(text: string): { from: string; to: string } | null {
  const isoRange = text.match(/^(\d{4}-\d{2}-\d{2})\s*(?:to|–|—|-|\/)\s*(\d{4}-\d{2}-\d{2})$/i);
  if (!isoRange) return null;
  const from = isoRange[1];
  const to = isoRange[2];
  if (!from || !to || from > to) return null;
  return { from, to };
}

export function timeframeToDateRange(timeframe: string | null, _now: Date): { from: string; to: string } | null {
  if (timeframe === null) return null;
  const trimmed = timeframe.trim();
  if (!trimmed) return null;

  const explicit = parseExplicitRange(trimmed);
  if (explicit) return explicit;

  const yearOnly = trimmed.match(/^(\d{4})$/);
  if (yearOnly) return yearRange(Number(yearOnly[1]));

  const quarter = trimmed.match(/^Q([1-4])\s+(\d{4})$/i);
  if (quarter) return quarterRange(Number(quarter[1]), Number(quarter[2]));

  const fy = trimmed.match(/^FY(\d{2}|\d{4})$/i);
  if (fy) {
    const raw = fy[1];
    const year = raw.length === 2 ? 2000 + Number(raw) : Number(raw);
    return yearRange(year);
  }

  const zhMonth = trimmed.match(/^(\d{4})年(\d{1,2})月$/);
  if (zhMonth) return monthRange(Number(zhMonth[1]), Number(zhMonth[2]));

  const monthYear = trimmed.match(new RegExp(`^(${MONTH_NAME_PATTERN})\\s+(\\d{4})$`, 'i'));
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase()];
    if (month) return monthRange(Number(monthYear[2]), month);
  }

  return null;
}