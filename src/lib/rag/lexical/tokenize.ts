import rawRegistry from '../../../../config/rag/language-packs.json';
import { normalizeIdentifier } from '../ids/normalize';
import { splitAtIdentifiers, type IdentifierSplit } from '../ids/shapes';
import { parseLanguageRegistry } from '../lang/registry';
import { DICT_TOKEN_PREFIX, STEM_TOKEN_PREFIX, type LexicalOptions } from './options';
import { buildQuantityUnits, quantityTokens, type QuantityUnits } from './quantity';
import rules from './rules.json';
import { stemItalian } from './stem-it';

export const LEXICAL_VERSION = 2;

const CODE_PATTERN = new RegExp(rules.codePattern, 'giu');
const zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const HAN_OR_OTHER = /(\p{Script=Han}+)|([^\p{Script=Han}]+)/gu;
// D-11: per-language rules come from the language registry (equality with the former constants is tested).
const REGISTRY = parseLanguageRegistry(rawRegistry);
const PACKS = REGISTRY.packs;
// D-32: general unit symbols and separators; read only while the quantity option is on.
const QUANTITY_UNITS = buildQuantityUnits(REGISTRY.quantity);
const ELISION_PREFIX_LIST = PACKS.flatMap((pack) => pack.folding.elision_prefixes);
const ELISION_SUFFIX_LIST = PACKS.flatMap((pack) => pack.folding.elision_suffixes);
const ELISION_PREFIXES = [...ELISION_PREFIX_LIST].sort((a, b) => b.length - a.length);
const STOPWORDS = new Set<string>(PACKS.flatMap((pack) => pack.stopwords.lexical));
const ZH_STOP = new Set<string>(
  PACKS.filter((pack) => pack.segmentation === 'intl_segmenter_han_bigrams').flatMap((pack) => pack.stopwords.lexical),
);

const MAX_TOKEN_CHARS = 64;
const MAX_QUERY_TOKENS = 64;
/** D-55: dictionary, identifier and stem tokens lead the query list, at most this many. */
export const MAX_ADDITIVE_QUERY_TOKENS = 16;
const JOINED_SEP = /[-_./]/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function suffixPattern(suffixes: string[]): RegExp {
  if (suffixes.length === 0) return /(?!)/g;
  const body = suffixes.length === 1 ? escapeRegExp(suffixes[0]!) : `(?:${suffixes.map(escapeRegExp).join('|')})`;
  return new RegExp(`${body}\\b`, 'gi');
}

export const ENGLISH_POSSESSIVE = suffixPattern(ELISION_SUFFIX_LIST);

const STEM_IT_LANGUAGE = 'it';
const STEMMERS = new Map<string, (word: string) => string>([[STEM_IT_LANGUAGE, stemItalian]]);

function mapApostrophe(text: string): string {
  return text.replace(/[\u2018\u2019\u201B]/g, "'");
}

const COMBINING_MARKS = /\p{M}+/gu;

function foldLatin(text: string): string {
  return text
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .normalize('NFC');
}

function normalize(text: string): string {
  return foldLatin(mapApostrophe(text.normalize('NFKC')).toLowerCase());
}

/** D-09: the tokenizer's normalization (NFKC, lower case, apostrophes, accent folding); the one normalizer for dictionary text. */
export function normalizeLexical(text: string): string {
  return normalize(text);
}

function joinedForm(code: string): string {
  return code.replace(JOINED_SEP, '');
}

const ELISION_PATTERNS = ELISION_PREFIXES.map((prefix) => {
  const escaped = escapeRegExp(prefix);
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

/** Additive-token state of one call; null when no option is active (the default path). */
interface TokenizeContext {
  stem: ((word: string) => string) | null;
  /** Tenant identifier patterns (D-30); null when none are passed. */
  patterns: readonly RegExp[] | null;
  /** Normalized identifier forms for the query's additive group. */
  identifiers: string[];
  /** Folded word -> unfolded spellings in order of appearance, so the stemmer reads accents (D-55). */
  unfolded: Map<string, string[]>;
  /** Chunk side keeps stem tokens next to their word; the query side lists them first. */
  interleave: boolean;
  additive: string[];
}

const UNFOLDED_WORD = /(?:(?!\p{Script=Han})[\p{L}\p{M}\p{N}])+/gu;
const HAS_LETTER = /\p{L}/u;

function unfoldedWords(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const match of text.matchAll(UNFOLDED_WORD)) {
    const word = match[0];
    const key = foldLatin(word);
    const queue = out.get(key);
    if (queue) queue.push(word);
    else out.set(key, [word]);
  }
  return out;
}

function emitStem(piece: string, out: string[], ctx: TokenizeContext): void {
  if (!ctx.stem || !HAS_LETTER.test(piece)) return;
  const source = ctx.unfolded.get(piece)?.shift() ?? piece;
  const token = STEM_TOKEN_PREFIX + foldLatin(ctx.stem(source));
  if (!acceptsToken(token)) return;
  if (ctx.interleave) out.push(token);
  ctx.additive.push(token);
}

function foldLatinRun(run: string, ctx: TokenizeContext | null): string[] {
  const out: string[] = [];
  const folded = stripElisions(foldLatin(run));
  for (const part of folded.matchAll(LATIN_WORD)) {
    const raw = part[0] ?? '';
  const token = stripElisions(raw);
    const pieces = token.split("'").map((slice) => slice.trim()).filter(Boolean);
    for (const piece of pieces) {
      if (pushToken(piece, out) && ctx) emitStem(piece, out, ctx);
    }
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

function segmentNonCode(text: string, ctx: TokenizeContext | null): string[] {
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
      for (const part of foldLatinRun(run[2], ctx)) out.push(part);
    }
  }
  return out;
}

function acceptsToken(token: string): boolean {
  if (token === '' || token.length > MAX_TOKEN_CHARS || FORBIDDEN.test(token)) return false;
  if (STOPWORDS.has(token)) return false;
  return !SINGLE_LATIN_LETTER.test(token);
}

function pushToken(token: string, out: string[]): boolean {
  if (!acceptsToken(token)) return false;
  out.push(token);
  return true;
}

const FORBIDDEN = /['\\\s]/;
const SINGLE_LATIN_LETTER = /^[a-z]$/u;

const HAS_WHITESPACE = /\s/u;

/**
 * D-30: the normalized form joins the tokens when no whole or joined form already equals it; a tenant match is
 * always listed for the query's additive group. Pitfall 12: a match with whitespace has no other form.
 */
function emitNormalizedIdentifier(piece: IdentifierSplit, out: string[], start: number, ctx: TokenizeContext): void {
  const norm = normalizeIdentifier(piece.text);
  if (!acceptsToken(norm)) return;
  const already = out.indexOf(norm, start) !== -1;
  if (!already) out.push(norm);
  if (!ctx.interleave && (piece.extra || !already)) ctx.identifiers.push(norm);
}

function tokenizeNormalized(text: string, ctx: TokenizeContext | null = null): string[] {
  const out: string[] = [];
  const patterns = ctx?.patterns ?? undefined;
  for (const piece of splitAtIdentifiers(text, patterns)) {
    if (piece.identifier) {
      const start = out.length;
      if (!(piece.extra && HAS_WHITESPACE.test(piece.text))) {
        extractCodeTokens(piece.text, out);
        if (piece.text.length <= 128 && /[-_./]/u.test(piece.text) && CODE_LIKE.test(piece.text)) {
          for (const part of segmentCodeParts(piece.text)) out.push(part);
        }
      }
      if (ctx?.patterns) emitNormalizedIdentifier(piece, out, start, ctx);
    } else {
      for (const part of segmentNonCode(piece.text, ctx)) out.push(part);
    }
  }
  return out;
}

const HAN_CHAR = /\p{Script=Han}/gu;
const WHITESPACE_RUN = /\s+/gu;
const APOSTROPHE = /'/g;

/** D-08: Han terms of two or more characters, Latin terms of more than one word or with an elision. */
function qualifiesAsDictionaryTerm(term: string): boolean {
  if ((term.match(HAN_CHAR)?.length ?? 0) >= 2) return true;
  return /\s/u.test(term) || term.includes("'");
}

function dictionaryTokens(normalized: string, options: LexicalOptions | undefined): string[] {
  const dictionary = options?.dictionary;
  if (!dictionary) return [];
  const out: string[] = [];
  for (const { term } of dictionary.match(normalized)) {
    const form = normalize(term).trim();
    if (!qualifiesAsDictionaryTerm(form)) continue;
    pushToken(DICT_TOKEN_PREFIX + form.replace(WHITESPACE_RUN, '_').replace(APOSTROPHE, '_'), out);
  }
  return out;
}

const aliasUnits = new WeakMap<object, QuantityUnits>();

function quantityUnitsFor(quantity: LexicalOptions['quantity']): QuantityUnits | null {
  if (!quantity) return null;
  if (quantity === true) return QUANTITY_UNITS;
  const aliases = quantity.unitAliases;
  if (!aliases || Object.keys(aliases).length === 0) return QUANTITY_UNITS;
  let units = aliasUnits.get(aliases);
  if (!units) {
    units = buildQuantityUnits(REGISTRY.quantity, aliases);
    aliasUnits.set(aliases, units);
  }
  return units;
}

/** D-31: quantity tokens of the normalised whole text; empty unless the option is on. */
function quantityTokensFor(normalized: string, options: LexicalOptions | undefined): string[] {
  const units = quantityUnitsFor(options?.quantity);
  if (!units) return [];
  return quantityTokens(normalized, units).filter(acceptsToken);
}

function stemmerFor(options: LexicalOptions | undefined): ((word: string) => string) | null {
  if (options?.stemIt !== true || options.language !== STEM_IT_LANGUAGE) return null;
  return lexicalStemmerAvailable(options.language) ? STEMMERS.get(options.language)! : null;
}

function contextFor(text: string, options: LexicalOptions | undefined, interleave: boolean): TokenizeContext | null {
  const stem = stemmerFor(options);
  const patterns = options?.identifierPatterns && options.identifierPatterns.length > 0 ? options.identifierPatterns : null;
  if (!stem && !patterns) return null;
  const unfolded = stem ? unfoldedWords(mapApostrophe(text.normalize('NFKC')).toLowerCase()) : new Map<string, string[]>();
  return { stem, patterns, identifiers: [], unfolded, interleave, additive: [] };
}

/** Shared tokenizer for index-side lexical_text (order and duplicates kept by lexicalText). */
export function lexicalTokens(text: string, options?: LexicalOptions): string[] {
  if (text === '') return [];
  const normalized = normalize(text);
  const tokens = tokenizeNormalized(normalized, contextFor(text, options, true));
  const additive = [...dictionaryTokens(normalized, options), ...quantityTokensFor(normalized, options)];
  return additive.length === 0 ? tokens : [...tokens, ...additive];
}

export function lexicalText(prefix: string[], content: string, options?: LexicalOptions): string {
  const tokens = [...prefix.flatMap((part) => lexicalTokens(part, options)), ...lexicalTokens(content, options)];
  return tokens.join(' ');
}

export function queryLexicalTokens(text: string, options?: LexicalOptions): string[] {
  if (text === '') return [];
  const normalized = normalize(text);
  const ctx = contextFor(text, options, false);
  const natural = tokenizeNormalized(normalized, ctx);
  const seen = new Set<string>();
  const out: string[] = [];
  const additive = [
    ...dictionaryTokens(normalized, options),
    ...(ctx?.identifiers ?? []),
    ...quantityTokensFor(normalized, options),
    ...(ctx?.additive ?? []),
  ];
  for (const token of additive) {
    if (out.length >= MAX_ADDITIVE_QUERY_TOKENS) break;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  for (const token of natural) {
    if (out.length >= MAX_QUERY_TOKENS) break;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** Whole and joined lexical forms for an identifier string (exact-id lookup). */
export function identifierLexicalLookupForms(raw: string, options?: LexicalOptions): string[] {
  const normalized = normalize(raw);
  const joined = joinedForm(normalized);
  const fromQuery = new Set(queryLexicalTokens(raw, options));
  const allowed = new Set([normalized, joined]);
  const out: string[] = [];
  for (const token of fromQuery) {
    if (allowed.has(token)) out.push(token);
  }
  if (!out.includes(normalized)) out.push(normalized);
  if (joined !== normalized && !out.includes(joined)) out.push(joined);
  return out;
}

/** The per-language rules the tokenizer reads from the registry (D-11 equality test). */
export function lexicalRegistryRules(): {
  stopwords: Set<string>;
  hanStopwords: Set<string>;
  elisionPrefixes: string[];
  elisionSuffixes: string[];
  foldAccents: boolean;
} {
  return {
    stopwords: new Set(STOPWORDS),
    hanStopwords: new Set(ZH_STOP),
    elisionPrefixes: [...ELISION_PREFIX_LIST],
    elisionSuffixes: [...ELISION_SUFFIX_LIST],
    foldAccents: PACKS.every((pack) => pack.folding.accents),
  };
}

/** True when the registry knows the language and an in-repo stemmer exists for it. */
export function lexicalStemmerAvailable(language: string | null | undefined): boolean {
  if (!language || !STEMMERS.has(language)) return false;
  return PACKS.some((pack) => pack.code === language);
}
