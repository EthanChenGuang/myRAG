import { splitAtIdentifiers } from '../ids/shapes';
import rules from './rules.json';

export const LEXICAL_VERSION = 2;

const CODE_PATTERN = new RegExp(rules.codePattern, 'giu');
const zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const HAN_OR_OTHER = /(\p{Script=Han}+)|([^\p{Script=Han}]+)/gu;
const ELISION_PREFIXES = [...rules.elisionPrefixes].sort((a, b) => b.length - a.length);
const STOPWORDS = new Set<string>([...rules.stopwords.zh, ...rules.stopwords.en, ...rules.stopwords.it]);
const ZH_STOP = new Set<string>(rules.stopwords.zh);

const MAX_TOKEN_CHARS = 64;
const MAX_QUERY_TOKENS = 64;
const JOINED_SEP = /[-_./]/g;
const ENGLISH_POSSESSIVE = /'s\b/gi;

function mapApostrophe(text: string): string {
  return text.replace(/[\u2018\u2019\u201B]/g, "'");
}

function foldLatin(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .normalize('NFC');
}

function normalize(text: string): string {
  return foldLatin(mapApostrophe(text.normalize('NFKC')).toLowerCase());
}

function joinedForm(code: string): string {
  return code.replace(JOINED_SEP, '');
}

const ELISION_PATTERNS = ELISION_PREFIXES.map((prefix) => {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}`, 'giu');
});

function stripElisions(text: string): string {
  let out = text.replace(ENGLISH_POSSESSIVE, ' ');
  for (const pattern of ELISION_PATTERNS) out = out.replace(pattern, '$1');
  return out;
}

function extractCodeTokens(code: string, out: string[]): void {
  const whole = code;
  const joined = joinedForm(whole);
  pushToken(whole, out);
  if (joined !== whole) pushToken(joined, out);
}

const CODE_LIKE = new RegExp(rules.codePattern, 'u');

function hanBigrams(run: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of [...run]) {
    if (ZH_STOP.has(ch)) {
      if (current) {
        emitHanBigrams(current, out);
        current = '';
      }
    } else current += ch;
  }
  if (current) emitHanBigrams(current, out);
  return out;
}

const MAX_HAN_BIGRAM_RUN = 256;

function emitHanBigrams(seg: string, out: string[]): void {
  const chars = [...seg];
  if (chars.length > MAX_HAN_BIGRAM_RUN) return;
  if (chars.length === 1) {
    pushToken(chars[0]!, out);
    return;
  }
  for (let i = 0; i < chars.length - 1; i += 1) pushToken(chars[i]! + chars[i + 1]!, out);
}

const LATIN_WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?/gu;

function foldLatinRun(run: string): string[] {
  const out: string[] = [];
  const folded = stripElisions(foldLatin(run));
  for (const part of folded.matchAll(LATIN_WORD)) {
    const raw = part[0] ?? '';
  const token = stripElisions(raw);
    const pieces = token.split("'").map((slice) => slice.trim()).filter(Boolean);
    for (const piece of pieces) pushToken(piece, out);
  }
  return out;
}

function segmentCodeParts(code: string): string[] {
  const out: string[] = [];
  for (const part of zhSegmenter.segment(code)) {
    if (part.isWordLike) pushToken(part.segment.toLowerCase(), out);
  }
  return out;
}

function segmentNonCode(text: string): string[] {
  const prepared = stripElisions(text);
  const out: string[] = [];
  for (const run of prepared.matchAll(HAN_OR_OTHER)) {
    if (run[1]) {
      const han = run[1];
      for (const part of zhSegmenter.segment(han)) {
        if (part.isWordLike) pushToken(part.segment, out);
      }
      for (const bigram of hanBigrams(han)) out.push(bigram);
    } else if (run[2]) {
      for (const part of foldLatinRun(run[2])) out.push(part);
    }
  }
  return out;
}

function pushToken(token: string, out: string[]): void {
  if (token === '' || token.length > MAX_TOKEN_CHARS || FORBIDDEN.test(token)) return;
  if (STOPWORDS.has(token)) return;
  if (SINGLE_LATIN_LETTER.test(token)) return;
  out.push(token);
}

const FORBIDDEN = /['\\\s]/;
const SINGLE_LATIN_LETTER = /^[a-z]$/u;

function tokenizeNormalized(text: string): string[] {
  const out: string[] = [];
  for (const piece of splitAtIdentifiers(text)) {
    if (piece.identifier) {
      extractCodeTokens(piece.text, out);
      if (piece.text.length <= 128 && /[-_./]/u.test(piece.text) && CODE_LIKE.test(piece.text)) {
        for (const part of segmentCodeParts(piece.text)) out.push(part);
      }
    } else {
      for (const part of segmentNonCode(piece.text)) out.push(part);
    }
  }
  return out;
}

/** Shared tokenizer for index-side lexical_text (order and duplicates kept by lexicalText). */
export function lexicalTokens(text: string): string[] {
  if (text === '') return [];
  return tokenizeNormalized(normalize(text));
}

export function lexicalText(prefix: string[], content: string): string {
  const tokens = [...prefix.flatMap((part) => lexicalTokens(part)), ...lexicalTokens(content)];
  return tokens.join(' ');
}

export function queryLexicalTokens(text: string): string[] {
  if (text === '') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenizeNormalized(normalize(text))) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_QUERY_TOKENS) break;
  }
  return out;
}

/** Whole and joined lexical forms for an identifier string (exact-id lookup). */
export function identifierLexicalLookupForms(raw: string): string[] {
  const normalized = normalize(raw);
  const joined = joinedForm(normalized);
  const fromQuery = new Set(queryLexicalTokens(raw));
  const allowed = new Set([normalized, joined]);
  const out: string[] = [];
  for (const token of fromQuery) {
    if (allowed.has(token)) out.push(token);
  }
  if (!out.includes(normalized)) out.push(normalized);
  if (joined !== normalized && !out.includes(joined)) out.push(joined);
  return out;
}