/**
 * Exact rational arithmetic over BigInt for the calculation tool (D-68, D-95).
 * No floating-point value is used in this directory (tests/rag/calc/no-float.test.ts).
 */

export type CalcRejectReason =
  | 'invalid_request'
  | 'unsourced_operand'
  | 'unknown_source'
  | 'unknown_argument'
  | 'mixed_units'
  | 'limit_exceeded'
  | 'division_by_zero'
  | 'invalid_value'
  | 'invalid_date'
  | 'unsupported_source';

export class CalcError extends Error {
  readonly reason: CalcRejectReason;

  constructor(reason: CalcRejectReason, message?: string) {
    super(message ?? reason);
    this.name = 'CalcError';
    this.reason = reason;
  }
}

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

/**
 * `half_up`: ties away from zero; `half_even`: ties to the even digit;
 * `up`: away from zero; `down`: toward zero (Python `decimal` names, D-95).
 */
export type RoundingMode = 'half_up' | 'half_even' | 'up' | 'down';

export const ROUNDING_MODES: readonly RoundingMode[] = ['half_up', 'half_even', 'up', 'down'];

export const DISPLAY_PLACES = 10;

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN = BigInt(10);

const DECIMAL_GRAMMAR = /^-?[0-9]+(?:\.[0-9]+)?$/;

function abs(x: bigint): bigint {
  return x < ZERO ? -x : x;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a);
  let y = abs(b);
  while (y !== ZERO) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function pow10(places: bigint): bigint {
  return TEN ** places;
}

export function rational(n: bigint, d: bigint = ONE): Rational {
  if (typeof n !== 'bigint' || typeof d !== 'bigint') throw new CalcError('invalid_value');
  if (d === ZERO) throw new CalcError('division_by_zero');
  if (d < ZERO) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  if (g > ONE) {
    n /= g;
    d /= g;
  }
  return Object.freeze({ n, d });
}

export function fromBigInt(n: bigint): Rational {
  return rational(n, ONE);
}

/** Accepts only `-?digits(.digits)?`: no exponent, grouping, plus sign, NaN or Infinity (D-68). */
export function parseDecimal(text: unknown): Rational {
  if (typeof text !== 'string' || !DECIMAL_GRAMMAR.test(text)) throw new CalcError('invalid_value');
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const point = body.indexOf('.');
  const intPart = point < 0 ? body : body.slice(0, point);
  const fracPart = point < 0 ? '' : body.slice(point + 1);
  const digits = BigInt(intPart + fracPart);
  return rational(negative ? -digits : digits, pow10(BigInt(fracPart.length)));
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function subtract(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function multiply(a: Rational, b: Rational): Rational {
  return rational(a.n * b.n, a.d * b.d);
}

export function divide(a: Rational, b: Rational): Rational {
  if (b.n === ZERO) throw new CalcError('division_by_zero');
  return rational(a.n * b.d, a.d * b.n);
}

export function negate(a: Rational): Rational {
  return rational(-a.n, a.d);
}

export function isZero(a: Rational): boolean {
  return a.n === ZERO;
}

/** -1, 0 or 1 by cross-multiplication (denominators are positive). */
export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function equals(a: Rational, b: Rational): boolean {
  return a.n === b.n && a.d === b.d;
}

/** Places must be a non-negative integer; BigInt() rejects a fractional or non-finite number. */
function toPlaces(places: number): bigint {
  if (typeof places !== 'number') throw new CalcError('invalid_request');
  let p: bigint;
  try {
    p = BigInt(places);
  } catch {
    throw new CalcError('invalid_request');
  }
  if (p < ZERO) throw new CalcError('invalid_request');
  return p;
}

/** Integer m with m / 10^places the value rounded at `places` by `mode`. */
function roundScaled(value: Rational, places: bigint, mode: RoundingMode): bigint {
  const scaledN = value.n * pow10(places);
  const d = value.d;
  const negative = scaledN < ZERO;
  const mag = abs(scaledN);
  const q = mag / d;
  const r = mag % d;
  let bump = false;
  if (r !== ZERO) {
    switch (mode) {
      case 'down':
        bump = false;
        break;
      case 'up':
        bump = true;
        break;
      case 'half_up':
        bump = r * TWO >= d;
        break;
      case 'half_even': {
        const twice = r * TWO;
        bump = twice > d || (twice === d && q % TWO === ONE);
        break;
      }
      default:
        throw new CalcError('invalid_request');
    }
  }
  const m = bump ? q + ONE : q;
  return negative ? -m : m;
}

export function roundTo(value: Rational, places: number, mode: RoundingMode): Rational {
  if (!ROUNDING_MODES.includes(mode)) throw new CalcError('invalid_request');
  const p = toPlaces(places);
  return rational(roundScaled(value, p, mode), pow10(p));
}

function formatScaled(m: bigint, p: number): string {
  const negative = m < ZERO;
  let digits = abs(m).toString();
  if (p === 0) return (negative && digits !== '0' ? '-' : '') + digits;
  while (digits.length <= p) digits = '0' + digits;
  const text = `${digits.slice(0, digits.length - p)}.${digits.slice(digits.length - p)}`;
  return negative && m !== ZERO ? `-${text}` : text;
}

/** The value rounded at `places` (default half-even), written with exactly `places` fractional digits. */
export function toDecimalString(value: Rational, places: number, mode: RoundingMode = 'half_even'): string {
  if (!ROUNDING_MODES.includes(mode)) throw new CalcError('invalid_request');
  return formatScaled(roundScaled(value, toPlaces(places), mode), places);
}

/** True when the value has no more than `places` fractional digits. */
export function terminatesWithin(value: Rational, places: number): boolean {
  return (value.n * pow10(toPlaces(places))) % value.d === ZERO;
}

export interface DisplayValue {
  display: string;
  display_rounded: boolean;
}

/** At most 10 fractional digits, half-even, trailing zeros removed; flagged when the exact value has more (D-68). */
export function display(value: Rational): DisplayValue {
  let text = toDecimalString(value, DISPLAY_PLACES, 'half_even');
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  if (text === '-0') text = '0';
  return { display: text, display_rounded: !terminatesWithin(value, DISPLAY_PLACES) };
}

/** `n/d` in lowest terms, the denominator always written. */
export function toExactString(value: Rational): string {
  return `${value.n.toString()}/${value.d.toString()}`;
}

/** Bit length of a magnitude (0 for zero), for the evaluator's bounds (Pitfall C3). */
export function bitLength(x: bigint | Rational): number {
  if (typeof x !== 'bigint') return maxInt(bitLength(x.n), bitLength(x.d));
  const mag = abs(x);
  return mag === ZERO ? 0 : mag.toString(2).length;
}

function maxInt(a: number, b: number): number {
  return a > b ? a : b;
}
