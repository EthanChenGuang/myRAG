/**
 * Phase 5.2.1 D-72: the tags around the trailing calculation block that models without tool support write at the end of an
 * answer. ASCII, angle-bracket form; passed to instructions.calculation_block as {open} and {close}.
 */
export const CALC_BLOCK_OPEN = '<calc_trace>';
export const CALC_BLOCK_CLOSE = '</calc_trace>';

const TAG_NAME = /<(\/?calc_)(trace)/gi;

/**
 * Pitfall 13 for D-72: breaks the tag names in retrieved text by a space inside the name, so a document cannot plant a block
 * in the model's output. Deterministic and idempotent; the rest of the text is kept.
 */
export function neutralizeCalcTags(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(TAG_NAME, (_match, head: string, tail: string) => {
    count += 1;
    return `<${head} ${tail}`;
  });
  return count === 0 ? { text, count } : { text: out, count };
}

/** True while a calculation switch is on (plan 05.2.1-02 adds both fields to the answer-config reader). */
export function calcTagNeutralizationOn(config: { readonly calcTool?: boolean; readonly calcCheck?: boolean }): boolean {
  return config.calcTool === true || config.calcCheck === true;
}
