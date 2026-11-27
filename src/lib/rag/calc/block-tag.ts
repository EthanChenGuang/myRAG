/**
 * Phase 5.2.1 D-72: the tags around the trailing calculation block that models without tool support write at the end of an
 * answer. ASCII, angle-bracket form; passed to instructions.calculation_block as {open} and {close}.
 */
export const CALC_BLOCK_OPEN = '<calc_trace>';
export const CALC_BLOCK_CLOSE = '</calc_trace>';

/** RED stub. */
export function neutralizeCalcTags(text: string): { text: string; count: number } {
  return { text, count: 0 };
}
