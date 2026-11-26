import type { LanguageRegistry } from '../lang/registry';

export type QuantityNotationBlock = NonNullable<LanguageRegistry['quantity']>;

export interface QuantityUnits {
  readonly size: number;
}

export function buildQuantityUnits(
  _block: QuantityNotationBlock | null | undefined,
  _aliases?: Readonly<Record<string, string>> | null,
): QuantityUnits {
  return { size: 0 };
}

export function quantityTokens(_normalized: string, _units: QuantityUnits): string[] {
  return [];
}
