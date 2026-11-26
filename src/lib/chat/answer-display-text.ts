import type { SentenceOffsets } from './sentence-marks';

export function answerDisplayText(parts: readonly string[], _blockedRanges: readonly SentenceOffsets[], _language: string): string[] {
  return [...parts];
}
