/**
 * An identifier-shaped token: letters, digits and - _ . / with at least one digit
 * (invoice numbers, tax ids, model numbers). The lookbehind limits the lookahead to the start of a run,
 * and the tail keeps trailing punctuation out, so matching stays linear on hostile text.
 */
export const IDENTIFIER_PATTERN = /(?<![A-Z0-9._/-])(?=[A-Z0-9._/-]*\d)[A-Z0-9](?:[A-Z0-9._/-]*[A-Z0-9])?/giu;

export interface IdentifierSplit {
  text: string;
  identifier: boolean;
}

/**
 * Cuts text into identifier and non-identifier pieces in order. Callers normalise (NFKC) first.
 */
export function splitAtIdentifiers(text: string, extraPatterns?: readonly RegExp[]): IdentifierSplit[] {
  void extraPatterns;
  const out: IdentifierSplit[] = [];
  let last = 0;
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start), identifier: false });
    out.push({ text: match[0], identifier: true });
    last = start + match[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), identifier: false });
  return out;
}

export function extractIdentifiers(text: string, extraPatterns?: readonly RegExp[]): string[] {
  return splitAtIdentifiers(text, extraPatterns)
    .filter((piece) => piece.identifier)
    .map((piece) => piece.text);
}
