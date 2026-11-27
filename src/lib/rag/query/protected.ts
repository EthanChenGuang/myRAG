import lexicon from './rewrite-gate.lexicon.json';

type TokenPattern = { regex: RegExp; group: number };

const P = lexicon.patterns;

const CODE_PATTERN: TokenPattern = { regex: new RegExp(P.exact_code, 'gu'), group: 0 };

const LITERAL_PATTERNS: readonly TokenPattern[] = [
  ...P.quoted.map((source) => ({ regex: new RegExp(source, 'gu'), group: 1 })),
  { regex: new RegExp(P.url, 'gu'), group: 0 },
  { regex: new RegExp(P.email, 'gu'), group: 0 },
  { regex: new RegExp(P.currency_amount, 'gu'), group: 0 },
  { regex: new RegExp(P.number_with_unit, 'gu'), group: 0 },
  ...P.explicit_date.map((source) => ({ regex: new RegExp(source, 'gu'), group: 0 })),
  { regex: new RegExp(P.version, 'gu'), group: 0 },
];

const TRAILING_URL_PUNCTUATION = /[.,;:!?。，；：！？]+$/u;

type Hit = { index: number; token: string };

function collect(text: string, pattern: TokenPattern, hits: Hit[]): boolean {
  const { regex, group } = pattern;
  regex.lastIndex = 0;
  let found = false;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    let token = (match[group] ?? '').trim();
    if (token.startsWith('http')) token = token.replace(TRAILING_URL_PUNCTUATION, '');
    if (token.length === 0) continue;
    hits.push({ index: match.index + (group === 0 ? 0 : match[0].indexOf(match[group] ?? '')), token });
    found = true;
  }
  return found;
}

export type ProtectedScan = {
  tokens: string[];
  hasExactCode: boolean;
  hasLiteral: boolean;
};

/** R4 codes plus R7 literals, deduplicated in first-seen order. */
export function scanProtected(text: string): ProtectedScan {
  const hits: Hit[] = [];
  const hasExactCode = collect(text, CODE_PATTERN, hits);
  let hasLiteral = false;
  for (const pattern of LITERAL_PATTERNS) {
    if (collect(text, pattern, hits)) hasLiteral = true;
  }
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const hit of hits) {
    if (seen.has(hit.token)) continue;
    seen.add(hit.token);
    tokens.push(hit.token);
  }
  return { tokens, hasExactCode, hasLiteral };
}

export function extractProtectedTokens(text: string): string[] {
  return scanProtected(text).tokens;
}

/** Every token must appear verbatim: NFC-normalized, case-sensitive, no width folding. */
export function keepsProtectedTokens(text: string, tokens: readonly string[]): boolean {
  const haystack = text.normalize('NFC');
  return tokens.every((token) => haystack.includes(token.normalize('NFC')));
}

const QUANTITY_PATTERNS: readonly RegExp[] = [
  new RegExp(P.currency_amount, 'gu'),
  new RegExp(P.number_with_unit, 'gu'),
];
const DATE_PATTERNS: readonly RegExp[] = P.explicit_date.map((source) => new RegExp(source, 'gu'));
const NOT_QUANTITY_PATTERNS: readonly RegExp[] = [new RegExp(P.version, 'gu'), new RegExp(P.exact_code, 'gu')];
const BARE_NUMBER = /(?<![\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}_.,])\d+(?:[.,]\d+)*(?!\p{N})/gu;
const FULL_WIDTH_DIGIT = /[０-９]/g;

type Span = { start: number; end: number };

function spans(text: string, regex: RegExp): Span[] {
  const out: Span[] = [];
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    out.push({ start: match.index, end: match.index + match[0].length });
  }
  return out;
}

function overlaps(span: Span, others: readonly Span[]): boolean {
  return others.some((other) => span.start < other.end && other.start < span.end);
}

/**
 * Phase 5.2.1 D-70: the quantities in `text` (amounts, numbers with units, dates and bare numbers, ASCII or full-width
 * digits) in text order, deduplicated. Version strings and exact codes are not quantities; scanProtected is unchanged.
 */
export function scanQuantities(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Full-width digits are single UTF-16 units, so the folded text keeps every offset.
  const folded = text.replace(FULL_WIDTH_DIGIT, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  const excluded = NOT_QUANTITY_PATTERNS.flatMap((regex) => spans(folded, regex));
  const found: Span[] = DATE_PATTERNS.flatMap((regex) => spans(folded, regex));
  for (const regex of QUANTITY_PATTERNS) {
    for (const span of spans(folded, regex)) if (!overlaps(span, excluded) && !overlaps(span, found)) found.push(span);
  }
  for (const span of spans(folded, BARE_NUMBER)) if (!overlaps(span, excluded) && !overlaps(span, found)) found.push(span);
  found.sort((a, b) => a.start - b.start);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const span of found) {
    const token = text.slice(span.start, span.end).trim();
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}
