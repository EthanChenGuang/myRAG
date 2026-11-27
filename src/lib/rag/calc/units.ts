/**
 * Units are opaque strings (D-69): compared after NFKC, case folding and trimming. There is no unit table and no
 * currency table; an empty or absent unit means unitless.
 */

/** NFKC, full case folding approximated by upper-then-lower case, trimmed; '' is unitless. */
export function normalizeUnit(unit: string | null | undefined): string {
  if (typeof unit !== 'string') return '';
  return unit.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC').trim();
}

export function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeUnit(a) === normalizeUnit(b);
}
