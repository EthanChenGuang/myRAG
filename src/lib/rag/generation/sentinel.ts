export const NO_ANSWER_SENTINEL = '%%NO_ANSWER_IN_CONTEXT%%';

export type SentinelState = 'pending' | 'match' | 'diverged';

export interface SentinelMatcher {
  push(delta: string): { release: string; state: SentinelState };
  flush(): { release: string; state: SentinelState };
}

export function createSentinelMatcher(): SentinelMatcher {
  return {
    push: (delta) => ({ release: delta, state: 'diverged' }),
    flush: () => ({ release: '', state: 'diverged' }),
  };
}

export interface SentinelTextResult {
  text: string;
  refused: boolean;
  strippedCount: number;
}

export function applySentinelToText(textsPerStep: readonly string[], _refusalText: string): SentinelTextResult {
  return { text: textsPerStep.join(''), refused: false, strippedCount: 0 };
}

export function neutralizeSentinel(text: string): { text: string; count: number } {
  return { text, count: 0 };
}
