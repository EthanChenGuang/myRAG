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
