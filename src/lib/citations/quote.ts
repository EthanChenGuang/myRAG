/**
 * Smallest citation quote that counts as evidence, in Unicode code points after trimming (06.3-SECURITY W8). Two is the
 * minimum the evidence-quote contracts already use (golden evidence spans and feedback-loop spans, `min_length=2`); a
 * single code point identifies no span of a document. The empty quote stays reserved for the purge's withdrawn marker (0724).
 */
export const MIN_CITATION_QUOTE_CODE_POINTS = 2;

/** True when the quote is long enough to be stored, shown or used as a cited quote. */
export function isMatchableQuote(quote: unknown): quote is string {
  return typeof quote === 'string' && Array.from(quote.trim()).length >= MIN_CITATION_QUOTE_CODE_POINTS;
}

/** A citation's quote is valid when it is a withdrawn marker or a matchable quote. */
export function citationQuoteAllowed(citation: { quote: string; withdrawn?: boolean | undefined }): boolean {
  return citation.withdrawn === true || isMatchableQuote(citation.quote);
}
