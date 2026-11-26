import { splitAtIdentifiers } from '../ids/shapes';
import { identifierLexicalLookupForms, lexicalRegistryRules, normalizeLexical } from '../lexical/tokenize';

export type TermLayer = 'shared' | 'workspace';
export type TermKind = 'synonym' | 'abbreviation' | 'alias' | 'identifier' | 'translation' | 'misspelling';
export type TermMode = 'one_way' | 'equivalent';

/** One effective dictionary entry as rag_term_effective returns it. */
export interface TermEntry {
  entryId: string;
  layer: TermLayer;
  canonical: string;
  variants: string[];
  normalizedVariants: string[];
  language: string;
  kind: TermKind;
  mode: TermMode;
  sourceLanguage: string | null;
  targetLanguage: string | null;
}

/** A dictionary surface found in the normalized query: [start, end) indexes into that normalized text. */
export interface RawTermMatch {
  entry: TermEntry;
  /** The normalized surface that matched (a variant, or the canonical of an equivalent entry). */
  surface: string;
  start: number;
  end: number;
}

export interface TerminologyMatcher {
  readonly size: number;
  match(text: string): RawTermMatch[];
}

interface TrieNode {
  next: Map<string, TrieNode>;
  entries: TermEntry[] | null;
}

/** One matching unit of normalized text: a single Han character or one Latin-script word (D-10, D-11). */
interface Unit {
  text: string;
  start: number;
  end: number;
  han: boolean;
}

interface Span {
  start: number;
  end: number;
}

const HAN = /\p{Script=Han}/u;
const HAN_GLOBAL = /\p{Script=Han}/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const IDENTIFIER_GAP = /^[-_./\s]{1,3}$/u;
const IDENTIFIER_SEPARATORS = /[-_./\s]/gu;
const MAX_IDENTIFIER_KEY_CHARS = 128;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const REGISTRY_RULES = lexicalRegistryRules();
const ELISION_PATTERNS = [...REGISTRY_RULES.elisionPrefixes]
  .sort((a, b) => b.length - a.length)
  .map((prefix) => new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRegExp(normalizeLexical(prefix))})`, 'gu'));
const SUFFIX_PATTERNS = REGISTRY_RULES.elisionSuffixes.map(
  (suffix) => new RegExp(`${escapeRegExp(normalizeLexical(suffix))}(?![\\p{L}\\p{N}])`, 'gu'),
);

function hanCount(text: string): number {
  return text.match(HAN_GLOBAL)?.length ?? 0;
}

function isHanOnly(text: string): boolean {
  return [...text].every((char) => HAN.test(char));
}

/** The characters the tokenizer drops as elided articles or possessive suffixes (stripElisions), as a mask. */
function elisionMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const pattern of SUFFIX_PATTERNS) {
    for (const match of text.matchAll(pattern)) mask.fill(1, match.index, match.index + match[0].length);
  }
  for (const pattern of ELISION_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const from = match.index + (match[1]?.length ?? 0);
      mask.fill(1, from, from + (match[2]?.length ?? 0));
    }
  }
  return mask;
}

/** Normalized text → units, folded the way the tokenizer folds Latin runs (D-11). Positions index the normalized text. */
function unitsOf(text: string): Unit[] {
  const mask = elisionMask(text);
  const units: Unit[] = [];
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index)!;
    const char = String.fromCodePoint(code);
    if (mask[index] === 1 || !WORD_CHAR.test(char)) {
      index += char.length;
      continue;
    }
    if (HAN.test(char)) {
      units.push({ text: char, start: index, end: index + char.length, han: true });
      index += char.length;
      continue;
    }
    const start = index;
    while (index < text.length) {
      const next = String.fromCodePoint(text.codePointAt(index)!);
      if (mask[index] === 1 || !WORD_CHAR.test(next) || HAN.test(next)) break;
      index += next.length;
    }
    units.push({ text: text.slice(start, index), start, end: index, han: false });
  }
  return units;
}

/** Identifier pieces of the normalized text (splitAtIdentifiers); a match may cover a piece whole or not at all (D-12). */
function identifierSpans(text: string): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  for (const piece of splitAtIdentifiers(text)) {
    if (piece.identifier) spans.push({ start: offset, end: offset + piece.text.length });
    offset += piece.text.length;
  }
  return spans;
}

function cutsIdentifier(spans: readonly Span[], start: number, end: number): boolean {
  for (const span of spans) {
    if (span.start >= end) break;
    if (span.end <= start) continue;
    if (start > span.start || end < span.end) return true;
  }
  return false;
}

/** The surfaces an entry matches on: its variants, plus its canonical when every member is equivalent (D-13). */
function entrySurfaces(entry: TermEntry): string[] {
  const variants = entry.normalizedVariants.length === entry.variants.length ? entry.normalizedVariants : entry.variants.map(normalizeLexical);
  const surfaces = entry.mode === 'equivalent' ? [...variants, normalizeLexical(entry.canonical)] : variants;
  return surfaces.map((surface) => normalizeLexical(surface).trim()).filter((surface) => surface.length > 0);
}

/** D-12: an identifier surface is keyed by its joined lookup form, so whole, spaced and joined spellings meet. */
function identifierKeys(surface: string): string[] {
  const keys = new Set<string>();
  for (const form of identifierLexicalLookupForms(surface)) {
    const key = form.replace(IDENTIFIER_SEPARATORS, '');
    if (key.length > 0 && key.length <= MAX_IDENTIFIER_KEY_CHARS && !HAN.test(key) && [...key].every((char) => WORD_CHAR.test(char))) keys.add(key);
  }
  return [...keys];
}

function addEntry(list: TermEntry[], entry: TermEntry): void {
  if (!list.includes(entry)) list.push(entry);
}

/**
 * Longest-match-first, left-to-right, non-overlapping matching over normalized text (D-10..D-12). Han surfaces match as
 * substrings, Latin-script surfaces as whole word sequences with elisions and possessives folded as the tokenizer folds them,
 * identifier entries by their joined lookup forms; no match cuts through an identifier. Translation pairs are never matched
 * (D-32); Han-only surfaces shorter than minHanChars are left out (D-10).
 */
export function buildMatcher(entries: readonly TermEntry[], options: { minHanChars: number }): TerminologyMatcher {
  const root: TrieNode = { next: new Map(), entries: null };
  const identifiers = new Map<string, TermEntry[]>();
  let size = 0;
  let maxIdentifierKey = 0;
  for (const entry of entries) {
    if (entry.kind === 'translation') continue;
    for (const surface of entrySurfaces(entry)) {
      if (isHanOnly(surface) && hanCount(surface) < options.minHanChars) continue;
      if (entry.kind === 'identifier') {
        for (const key of identifierKeys(surface)) {
          const list = identifiers.get(key);
          if (list) addEntry(list, entry);
          else {
            identifiers.set(key, [entry]);
            size += 1;
            maxIdentifierKey = Math.max(maxIdentifierKey, key.length);
          }
        }
        continue;
      }
      const units = unitsOf(surface);
      if (units.length === 0) continue;
      let node = root;
      for (const unit of units) {
        let child = node.next.get(unit.text);
        if (!child) {
          child = { next: new Map(), entries: null };
          node.next.set(unit.text, child);
        }
        node = child;
      }
      if (node.entries) addEntry(node.entries, entry);
      else {
        node.entries = [entry];
        size += 1;
      }
    }
  }

  return {
    size,
    match(text: string): RawTermMatch[] {
      if (size === 0 || text === '') return [];
      const normalized = normalizeLexical(text);
      const units = unitsOf(normalized);
      const idSpans = identifierSpans(normalized);
      const out: RawTermMatch[] = [];
      let index = 0;
      while (index < units.length) {
        const first = units[index]!;
        let bestEnd = -1;
        let bestEntries: TermEntry[] | null = null;

        let node: TrieNode | undefined = root;
        for (let k = index; k < units.length && node; k += 1) {
          const unit = units[k]!;
          if (k > index && unit.han && units[k - 1]!.han && units[k - 1]!.end !== unit.start) break;
          node = node.next.get(unit.text);
          if (node?.entries && !cutsIdentifier(idSpans, first.start, unit.end)) {
            bestEnd = unit.end;
            bestEntries = node.entries;
          }
        }

        if (identifiers.size > 0 && !first.han) {
          let key = '';
          for (let k = index; k < units.length; k += 1) {
            const unit = units[k]!;
            if (unit.han) break;
            if (k > index && !IDENTIFIER_GAP.test(normalized.slice(units[k - 1]!.end, unit.start))) break;
            key += unit.text;
            if (key.length > maxIdentifierKey) break;
            const found = identifiers.get(key);
            if (found && unit.end >= bestEnd && !cutsIdentifier(idSpans, first.start, unit.end)) {
              bestEnd = unit.end;
              bestEntries = found;
            }
          }
        }

        if (!bestEntries) {
          index += 1;
          continue;
        }
        const surface = normalized.slice(first.start, bestEnd);
        for (const entry of bestEntries) out.push({ entry, surface, start: first.start, end: bestEnd });
        while (index < units.length && units[index]!.start < bestEnd) index += 1;
      }
      return out;
    },
  };
}
