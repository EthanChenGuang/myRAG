/**
 * The calculation evaluator (D-66 to D-69): a structured request in, an exact step-listed result or a typed rejection
 * out. Nothing in a request is executed: names resolve through a Map, operations through the frozen lookup table of
 * operations.ts, and every number is parsed from a decimal string into a BigInt rational. No I/O.
 */
import {
  CalcRequestSchema,
  type CalcLimits,
  type CalcRequest,
  type CalcResult,
} from '@/lib/rag-eval/contracts.generated';
import { calcLimits } from './limits';
import { applyOperation, type CalcOp, type CalcValue, type OperationParams } from './operations';
import {
  CalcError,
  add,
  bitLength,
  display,
  parseDecimal,
  roundTo,
  toExactString,
  type CalcRejectReason,
  type Rational,
} from './rational';
import { parseIsoDate, type CivilDate } from './dates';
import { normalizeUnit } from './units';

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const REASONS_MATCH: Exact<CalcRejectReason, NonNullable<CalcResult['reject_reason']>> = true;
void REASONS_MATCH;

export interface CalcContext {
  /** The context-block aliases of this request (the AliasMap keys); a chunk source must name one of them. */
  aliases: ReadonlySet<string>;
  limits?: CalcLimits;
}

type Operand = CalcRequest['operands'][number];
type Step = CalcRequest['steps'][number];
type StepResult = NonNullable<CalcResult['steps']>[number];

interface Conversion {
  from: string;
  to: string;
  toLabel: string;
  fromLabel: string;
}

interface Resolved {
  value: CalcValue;
  /** Normalized unit; '' is unitless. */
  unit: string;
  /** The unit as first written, for the result; null when unitless. */
  unitLabel: string | null;
  conversion: Conversion | null;
  depth: number;
}

const ISO_DATE_SHAPE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const DISPLAY_SHAPE = /^-?[0-9]{1,30}(\.[0-9]{1,30})?$/;
const FIXED_ARITY: ReadonlyMap<CalcOp, number> = new Map<CalcOp, number>([
  ['subtract', 2],
  ['divide', 2],
  ['percentage', 2],
  ['cap_each', 2],
  ['date_diff', 2],
  ['round', 1],
  ['multiply', 2],
  ['add', 2],
]);
const SAME_UNIT_OPS: ReadonlySet<CalcOp> = new Set<CalcOp>(['add', 'subtract', 'min', 'max', 'sum', 'cap_each']);

function reject(reason: CalcRejectReason, message?: string): never {
  throw new CalcError(reason, message);
}

function rejected(reason: CalcRejectReason): CalcResult {
  return { status: 'rejected', value: null, unit: null, steps: [], reject_reason: reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

/**
 * Checks on the raw input that give a specific reason where the schema would only say invalid_request: counts above
 * the limits (limit_exceeded) and an operand without a source (unsourced_operand). Reads own properties only.
 */
function preCheck(raw: unknown, limits: CalcLimits): void {
  if (!isRecord(raw)) reject('invalid_request');
  const operands = has(raw, 'operands') ? raw.operands : undefined;
  const steps = has(raw, 'steps') ? raw.steps : undefined;
  if (Array.isArray(operands) && operands.length > limits.max_operands) reject('limit_exceeded');
  if (Array.isArray(steps) && steps.length > limits.max_steps) reject('limit_exceeded');
  if (Array.isArray(operands)) {
    for (const operand of operands) {
      if (!isRecord(operand)) continue;
      const values = has(operand, 'values') ? operand.values : undefined;
      if (Array.isArray(values) && values.length > limits.max_list_items) reject('limit_exceeded');
    }
    for (const operand of operands) {
      if (isRecord(operand) && (!has(operand, 'source') || operand.source === null)) reject('unsourced_operand');
    }
  }
}

function unitLabel(unit: string | undefined): string | null {
  if (unit === undefined) return null;
  return effectiveUnit(unit) === '' ? null : unit.trim();
}

/** A percent sign is a unitless percent (D-69 "a count or a percent"). */
function effectiveUnit(unit: string | undefined): string {
  const normalized = normalizeUnit(unit);
  return normalized === '%' ? '' : normalized;
}

function digitCount(text: string): number {
  return text.replace(/[^0-9]/g, '').length;
}

function checkSource(operand: Operand, aliases: ReadonlySet<string>): void {
  const source = operand.source;
  if (source.kind === 'fact_tool') reject('unsupported_source');
  if (source.kind === 'question') {
    if (source.alias !== undefined || source.tool !== undefined || source.key !== undefined) reject('invalid_request');
    return;
  }
  if (source.tool !== undefined || source.key !== undefined) reject('invalid_request');
  if (source.alias === undefined) reject('unsourced_operand');
  if (!aliases.has(source.alias)) reject('unknown_source');
}

function resolveOperand(operand: Operand, limits: CalcLimits): Resolved {
  const hasValue = operand.value !== undefined;
  const hasValues = operand.values !== undefined;
  if (hasValue === hasValues) reject('invalid_request', 'an operand needs exactly one of value and values');
  if ((operand.unit_from === undefined) !== (operand.unit_to === undefined)) {
    reject('invalid_request', 'unit_from and unit_to go together');
  }
  const isConversion = operand.unit_from !== undefined && operand.unit_to !== undefined;

  let value: CalcValue;
  if (operand.values !== undefined) {
    if (isConversion) reject('invalid_request', 'a conversion operand is a single value');
    if (operand.values.length > limits.max_list_items) reject('limit_exceeded');
    const items: Rational[] = [];
    for (const text of operand.values) {
      if (digitCount(text) > limits.max_digits) reject('limit_exceeded');
      items.push(parseDecimal(text));
    }
    value = { kind: 'list', values: items };
  } else {
    const text = operand.value as string;
    if (ISO_DATE_SHAPE.test(text)) {
      if (isConversion) reject('invalid_request', 'a conversion operand is a number');
      value = { kind: 'date', value: parseIsoDate(text) };
    } else {
      if (digitCount(text) > limits.max_digits) reject('limit_exceeded');
      value = { kind: 'number', value: parseDecimal(text) };
    }
  }

  if (isConversion) {
    if (operand.unit !== undefined) reject('invalid_request', 'a conversion operand declares unit_from and unit_to only');
    const from = effectiveUnit(operand.unit_from);
    const to = effectiveUnit(operand.unit_to);
    if (from === '' || to === '') reject('mixed_units');
    return {
      value,
      unit: '',
      unitLabel: null,
      conversion: { from, to, fromLabel: (operand.unit_from as string).trim(), toLabel: (operand.unit_to as string).trim() },
      depth: 0,
    };
  }
  const unit = value.kind === 'date' ? '' : effectiveUnit(operand.unit);
  return { value, unit, unitLabel: value.kind === 'date' ? null : unitLabel(operand.unit), conversion: null, depth: 0 };
}

interface UnitOutcome {
  unit: string;
  label: string | null;
}

/** The D-69 unit rules; anything they do not allow is mixed_units. */
function resultUnit(op: CalcOp, args: readonly Resolved[]): UnitOutcome {
  const conversions = args.filter((a) => a.conversion !== null);
  if (conversions.length > 0 && op !== 'multiply' && op !== 'divide') reject('mixed_units');
  const plain = (a: Resolved): UnitOutcome => ({ unit: a.unit, label: a.unitLabel });

  if (SAME_UNIT_OPS.has(op)) {
    const first = args[0];
    for (const arg of args) if (arg.unit !== first.unit) reject('mixed_units');
    return plain(first);
  }
  switch (op) {
    case 'multiply': {
      const [a, b] = args;
      if (a.conversion && b.conversion) reject('mixed_units');
      const conv = a.conversion ? a : b.conversion ? b : null;
      if (conv) {
        const other = conv === a ? b : a;
        const c = conv.conversion as Conversion;
        if (other.unit !== c.from) reject('mixed_units');
        return { unit: c.to, label: c.toLabel };
      }
      if (a.unit === '') return plain(b);
      if (b.unit === '') return plain(a);
      return reject('mixed_units');
    }
    case 'divide': {
      const [a, b] = args;
      if (a.conversion) reject('mixed_units');
      if (b.conversion) {
        const c = b.conversion;
        if (a.unit !== c.to) reject('mixed_units');
        return { unit: c.from, label: c.fromLabel };
      }
      if (b.unit === '') return plain(a);
      if (a.unit === b.unit) return { unit: '', label: null };
      return reject('mixed_units');
    }
    case 'percentage': {
      const [value, percent] = args;
      if (percent.unit !== '') reject('mixed_units');
      return plain(value);
    }
    case 'round':
      return plain(args[0]);
    case 'date_diff':
      return { unit: '', label: null };
    default:
      return reject('invalid_request');
  }
}

function checkStepShape(step: Step): void {
  if (step.op !== 'date_diff' && (step.date_unit !== undefined || step.inclusive !== undefined)) {
    reject('invalid_request', 'date_unit and inclusive apply only to date_diff');
  }
  if (step.op === 'round' && step.rounding === undefined) reject('invalid_request', 'a round step needs rounding');
  const arity = FIXED_ARITY.get(step.op);
  if (arity !== undefined && step.args.length !== arity) reject('invalid_request', 'wrong number of arguments');
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function isoDate(date: CivilDate): string {
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

function inputStrings(value: CalcValue): string[] {
  if (value.kind === 'number') return [toExactString(value.value)];
  if (value.kind === 'list') return value.values.map(toExactString);
  return [isoDate(value.value)];
}

function checkBits(value: CalcValue, limits: CalcLimits): void {
  const items = value.kind === 'number' ? [value.value] : value.kind === 'list' ? value.values : [];
  for (const item of items) if (bitLength(item) > limits.max_bits) reject('limit_exceeded');
}

/** A number, or a list reported by its total (CalcStepResult has one exact value per step). */
function reportedValue(value: CalcValue): Rational {
  if (value.kind === 'number') return value.value;
  if (value.kind === 'list') return value.values.reduce((total, v) => add(total, v));
  return reject('invalid_request');
}

function evaluateStep(step: Step, names: Map<string, Resolved>, limits: CalcLimits): { resolved: Resolved; report: StepResult } {
  checkStepShape(step);
  const args: Resolved[] = [];
  for (const name of step.args) {
    const arg = names.get(name);
    if (arg === undefined) reject('unknown_argument');
    args.push(arg);
  }
  let depth = 0;
  for (const arg of args) if (arg.depth > depth) depth = arg.depth;
  depth += 1;
  if (depth > limits.max_depth) reject('limit_exceeded');
  if (step.rounding !== undefined && step.rounding.places > limits.max_round_places) reject('limit_exceeded');

  const unit = resultUnit(step.op, args);
  const params: OperationParams = {};
  if (step.op === 'round' && step.rounding) {
    params.places = step.rounding.places;
    params.mode = step.rounding.mode;
  }
  if (step.op === 'date_diff') {
    params.unit = step.date_unit;
    params.inclusive = step.inclusive;
  }
  let value = applyOperation(
    step.op,
    args.map((a) => a.value),
    params,
  );
  if (step.rounding && step.op !== 'round') {
    const { places, mode } = step.rounding;
    if (value.kind === 'number') value = { kind: 'number', value: roundTo(value.value, places, mode) };
    else if (value.kind === 'list') value = { kind: 'list', values: value.values.map((v) => roundTo(v, places, mode)) };
  }
  checkBits(value, limits);

  const exact = reportedValue(value);
  const shown = display(exact);
  if (!DISPLAY_SHAPE.test(shown.display)) reject('limit_exceeded');
  const inputs: string[] = [];
  for (const arg of args) inputs.push(...inputStrings(arg.value));
  return {
    resolved: { value, unit: unit.unit, unitLabel: unit.label, conversion: null, depth },
    report: {
      id: step.id,
      op: step.op,
      inputs,
      exact: toExactString(exact),
      display: shown.display,
      display_rounded: shown.display_rounded,
    },
  };
}

function run(raw: unknown, ctx: CalcContext): CalcResult {
  const limits = ctx.limits ?? calcLimits();
  preCheck(raw, limits);
  const parsed = CalcRequestSchema.safeParse(raw);
  if (!parsed.success) return rejected('invalid_request');
  const request = parsed.data;
  if (request.operands.length > limits.max_operands || request.steps.length > limits.max_steps) reject('limit_exceeded');

  const names = new Map<string, Resolved>();
  for (const operand of request.operands) {
    if (names.has(operand.name)) reject('invalid_request', 'operand names must not repeat');
    checkSource(operand, ctx.aliases);
    names.set(operand.name, resolveOperand(operand, limits));
  }

  const stepIds = new Set<string>();
  const reports: StepResult[] = [];
  for (const step of request.steps) {
    if (names.has(step.id)) reject('invalid_request', 'step ids must not repeat or reuse an operand name');
    const { resolved, report } = evaluateStep(step, names, limits);
    names.set(step.id, resolved);
    stepIds.add(step.id);
    reports.push(report);
  }

  if (!stepIds.has(request.result)) {
    reject(names.has(request.result) ? 'invalid_request' : 'unknown_argument', 'result must name a step');
  }
  const final = names.get(request.result) as Resolved;
  if (final.value.kind !== 'number') reject('invalid_request', 'the result step must produce a single number');
  return {
    status: 'ok',
    value: display(final.value.value).display,
    unit: final.unitLabel,
    steps: reports,
    reject_reason: null,
  };
}

/** Never throws: a CalcError becomes a rejection with its reason, any other failure becomes invalid_request. */
export function evaluateCalc(raw: unknown, ctx: CalcContext): CalcResult {
  try {
    return run(raw, ctx);
  } catch (error) {
    if (error instanceof CalcError) return rejected(error.reason);
    return rejected('invalid_request');
  }
}
