export function normalizeUnit(unit: string | null | undefined): string {
  return typeof unit === 'string' ? unit : '';
}

export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  return a === b;
}
