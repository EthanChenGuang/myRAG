import type { GateResult } from './rewrite-gate';
import type { SkippedTransform } from './plan';

/** D-23: the condense skips that leave a follow-up with only its bare text (Phase 6 D-28). */
const FALLBACK_REASONS: ReadonlySet<SkippedTransform['reason']> = new Set(['timeout', 'error', 'aborted', 'protected_token_lost']);

export interface HistoryFallbackInput {
  gate: Pick<GateResult, 'transforms'>;
  skipped: readonly SkippedTransform[];
  /** D-22: the previous user turn's stored standalone query (request metadata). */
  previousStandalone?: string | null;
  /** The previous user message text from the history window, used when no standalone query was stored. */
  previousUserText?: string | null;
  followUp: string;
  limits: { variantMaxChars: number };
}

function normalized(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * D-23: the deterministic history_fallback text, previous standalone query + newline + follow-up, or null when it does not
 * apply. The text is the caller's own (no model output), so only the variant_max_chars cap applies: the follow-up is kept
 * whole and the previous text is cut from its end, by code points, like the history window.
 */
export function buildHistoryFallbackVariant(input: HistoryFallbackInput): string | null {
  if (!input.gate.transforms.includes('condense_history')) return null;
  if (!input.skipped.some((entry) => entry.transform === 'condense_history' && FALLBACK_REASONS.has(entry.reason))) return null;
  const followUp = input.followUp.trim();
  const previous = input.previousStandalone?.trim() || input.previousUserText?.trim() || '';
  if (!followUp || !previous || normalized(previous) === normalized(followUp)) return null;
  const room = input.limits.variantMaxChars - Array.from(followUp).length - 1;
  if (room < 1) return null;
  const points = Array.from(previous);
  const head = points.length <= room ? previous : points.slice(0, room).join('').trimEnd();
  return head ? `${head}\n${followUp}` : null;
}

/** The previous user turn in the history window (oldest first), or null. */
export function previousUserTurn(history: ReadonlyArray<{ role: string; content: string }>): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn?.role === 'user' && turn.content.trim()) return turn.content;
  }
  return null;
}
