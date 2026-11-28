import type { LanguageRegistry } from '../lang/registry';
import { QUANTITY_TOKEN_PREFIX } from './options';

/** The optional `quantity` block of the language registry (D-32). */
export type QuantityNotationBlock = NonNullable<LanguageRegistry['quantity']>;

/** Unit lookup table built once; keys are NFKC lower-case, accent-folded spellings, values the unit symbol. */
export interface QuantityUnits {
  readonly units: ReadonlyMap<string, string>;
  readonly maxKeyLength: number;
  readonly decimal: ReadonlySet<string>;
  readonly grouping: ReadonlySet<string>;
  readonly separators: ReadonlySet<string>;
}

export const MAX_QUANTITY_NUMBER_CHARS = 24;
const MAX_QUANTITY_TOKEN_CHARS = 64;
const MAX_ALIAS_CHARS = 64;

const EMPTY: QuantityUnits = {
  units: new Map(),
  maxKeyLength: 0,
  decimal: new Set(),
  grouping: new Set(),
  separators: new Set(),
};

const INVALID_SYMBOL = /[\s\d'"`\\‘’‛“”]/u;
const INVALID_SEPARATOR = /[\s\p{L}\p{N}]/u;
const DIGIT = /[0-9]/;
const LETTER = /\p{L}/u;
const HAN = /\p{Script=Han}/u;
const HORIZONTAL_SPACE = /[ \t\u00a0\u2009\u202f]/u;
const COMBINING_MARKS = /\p{M}+/gu;

/** Same folding as the tokenizer's normalize (NFKC, apostrophes, lower case, accents removed). */
function foldKey(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’‛]/g, "'")
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .normalize('NFC');
}

function fail(message: string): never {
  throw new Error(`[Quantity Units] ${message}`);
}

function separatorSet(values: readonly string[], field: string): Set<string> {
  const out = new Set<string>();
  values.forEach((value, index) => {
    if ([...value].length !== 1 || INVALID_SEPARATOR.test(value)) fail(`${field} ${index} is invalid`);
    out.add(value);
  });
  return out;
}

/** Builds the unit table from the registry block and optional tenant aliases (word -> table symbol). */
export function buildQuantityUnits(
  block: QuantityNotationBlock | null | undefined,
  aliases?: Readonly<Record<string, string>> | null,
): QuantityUnits {
  if (!block) return EMPTY;
  const units = new Map<string, string>();
  block.unit_symbols.forEach((raw, index) => {
    const symbol = foldKey(raw);
    if (symbol === '' || INVALID_SYMBOL.test(symbol) || INVALID_SYMBOL.test(raw)) fail(`unit symbol ${index} is invalid`);
    if (units.has(symbol)) fail(`unit symbol ${index} repeats an earlier symbol`);
    units.set(symbol, symbol);
  });
  const symbols = new Set(units.values());
  for (const [word, target] of Object.entries(aliases ?? {})) {
    const key = foldKey(word).trim();
    const symbol = foldKey(target);
    if (key === '' || key.length > MAX_ALIAS_CHARS || units.has(key) || !symbols.has(symbol)) continue;
    units.set(key, symbol);
  }
  let maxKeyLength = 0;
  for (const key of units.keys()) maxKeyLength = Math.max(maxKeyLength, key.length);
  const decimal = separatorSet(block.decimal_separators, 'decimal separator');
  const grouping = separatorSet(block.grouping_separators, 'grouping separator');
  return { units, maxKeyLength, decimal, grouping, separators: new Set([...decimal, ...grouping]) };
}

function canonical(integer: string, fraction: string): string {
  const whole = integer.replace(/^0+(?=\d)/u, '');
  const part = fraction.replace(/0+$/u, '');
  return part === '' ? whole : `${whole}.${part}`;
}

function groupedInteger(groups: readonly string[], seps: readonly string[], units: QuantityUnits): string | null {
  if (seps.length === 0) return groups[0]!;
  const sep = seps[0]!;
  if (!units.grouping.has(sep) || seps.some((value) => value !== sep)) return null;
  const head = groups[0]!;
  if (head.length > 3 || head.startsWith('0')) return null;
  for (let i = 1; i < groups.length; i += 1) if (groups[i]!.length !== 3) return null;
  return groups.join('');
}

/** Canonical readings of one number run (digits and separators), decimal reading first (D-31). */
function readings(run: string, units: QuantityUnits): string[] {
  const groups: string[] = [];
  const seps: string[] = [];
  let current = '';
  for (const ch of run) {
    if (DIGIT.test(ch)) current += ch;
    else {
      if (current === '') return [];
      groups.push(current);
      seps.push(ch);
      current = '';
    }
  }
  if (current === '') return [];
  groups.push(current);
  if (seps.length === 0) return [canonical(groups[0]!, '')];

  const out: string[] = [];
  const last = seps[seps.length - 1]!;
  const leadingSeps = seps.slice(0, -1);
  if (units.decimal.has(last) && !leadingSeps.includes(last)) {
    const integer = groupedInteger(groups.slice(0, -1), leadingSeps, units);
    if (integer !== null) out.push(canonical(integer, groups[groups.length - 1]!));
  }
  const grouped = groupedInteger(groups, seps, units);
  if (grouped !== null) {
    const value = canonical(grouped, '');
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function blocksBoundary(ch: string | undefined): boolean {
  return ch !== undefined && LETTER.test(ch) && !HAN.test(ch);
}

function charBefore(text: string, index: number): string | undefined {
  if (index === 0) return undefined;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return String.fromCodePoint(text.codePointAt(index - 2)!);
  return text[index - 1];
}

function isRunChar(ch: string, units: QuantityUnits): boolean {
  return DIGIT.test(ch) || units.separators.has(ch);
}

function unitAt(text: string, start: number, units: QuantityUnits): string | null {
  const limit = Math.min(units.maxKeyLength, text.length - start);
  for (let length = limit; length >= 1; length -= 1) {
    const symbol = units.units.get(text.slice(start, start + length));
    if (symbol === undefined) continue;
    const next = text.codePointAt(start + length);
    if (next !== undefined && blocksBoundary(String.fromCodePoint(next))) continue;
    return symbol;
  }
  return null;
}

/**
 * Quantity tokens (`_q_<number><unit>`) of already normalised text, in order of appearance (D-31).
 * One left-to-right pass; tenant alias words are map keys, never patterns (T-03.3-902).
 */
export function quantityTokens(normalized: string, units: QuantityUnits): string[] {
  if (units.units.size === 0 || normalized === '') return [];
  const out: string[] = [];
  let i = 0;
  while (i < normalized.length) {
    if (!DIGIT.test(normalized[i]!)) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < normalized.length && isRunChar(normalized[i]!, units)) i += 1;
    const run = normalized.slice(start, i);
    const prevChar = charBefore(normalized, start);
    if (run.length > MAX_QUANTITY_NUMBER_CHARS || blocksBoundary(prevChar)) continue;
    let j = i;
    while (j < normalized.length && HORIZONTAL_SPACE.test(normalized[j]!)) j += 1;
    const symbol = unitAt(normalized, j, units);
    if (symbol === null) continue;
    for (const number of readings(run, units)) {
      const token = QUANTITY_TOKEN_PREFIX + number + symbol;
      if (token.length <= MAX_QUANTITY_TOKEN_CHARS) out.push(token);
    }
  }
  return out;
}
