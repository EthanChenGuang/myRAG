/**
 * An identifier-shaped token: letters, digits and - _ . / with at least one digit
 * (invoice numbers, tax ids, model numbers). The lookbehind limits the lookahead to the start of a run,
 * and the tail keeps trailing punctuation out, so matching stays linear on hostile text.
 */
export const IDENTIFIER_PATTERN = /(?<![A-Z0-9._/-])(?=[A-Z0-9._/-]*\d)[A-Z0-9](?:[A-Z0-9._/-]*[A-Z0-9])?/giu;

export interface IdentifierSplit {
  text: string;
  identifier: boolean;
  /** Set only on a piece matched by an extra (tenant) pattern rather than the built-in one. */
  extra?: true;
}

interface Span {
  start: number;
  end: number;
  extra: boolean;
}

function globalPattern(pattern: RegExp): RegExp {
  return pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
}

function collectSpans(text: string, pattern: RegExp, extra: boolean, out: Span[]): void {
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    const start = match.index ?? 0;
    out.push({ start, end: start + match[0].length, extra });
  }
}

function piecesFromSpans(text: string, spans: readonly Span[]): IdentifierSplit[] {
  const out: IdentifierSplit[] = [];
  let last = 0;
  for (const span of spans) {
    if (span.start < last) continue;
    if (span.start > last) out.push({ text: text.slice(last, span.start), identifier: false });
    const piece: IdentifierSplit = { text: text.slice(span.start, span.end), identifier: true };
    if (span.extra) piece.extra = true;
    out.push(piece);
    last = span.end;
  }
  if (last < text.length) out.push({ text: text.slice(last), identifier: false });
  return out;
}

/**
 * Cuts text into identifier and non-identifier pieces in order. Callers normalise (NFKC) first.
 * Extra patterns (compiled with 'giu') merge with the built-in one leftmost-longest; on a tie the built-in wins.
 */
export function splitAtIdentifiers(text: string, extraPatterns?: readonly RegExp[]): IdentifierSplit[] {
  const spans: Span[] = [];
  collectSpans(text, IDENTIFIER_PATTERN, false, spans);
  if (extraPatterns && extraPatterns.length > 0) {
    for (const pattern of extraPatterns) collectSpans(text, globalPattern(pattern), true, spans);
    spans.sort((a, b) => a.start - b.start || b.end - a.end || Number(a.extra) - Number(b.extra));
  }
  return piecesFromSpans(text, spans);
}

export function extractIdentifiers(text: string, extraPatterns?: readonly RegExp[]): string[] {
  return splitAtIdentifiers(text, extraPatterns)
    .filter((piece) => piece.identifier)
    .map((piece) => piece.text);
}
