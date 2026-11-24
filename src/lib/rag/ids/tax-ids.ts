export type TaxIdScheme = 'it_iva' | 'cn_uscc' | 'eu_vat' | 'unknown';

export interface TaxIdCheck {
  scheme: TaxIdScheme;
  valid: boolean;
  normalized: string;
}

export function normalizeTaxId(raw: string): string {
  return raw;
}

export function isValidPartitaIva(_raw: string): boolean {
  return false;
}

export function isValidUscc(_raw: string): boolean {
  return false;
}

export function isValidEuVat(_raw: string): boolean {
  return false;
}

export function classifyTaxId(raw: string): TaxIdCheck {
  return { scheme: 'unknown', valid: false, normalized: raw };
}
