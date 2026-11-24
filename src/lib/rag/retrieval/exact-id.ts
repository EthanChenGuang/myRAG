import type { TaxIdScheme } from '../ids/tax-ids';

export type ExactIdKind = 'invoice' | 'tax_id' | 'model';

export interface ExactIdToken {
  /** The text looked up: tax ids are normalised, the other kinds are as written. */
  value: string;
  kind: ExactIdKind;
  scheme?: TaxIdScheme;
}

export function extractExactIds(_query: string): ExactIdToken[] {
  return [];
}
