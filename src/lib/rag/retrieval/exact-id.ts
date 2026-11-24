import { IDENTIFIER_PATTERN } from '../ids/shapes';
import { classifyTaxId, type TaxIdScheme } from '../ids/tax-ids';

export type ExactIdKind = 'invoice' | 'tax_id' | 'model';

export interface ExactIdToken {
  /** The text looked up: tax ids are normalised, the other kinds are as written. */
  value: string;
  kind: ExactIdKind;
  scheme?: TaxIdScheme;
}

export const MAX_EXACT_ID_TOKENS = 8;
const MAX_QUERY_CHARS = 4000;
const MIN_TOKEN_CHARS = 4;
const MAX_TOKEN_CHARS = 64;

const INVOICE_CUE = /发票|發票|账单|賬單|单据|單據|收据|收據|invoice|receipt|\bbill\b|fattura|ricevuta|nota di credito|credit note/iu;
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\d/u;
const PLAIN_NUMBER = /^\d{5,20}$/;
const TWO_GROUP_NUMBER = /^\d{1,6}[/-]\d{1,6}$/;
// Tax ids typed with spaces, which the identifier shape cannot hold; bounded so the scan stays linear.
const SPACED_TAX_ID = /(?<![\p{L}\p{N}])(?:[A-Za-z]{2} ?)?\d(?:[ .-]?\d){9,20}(?![\p{L}\p{N}])/gu;

interface Found {
  index: number;
  token: ExactIdToken;
}

function isPlainInvoiceNumber(token: string): boolean {
  if (PLAIN_NUMBER.test(token)) return true;
  return TWO_GROUP_NUMBER.test(token) && token.replace(/\D/gu, '').length >= 5;
}

function classifyIdentifier(token: string, invoiceCue: boolean): ExactIdToken | null {
  if (token.length > MAX_TOKEN_CHARS) return null;
  const tax = classifyTaxId(token);
  if (tax.valid) return { value: tax.normalized, kind: 'tax_id', scheme: tax.scheme };
  if (token.length >= MIN_TOKEN_CHARS && HAS_LETTER.test(token) && HAS_DIGIT.test(token)) {
    return { value: token, kind: invoiceCue ? 'invoice' : 'model' };
  }
  if (invoiceCue && isPlainInvoiceNumber(token)) return { value: token, kind: 'invoice' };
  return null;
}

/**
 * Identifier-shaped tokens of a question that an exact lookup can use: valid tax ids, invoice numbers and model numbers.
 * Shapes come from the lexical tokenizer, so a token matches the lexical_text written at ingestion. Plain words, years, dates and
 * amounts give nothing; a digits-only number counts as an invoice number only when the question speaks of an invoice.
 */
export function extractExactIds(query: string): ExactIdToken[] {
  const text = query.normalize('NFKC').slice(0, MAX_QUERY_CHARS);
  const invoiceCue = INVOICE_CUE.test(text);
  const found: Found[] = [];
  const spacedSpans: Array<[number, number]> = [];

  for (const match of text.matchAll(SPACED_TAX_ID)) {
    if (!/[ ]/u.test(match[0])) continue;
    const tax = classifyTaxId(match[0]);
    if (!tax.valid) continue;
    const index = match.index ?? 0;
    spacedSpans.push([index, index + match[0].length]);
    found.push({ index, token: { value: tax.normalized, kind: 'tax_id', scheme: tax.scheme } });
  }

  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const index = match.index ?? 0;
    if (spacedSpans.some(([start, end]) => index >= start && index < end)) continue;
    const token = classifyIdentifier(match[0], invoiceCue);
    if (token) found.push({ index, token });
  }

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: ExactIdToken[] = [];
  for (const { token } of found) {
    const key = token.value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
    if (out.length >= MAX_EXACT_ID_TOKENS) break;
  }
  return out;
}
