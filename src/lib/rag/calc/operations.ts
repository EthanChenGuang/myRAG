import { CalcError, type Rational, type RoundingMode } from './rational';
import type { CivilDate, DateUnit } from './dates';

export type CalcOp = 'add' | 'subtract' | 'multiply' | 'divide' | 'min' | 'max' | 'sum' | 'cap_each' | 'percentage' | 'round' | 'date_diff';
export type CalcValue = { kind: 'number'; value: Rational } | { kind: 'list'; values: Rational[] } | { kind: 'date'; value: CivilDate };
export interface OperationParams { places?: number; mode?: RoundingMode; unit?: DateUnit; inclusive?: boolean }
type Fn = (args: readonly CalcValue[], params?: OperationParams) => CalcValue;
const todo: Fn = () => { throw new CalcError('invalid_request', 'not implemented'); };
export const CALC_OPS: readonly CalcOp[] = [];
export const OPERATIONS: Readonly<Record<CalcOp, Fn>> = {} as Record<CalcOp, Fn>;
export const minOp = todo, maxOp = todo, sumOp = todo, capEachOp = todo, percentageOp = todo, roundOp = todo, dateDiffOp = todo;
export function applyOperation(_op: string, _args: readonly CalcValue[], _params: OperationParams): CalcValue { return todo([]); }
