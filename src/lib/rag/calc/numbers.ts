import type { NumberFormat } from '../lang/registry-fields';
import type { Rational } from './rational';

export interface NumberMatch {
  start: number;
  end: number;
  value: Rational;
  raw: string;
  percent: boolean;
  places: number;
  power: number;
}

export interface ScanStats {
  steps: number;
}

export function findNumbers(_text: string, _format: NumberFormat, _stats?: ScanStats): NumberMatch[] {
  return [];
}

export function formatNumber(_value: Rational, _places: number, _format: NumberFormat, _unit?: string | null): string {
  return '';
}
