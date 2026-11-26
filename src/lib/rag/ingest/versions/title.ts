import { getLanguagePack, getLanguageRegistry } from '../../lang/registry';

/**
 * Title rules of the supersession detector (D-41). The version markers are the registry's version_markers of the document's language;
 * nothing here names a subject, a marker or a pattern of its own. A title is the file name without its extension.
 */

const SEPARATORS = /[_\-–—+~]+/gu;
const LEFTOVER = /[\p{P}\p{S}]+/gu;
const SPACES = /\s+/gu;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/u;

const compiled = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (compiled.has(pattern)) return compiled.get(pattern) ?? null;
  let regex: RegExp | null = null;
  try {
    regex = new RegExp(pattern, 'giu');
  } catch {
    regex = null;
  }
  compiled.set(pattern, regex);
  return regex;
}

/** The file name without its extension: the title the detector compares. */
export function titleOf(filename: string | null | undefined): string {
  if (typeof filename !== 'string') return '';
  const base = filename.split(/[\\/]/u).pop() ?? '';
  return base.replace(EXTENSION, '');
}

/**
 * The version markers of a language from the registry. A language the registry does not know (or none) gets the markers of every pack,
 * so an undetected language is still normalized by the registry's own patterns.
 */
export function versionMarkersFor(language: string | null | undefined): string[] {
  const code = typeof language === 'string' ? language.trim().toLowerCase() : '';
  const pack = code !== '' ? (getLanguagePack(code) ?? getLanguagePack(code.split('-')[0] ?? '')) : undefined;
  if (pack) return [...pack.version_markers];
  return [...new Set(getLanguageRegistry().packs.flatMap((entry) => entry.version_markers))];
}

function prepared(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(SEPARATORS, ' ');
}

/**
 * Removes the given version markers, then punctuation, and collapses whitespace and case. Two titles that differ only by such markers
 * normalize equal. An empty result is null and never matches.
 */
export function normalizeTitle(title: string | null | undefined, markers: readonly string[]): string | null {
  if (typeof title !== 'string') return null;
  let text = prepared(title);
  for (const marker of markers) {
    const regex = compile(marker);
    if (regex) text = text.replace(regex, ' ');
  }
  const normalized = text.replace(LEFTOVER, ' ').replace(SPACES, ' ').trim();
  return normalized === '' ? null : normalized;
}

/** Whether the title carries at least one of the given version markers. */
export function hasVersionMarker(title: string | null | undefined, markers: readonly string[]): boolean {
  if (typeof title !== 'string') return false;
  const text = prepared(title);
  return markers.some((marker) => {
    const regex = compile(marker);
    return regex !== null && text.search(regex) >= 0;
  });
}

/** The latest year found inside the title's version markers (yearPattern from the rules file), or null. */
export function titleYear(title: string | null | undefined, markers: readonly string[], yearPattern: string): number | null {
  if (typeof title !== 'string') return null;
  const year = compile(yearPattern);
  if (!year) return null;
  const text = prepared(title);
  let latest: number | null = null;
  for (const marker of markers) {
    const regex = compile(marker);
    if (!regex) continue;
    for (const match of text.matchAll(regex)) {
      for (const found of match[0].matchAll(year)) {
        const value = Number.parseInt(found[0], 10);
        if (Number.isFinite(value) && (latest === null || value > latest)) latest = value;
      }
    }
  }
  return latest;
}

/** Token overlap of two normalized titles (Jaccard); 1 means equal token sets. */
export function titleSimilarity(a: string | null, b: string | null): number {
  if (a === null || b === null) return 0;
  if (a === b) return 1;
  const left = new Set(a.split(' '));
  const right = new Set(b.split(' '));
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

export interface VersionFacts {
  /** The year marker of the title. */
  year: number | null;
  /** documents.doc_date, ISO date. */
  docDate: string | null;
  /** documents.effective_from, ISO date. */
  effectiveFrom: string | null;
}

export type Newer = 'a' | 'b';

function compare(a: number | string | null, b: number | string | null): Newer | null {
  if (a === null || b === null || a === b) return null;
  return a > b ? 'a' : 'b';
}

function isoDate(value: string | null): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/u.test(value) ? value.slice(0, 10) : null;
}

/**
 * Which document is newer: the year marker first, then doc_date, then effective_from. A step with an equal or missing value is skipped;
 * when no step decides, there is no direction and the admin chooses.
 */
export function directionFor(a: VersionFacts, b: VersionFacts): Newer | null {
  return (
    compare(a.year, b.year) ??
    compare(isoDate(a.docDate), isoDate(b.docDate)) ??
    compare(isoDate(a.effectiveFrom), isoDate(b.effectiveFrom))
  );
}
