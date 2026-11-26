import { normalizeLexical } from '../lexical/tokenize';

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

interface Surface {
  text: string;
  entries: TermEntry[];
}

const HAN = /\p{Script=Han}/u;
const HAN_GLOBAL = /\p{Script=Han}/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;

function hanCount(text: string): number {
  return text.match(HAN_GLOBAL)?.length ?? 0;
}

function isHanOnly(text: string): boolean {
  return [...text].every((char) => HAN.test(char));
}

/** A Latin edge of a surface needs a token boundary on that side; a Han edge matches as a substring (D-10, D-11). */
function boundaryOk(text: string, start: number, end: number, surface: string): boolean {
  const first = surface[0]!;
  const last = surface[surface.length - 1]!;
  if (WORD_CHAR.test(first) && !HAN.test(first) && start > 0 && WORD_CHAR.test(text[start - 1]!) && !HAN.test(text[start - 1]!)) return false;
  if (WORD_CHAR.test(last) && !HAN.test(last) && end < text.length && WORD_CHAR.test(text[end]!) && !HAN.test(text[end]!)) return false;
  return true;
}

/** The surfaces an entry matches on: its variants, plus its canonical when every member is equivalent (D-13). */
function entrySurfaces(entry: TermEntry): string[] {
  const variants = entry.normalizedVariants.length === entry.variants.length ? entry.normalizedVariants : entry.variants.map(normalizeLexical);
  const surfaces = entry.mode === 'equivalent' ? [...variants, normalizeLexical(entry.canonical)] : variants;
  return surfaces.map((surface) => surface.trim()).filter((surface) => surface.length > 0);
}

/**
 * Longest-match-first, left-to-right, non-overlapping matching over normalized text. Translation pairs are never matched (D-32);
 * Han-only surfaces shorter than minHanChars are left out (D-10).
 */
export function buildMatcher(entries: readonly TermEntry[], options: { minHanChars: number }): TerminologyMatcher {
  const bySurface = new Map<string, Surface>();
  for (const entry of entries) {
    if (entry.kind === 'translation') continue;
    for (const surface of entrySurfaces(entry)) {
      if (isHanOnly(surface) && hanCount(surface) < options.minHanChars) continue;
      const existing = bySurface.get(surface);
      if (existing) {
        if (!existing.entries.includes(entry)) existing.entries.push(entry);
      } else {
        bySurface.set(surface, { text: surface, entries: [entry] });
      }
    }
  }
  const byFirstChar = new Map<string, Surface[]>();
  for (const surface of bySurface.values()) {
    const first = surface.text[0]!;
    const list = byFirstChar.get(first) ?? [];
    list.push(surface);
    byFirstChar.set(first, list);
  }
  for (const list of byFirstChar.values()) list.sort((a, b) => b.text.length - a.text.length || (a.text < b.text ? -1 : 1));

  return {
    size: bySurface.size,
    match(text: string): RawTermMatch[] {
      if (bySurface.size === 0 || text === '') return [];
      const normalized = normalizeLexical(text);
      const out: RawTermMatch[] = [];
      let index = 0;
      while (index < normalized.length) {
        const candidates = byFirstChar.get(normalized[index]!);
        const found = candidates?.find(
          (surface) => normalized.startsWith(surface.text, index) && boundaryOk(normalized, index, index + surface.text.length, surface.text),
        );
        if (!found) {
          index += 1;
          continue;
        }
        const end = index + found.text.length;
        for (const entry of found.entries) out.push({ entry, surface: found.text, start: index, end });
        index = end;
      }
      return out;
    },
  };
}
