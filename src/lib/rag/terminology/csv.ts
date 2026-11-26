import type { TerminologyKind, TerminologyMode } from './admin';

export const TERMINOLOGY_CSV_COLUMNS = [
  'canonical',
  'variants',
  'language',
  'kind',
  'mode',
  'enabled',
  'note',
  'source_language',
  'target_language',
] as const;

export interface TerminologyCsvRow {
  canonical: string;
  variants: string[];
  language: string;
  kind: TerminologyKind;
  mode: TerminologyMode;
  enabled: boolean;
  note: string | null;
  source_language: string | null;
  target_language: string | null;
}

export interface TerminologyCsvError {
  row: number;
  message: string;
}

export interface TerminologyCsvParseResult {
  rows: TerminologyCsvRow[];
  errors: TerminologyCsvError[];
  limit: boolean;
}

export function parseTerminologyCsv(_input: string): TerminologyCsvParseResult {
  return { rows: [], errors: [], limit: false };
}

export function serializeTerminologyCsv(_rows: readonly TerminologyCsvRow[]): string {
  return '';
}
