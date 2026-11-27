import type { GateResult } from './rewrite-gate';
import type { SkippedTransform } from './plan';

export interface HistoryFallbackInput {
  gate: Pick<GateResult, 'transforms'>;
  skipped: readonly SkippedTransform[];
  previousStandalone?: string | null;
  previousUserText?: string | null;
  followUp: string;
  limits: { variantMaxChars: number };
}

export function buildHistoryFallbackVariant(_input: HistoryFallbackInput): string | null {
  return null;
}
