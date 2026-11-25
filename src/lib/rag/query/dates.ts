import { matchRelativeTime, type RelativeTimeMatch } from './rewrite-gate';

export interface RelativeDateRange {
  /** Inclusive start, ISO YYYY-MM-DD in `timeZone`. */
  from: string;
  /** Inclusive end, ISO YYYY-MM-DD in `timeZone`. */
  to: string;
  includeUndated: true;
  timeZone: string;
}

export interface NormalizedDates {
  range: RelativeDateRange | null;
  /** Absolute dates for the dense-query text, e.g. "(2025-01-01 to 2025-12-31)". */
  denseSuffix: string | null;
  matched: string[];
  /** The zone actually used (the request zone when valid, otherwise UTC), for the trace. */
  timeZone: string;
}

export interface NormalizeDatesOptions {
  now: Date;
  timeZone?: string | null;
}

/** 最近 / recently / di recente: the last 90 days, today included. */
export const RECENT_DAYS = 90;

const FALLBACK_TIME_ZONE = 'UTC';
const MAX_TIME_ZONE_LENGTH = 64;
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

let supportedZones: ReadonlySet<string> | null | undefined;

function supportedTimeZones(): ReadonlySet<string> | null {
  if (supportedZones === undefined) {
    try {
      const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
      supportedZones = typeof intl.supportedValuesOf === 'function' ? new Set(intl.supportedValuesOf('timeZone')) : null;
    } catch {
      supportedZones = null;
    }
  }
  return supportedZones;
}

/**
 * The client's IANA time zone when Intl accepts it, otherwise UTC. Offsets such as "+01:00" and
 * over-long strings are rejected; links and aliases (e.g. "UTC", "Asia/Calcutta") are accepted when Intl
 * resolves them.
 */
export function resolveTimeZone(timeZone?: string | null): string {
  if (typeof timeZone !== 'string') return FALLBACK_TIME_ZONE;
  const candidate = timeZone.trim();
  if (candidate.length === 0 || candidate.length > MAX_TIME_ZONE_LENGTH || !IANA_NAME.test(candidate)) {
    return FALLBACK_TIME_ZONE;
  }
  if (supportedTimeZones()?.has(candidate)) return candidate;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

type Civil = { y: number; m: number; d: number };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function localDate(now: Date, timeZone: string): Civil {
  let formatter = partsFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      era: 'short',
    });
    partsFormatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;
  const year = Number(parts.year);
  return {
    y: parts.era === 'BC' || parts.era === 'B' ? 1 - year : year,
    m: Number(parts.month),
    d: Number(parts.day),
  };
}

// Proleptic Gregorian day numbers (days since 1970-01-01), pure integer arithmetic.
function toDays({ y, m, d }: Civil): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDays(days: number): Civil {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Month shift on the calendar; the day is clamped to the target month's last day. */
function addMonths({ y, m, d }: Civil, months: number): Civil {
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12);
  const nm = index - ny * 12 + 1;
  return { y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) };
}

/** Monday = 0 … Sunday = 6. 1970-01-01 was a Thursday. */
function isoWeekdayIndex(days: number): number {
  return (((days + 3) % 7) + 7) % 7;
}

type DayRange = { from: number; to: number };

function monthRange(today: Civil, offset: number): DayRange {
  const first = addMonths({ y: today.y, m: today.m, d: 1 }, offset);
  return { from: toDays(first), to: toDays({ ...first, d: daysInMonth(first.y, first.m) }) };
}

function quarterRange(today: Civil, offset: number): DayRange {
  const startMonth = Math.floor((today.m - 1) / 3) * 3 + 1;
  const first = addMonths({ y: today.y, m: startMonth, d: 1 }, offset * 3);
  const last = addMonths(first, 2);
  return { from: toDays(first), to: toDays({ ...last, d: daysInMonth(last.y, last.m) }) };
}

function periodRange(unit: string, offset: number, today: Civil): DayRange | null {
  const todayDays = toDays(today);
  switch (unit) {
    case 'day':
      return { from: todayDays + offset, to: todayDays + offset };
    case 'week': {
      const monday = todayDays - isoWeekdayIndex(todayDays) + offset * 7;
      return { from: monday, to: monday + 6 };
    }
    case 'month':
      return monthRange(today, offset);
    case 'quarter':
      return quarterRange(today, offset);
    case 'year':
      return { from: toDays({ y: today.y + offset, m: 1, d: 1 }), to: toDays({ y: today.y + offset, m: 12, d: 31 }) };
    default:
      return null;
  }
}

/** The last n units ending today, today included (近30天 = today minus 29 days through today). */
function trailingRange(unit: string, n: number, today: Civil): DayRange | null {
  const todayDays = toDays(today);
  switch (unit) {
    case 'day':
      return { from: todayDays - n + 1, to: todayDays };
    case 'week':
      return { from: todayDays - n * 7 + 1, to: todayDays };
    case 'month':
      return { from: toDays(addMonths(today, -n)) + 1, to: todayDays };
    case 'year':
      return { from: toDays(addMonths(today, -n * 12)) + 1, to: todayDays };
    default:
      return null;
  }
}

function rangeFor(match: RelativeTimeMatch, today: Civil): DayRange | null {
  if (match.unit === 'recent') return trailingRange('day', RECENT_DAYS, today);
  if (typeof match.offset === 'number') return periodRange(match.unit, match.offset, today);
  if (typeof match.n === 'number' && Number.isInteger(match.n) && match.n > 0) {
    return trailingRange(match.unit, match.n, today);
  }
  return null;
}

const MIN_DAYS = toDays({ y: 1, m: 1, d: 1 });
const MAX_DAYS = toDays({ y: 9999, m: 12, d: 31 });

function isoDate(days: number): string {
  const { y, m, d } = fromDays(Math.min(Math.max(days, MIN_DAYS), MAX_DAYS));
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function matchedLabel(match: RelativeTimeMatch): string {
  return typeof match.n === 'number' ? match.term.replace('N', String(match.n)) : match.term;
}

/**
 * Gate rule R2 (D-11): relative time expressions in zh, en and it become one absolute inclusive date
 * range in the request's time zone (UTC when the zone is missing or invalid). Several expressions give
 * their union. Deterministic; no LLM, no I/O.
 */
export function normalizeRelativeDates(q: string, opts: NormalizeDatesOptions): NormalizedDates {
  const timeZone = resolveTimeZone(opts.timeZone);
  const none: NormalizedDates = { range: null, denseSuffix: null, matched: [], timeZone };
  if (!(opts.now instanceof Date) || Number.isNaN(opts.now.getTime())) return none;

  const matches = matchRelativeTime(q);
  if (matches.length === 0) return none;

  const today = localDate(opts.now, timeZone);
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  const matched: string[] = [];
  for (const match of matches) {
    const span = rangeFor(match, today);
    if (span === null) continue;
    from = Math.min(from, span.from);
    to = Math.max(to, span.to);
    const label = matchedLabel(match);
    if (!matched.includes(label)) matched.push(label);
  }
  if (matched.length === 0) return none;

  const range: RelativeDateRange = { from: isoDate(from), to: isoDate(to), includeUndated: true, timeZone };
  return { range, denseSuffix: `(${range.from} to ${range.to})`, matched, timeZone };
}
