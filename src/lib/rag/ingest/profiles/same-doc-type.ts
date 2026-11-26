/** D-41: whether two documents share a doc type (the supersession detector compares only within one type). Null never matches. */
export function sameDocType(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && a === b;
}
