/**
 * The closed operation set of the calculation tool (D-67) as pure functions over exact values.
 * Units are handled by the evaluator (plan 05.2.1-07). There is no expression parser and no
 * dispatch other than the frozen OPERATIONS table keyed by the operation literals.
 */
import {
  CalcError,
  ROUNDING_MODES,
  add,
  compare,
  divide,
  fromBigInt,
  multiply,
  roundTo,
  subtract,
  type Rational,
  type RoundingMode,
} from './rational';
import { DATE_UNITS, dateDiff, type CivilDate, type DateUnit } from './dates';

export type CalcOp =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'min'
  | 'max'
  | 'sum'
  | 'cap_each'
  | 'percentage'
  | 'round'
  | 'date_diff';

export type CalcValue =
  | { readonly kind: 'number'; readonly value: Rational }
  | { readonly kind: 'list'; readonly values: readonly Rational[] }
  | { readonly kind: 'date'; readonly value: CivilDate };

export interface OperationParams {
  /** `round`: places (required) and mode (half-even when absent, D-95). */
  places?: number;
  mode?: RoundingMode;
  /** `date_diff`: unit and the explicit inclusive flag (both required). */
  unit?: DateUnit;
  inclusive?: boolean;
}

export type OperationFn = (args: readonly CalcValue[], params?: OperationParams) => CalcValue;

const HUNDRED = fromBigInt(BigInt(100));

function invalid(message: string): never {
  throw new CalcError('invalid_request', message);
}

function numberValue(value: Rational): CalcValue {
  return { kind: 'number', value };
}

function asNumber(arg: CalcValue | undefined): Rational {
  if (!arg || arg.kind !== 'number') invalid('expected a number argument');
  return arg.value;
}

function twoNumbers(args: readonly CalcValue[]): [Rational, Rational] {
  if (args.length !== 2) invalid('expected two arguments');
  return [asNumber(args[0]), asNumber(args[1])];
}

/** Numbers and lists flattened in order; empty is rejected. */
function flatten(args: readonly CalcValue[]): Rational[] {
  const out: Rational[] = [];
  for (const arg of args) {
    if (arg.kind === 'number') out.push(arg.value);
    else if (arg.kind === 'list') out.push(...arg.values);
    else invalid('expected numbers or lists');
  }
  if (out.length === 0) invalid('expected at least one value');
  return out;
}

export const addOp: OperationFn = (args) => numberValue(add(...twoNumbers(args)));

export const subtractOp: OperationFn = (args) => numberValue(subtract(...twoNumbers(args)));

export const multiplyOp: OperationFn = (args) => numberValue(multiply(...twoNumbers(args)));

export const divideOp: OperationFn = (args) => numberValue(divide(...twoNumbers(args)));

export const minOp: OperationFn = (args) =>
  numberValue(flatten(args).reduce((best, v) => (compare(v, best) < 0 ? v : best)));

export const maxOp: OperationFn = (args) =>
  numberValue(flatten(args).reduce((best, v) => (compare(v, best) > 0 ? v : best)));

export const sumOp: OperationFn = (args) => numberValue(flatten(args).reduce((total, v) => add(total, v)));

/** Each list item limited by the cap, order kept: `cap_each(list, cap)`. */
export const capEachOp: OperationFn = (args) => {
  if (args.length !== 2) invalid('expected a list and a cap');
  const [items, capArg] = args;
  if (items.kind !== 'list') invalid('expected a list as the first argument');
  if (items.values.length === 0) invalid('expected a non-empty list');
  const cap = asNumber(capArg);
  return { kind: 'list', values: items.values.map((v) => (compare(v, cap) > 0 ? cap : v)) };
};

/** `percentage(value, percent)` = value * percent / 100. */
export const percentageOp: OperationFn = (args) => {
  const [value, percent] = twoNumbers(args);
  return numberValue(divide(multiply(value, percent), HUNDRED));
};

export const roundOp: OperationFn = (args, params = {}) => {
  if (args.length !== 1) invalid('expected one argument');
  if (params.places === undefined) invalid('round needs places');
  const mode = params.mode ?? 'half_even';
  if (!ROUNDING_MODES.includes(mode)) invalid('unknown rounding mode');
  return numberValue(roundTo(asNumber(args[0]), params.places, mode));
};

export const dateDiffOp: OperationFn = (args, params = {}) => {
  if (args.length !== 2) invalid('expected two dates');
  const [a, b] = args;
  if (a.kind !== 'date' || b.kind !== 'date') invalid('expected two dates');
  if (params.unit === undefined || !DATE_UNITS.includes(params.unit)) invalid('date_diff needs a unit');
  if (typeof params.inclusive !== 'boolean') invalid('date_diff needs an explicit inclusive flag');
  return numberValue(dateDiff(a.value, b.value, params.unit, params.inclusive));
};

export const OPERATIONS: Readonly<Record<CalcOp, OperationFn>> = Object.freeze({
  add: addOp,
  subtract: subtractOp,
  multiply: multiplyOp,
  divide: divideOp,
  min: minOp,
  max: maxOp,
  sum: sumOp,
  cap_each: capEachOp,
  percentage: percentageOp,
  round: roundOp,
  date_diff: dateDiffOp,
});

export const CALC_OPS: readonly CalcOp[] = Object.freeze([
  'add',
  'subtract',
  'multiply',
  'divide',
  'min',
  'max',
  'sum',
  'cap_each',
  'percentage',
  'round',
  'date_diff',
]);

export function isCalcOp(op: unknown): op is CalcOp {
  return typeof op === 'string' && (CALC_OPS as readonly string[]).includes(op);
}

/** Looks the operation up in the fixed table; anything outside the closed set is rejected. */
export function applyOperation(op: unknown, args: readonly CalcValue[], params: OperationParams = {}): CalcValue {
  if (!isCalcOp(op)) invalid('unknown operation');
  return OPERATIONS[op](args, params);
}
