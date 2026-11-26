import { clientText } from './answer-texts';
import { normalizeReplacements, verifySentenceRecordsSync, type SentenceOffsets, type TextReplacement } from './sentence-marks';

/**
 * SEC-06 (UI-SPEC 6.5): per part, the verified blocked ranges as replacements with `notices.credential_request_blocked`.
 * A range whose part hash is unknown or does not match is not replaced.
 */
export function blockedReplacements(
  parts: readonly string[],
  blockedRanges: readonly SentenceOffsets[] | null | undefined,
  language: string | null | undefined,
): TextReplacement[][] {
  const byPart: TextReplacement[][] = parts.map(() => []);
  if (!blockedRanges || blockedRanges.length === 0) return byPart;
  const text = clientText('notices.credential_request_blocked', language);
  if (!text) return byPart;
  for (const range of verifySentenceRecordsSync(parts, blockedRanges) ?? []) {
    byPart[range.part]?.push({ start: range.start, end: range.end, text });
  }
  return byPart.map((list, part) => normalizeReplacements(parts[part] ?? '', list));
}

function applyReplacements(text: string, replacements: readonly TextReplacement[]): string {
  let out = text;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  return out;
}

/**
 * The one display text of an answer (UI-SPEC 6.5): the part texts with verified blocked ranges replaced. Render, copy and
 * read-aloud all use it; it never contains a sentence mark.
 */
export function answerDisplayText(
  parts: readonly string[],
  blockedRanges: readonly SentenceOffsets[] | null | undefined,
  language: string | null | undefined,
): string[] {
  const replacements = blockedReplacements(parts, blockedRanges, language);
  return parts.map((text, part) => (replacements[part]!.length === 0 ? text : applyReplacements(text, replacements[part]!)));
}
