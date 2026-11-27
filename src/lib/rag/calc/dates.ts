/**
 * Civil-date arithmetic for `date_diff` with integers only (D-67, RESEARCH Pattern A).
 * The built-in date object is not used: its UTC helper returns a floating-point number.
 */
import { CalcError, fromBigInt, type Rational } from './rational';

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export type DateUnit = 'days' | 'months' | 'years';

export const DATE_UNITS: readonly DateUnit[] = ['days', 'months', 'years'];

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function digitsToInt(text: string): number {
  let value = 0;
  for (const ch of text) value = value * 10 + (ch.charCodeAt(0) - 48);
  return value;
}

function floorDiv(a: number, b: number): number {
  const r = a % b;
  return (a - r) / b - (r !== 0 && (r < 0) !== (b < 0) ? 1 : 0);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
}

/** Strict `YYYY-MM-DD`, year 0001 to 9999, month and day within the calendar. */
export function parseIsoDate(text: unknown): CivilDate {
  const m = typeof text === 'string' ? ISO_DATE.exec(text) : null;
  if (!m) throw new CalcError('invalid_date');
  const year = digitsToInt(m[1]);
  const month = digitsToInt(m[2]);
  const day = digitsToInt(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CalcError('invalid_date');
  }
  return Object.freeze({ year, month, day });
}

/** Days since 1970-01-01 (proleptic Gregorian), Hinnant's days_from_civil in integer arithmetic. */
export function dayNumber(date: CivilDate): number {
  const y = date.month <= 2 ? date.year - 1 : date.year;
  const era = floorDiv(y, 400);
  const yoe = y - era * 400;
  const mp = (date.month + 9) % 12;
  const doy = floorDiv(153 * mp + 2, 5) + date.day - 1;
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

function compareDates(a: CivilDate, b: CivilDate): number {
  return dayNumber(a) - dayNumber(b);
}

/** Complete months from the earlier to the later date, signed by `b - a`. */
function completeMonths(a: CivilDate, b: CivilDate): number {
  const forward = compareDates(a, b) <= 0;
  const lo = forward ? a : b;
  const hi = forward ? b : a;
  let months = (hi.year - lo.year) * 12 + (hi.month - lo.month);
  if (hi.day < lo.day) months -= 1;
  return forward ? months : -months;
}

/**
 * `b - a` in the unit. Months and years count complete units (a later day of month
 * below the earlier one's subtracts one month). `inclusive` adds one day, in the
 * direction of the difference, for `days` only.
 */
export function dateDiff(a: CivilDate, b: CivilDate, unit: DateUnit, inclusive: boolean): Rational {
  if (!DATE_UNITS.includes(unit) || typeof inclusive !== 'boolean') throw new CalcError('invalid_request');
  let value: number;
  if (unit === 'days') {
    value = dayNumber(b) - dayNumber(a);
    if (inclusive) value = value < 0 ? value - 1 : value + 1;
  } else {
    const months = completeMonths(a, b);
    if (unit === 'months') value = months;
    else value = months < 0 ? -floorDiv(-months, 12) : floorDiv(months, 12);
  }
  return fromBigInt(BigInt(value));
}
