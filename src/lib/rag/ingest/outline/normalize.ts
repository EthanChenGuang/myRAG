import { FENCE, HEADING } from '../chunkers/markdown-sections';
import type { CompiledOutline, SectionOutlineInput, SectionOutlineReport } from './schema';

interface Occurrence {
  start: number;
  end: number;
  section: number;
  text: string;
}

interface Variant {
  kept: Occurrence[];
  opener: Occurrence | null;
}

export interface NormalizedOutline {
  markdown: string;
  report: SectionOutlineReport | null;
}

const MAX_LABEL_CHARS = 120;
const SENTENCE_MARK = /[.!?。！？]/u;
const HEADING_PREFIX = /^ {0,3}#{1,6}[ \t]+$/;

function pickOutline(text: string, input: SectionOutlineInput): CompiledOutline | null {
  const tenant = input.tenantKey === null ? null : input.tenantKey.toLowerCase();
  for (const outline of input.outlines ?? []) {
    if (outline.tenantKeys !== null && (tenant === null || !outline.tenantKeys.includes(tenant))) continue;
    if (outline.detect.test(text.slice(0, outline.withinChars))) return outline;
  }
  return null;
}

/** Start offset of every line and whether it is protected: fenced code (fence lines included) and table rows. */
function lineMap(text: string): { starts: number[]; protectedLines: boolean[] } {
  const starts: number[] = [];
  const protectedLines: boolean[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    starts.push(offset);
    offset += line.length + 1;
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      protectedLines.push(true);
      continue;
    }
    protectedLines.push(fence !== null || line.trim().startsWith('|'));
  }
  return { starts, protectedLines };
}

function lineIndexOf(starts: readonly number[], position: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= position) low = mid;
    else high = mid - 1;
  }
  return low;
}

function findOccurrences(text: string, outline: CompiledOutline, starts: number[], protectedLines: boolean[]): Occurrence[] {
  const all: Occurrence[] = [];
  outline.sections.forEach((section, index) => {
    const pattern = new RegExp(section.pattern.source, section.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[0] === '') {
        pattern.lastIndex += 1;
        continue;
      }
      if (protectedLines[lineIndexOf(starts, match.index)]) continue;
      all.push({ start: match.index, end: match.index + match[0].length, section: index, text: match[0] });
    }
  });
  all.sort((a, b) => a.start - b.start || b.end - a.end || a.section - b.section);
  const result: Occurrence[] = [];
  let lastEnd = -1;
  for (const occurrence of all) {
    if (occurrence.start < lastEnd) continue;
    result.push(occurrence);
    lastEnd = occurrence.end;
  }
  return result;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** A prefix counts only as whole words, followed by nothing but spaces and punctuation up to the marker. */
function isCrossReference(text: string, occurrence: Occurrence, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    const from = Math.max(0, occurrence.start - (prefix.length + 4));
    const at = text.slice(from, occurrence.start).toLowerCase().lastIndexOf(prefix);
    if (at < 0) return false;
    const start = from + at;
    const before = start > 0 ? (text[start - 1] ?? '') : '';
    return !WORD_CHAR.test(before) && !WORD_CHAR.test(text.slice(start + prefix.length, occurrence.start));
  });
}

/**
 * A run of markers in outline order within the span limit that names more than half of the level-1 keys is a contents list (PD-3).
 * The run ends at the first marker that does not move forward in the outline, so the tail of one variant and the head of the next
 * never form a run.
 */
function dropTocRuns(occurrences: Occurrence[], outline: CompiledOutline, maxSpan: number): Occurrence[] {
  const levelOne = new Set(outline.sections.filter((section) => section.level === 1).map((section) => section.key));
  const kept: Occurrence[] = [];
  let i = 0;
  while (i < occurrences.length) {
    const first = occurrences[i] as Occurrence;
    const seen = new Set<number>([first.section]);
    let j = i;
    while (j + 1 < occurrences.length) {
      const next = occurrences[j + 1] as Occurrence;
      if (next.end - first.start > maxSpan || next.section <= (occurrences[j] as Occurrence).section) break;
      seen.add(next.section);
      j += 1;
    }
    let named = 0;
    for (const section of seen) if (levelOne.has(outline.sections[section]?.key ?? '')) named += 1;
    if (j > i && named > levelOne.size / 2) {
      i = j + 1;
      continue;
    }
    kept.push(first);
    i += 1;
  }
  return kept;
}

/** Longest strictly increasing run of section positions; of equal lengths, the one whose occurrences come first (PD-2). */
function longestIncreasing(occurrences: readonly Occurrence[]): Occurrence[] {
  const n = occurrences.length;
  if (n === 0) return [];
  const best = new Array<number>(n).fill(1);
  for (let k = n - 1; k >= 0; k -= 1) {
    const position = (occurrences[k] as Occurrence).section;
    for (let m = k + 1; m < n; m += 1) {
      if ((occurrences[m] as Occurrence).section > position) best[k] = Math.max(best[k] ?? 1, (best[m] ?? 1) + 1);
    }
  }
  let remaining = Math.max(...best);
  let previous = -1;
  const run: Occurrence[] = [];
  for (let k = 0; k < n && remaining > 0; k += 1) {
    const occurrence = occurrences[k] as Occurrence;
    if (occurrence.section > previous && best[k] === remaining) {
      run.push(occurrence);
      previous = occurrence.section;
      remaining -= 1;
    }
  }
  return run;
}

function splitVariants(occurrences: readonly Occurrence[], variantStart: number): Variant[] {
  const groups: Occurrence[][] = [[]];
  for (const occurrence of occurrences) {
    if (occurrence.section === variantStart) groups.push([occurrence]);
    else groups[groups.length - 1]?.push(occurrence);
  }
  const variants: Variant[] = [];
  groups.forEach((group, index) => {
    if (index === 0) {
      const kept = longestIncreasing(group);
      if (kept.length > 0) variants.push({ kept, opener: null });
      return;
    }
    const opener = group[0] as Occurrence;
    const later = group.slice(1).filter((occurrence) => occurrence.section > variantStart);
    variants.push({ kept: [opener, ...longestIncreasing(later)], opener });
  });
  return variants;
}

function labelOf(text: string, variant: Variant, number: number, mode: CompiledOutline['variantLabel'], nextStart: number): string {
  const fallback = `Variant ${number}`;
  const opener = variant.opener;
  if (opener === null) return fallback;
  const from = mode === 'title' ? opener.start : opener.end;
  let end = Math.min(nextStart, text.length);
  const lineBreak = text.indexOf('\n', opener.end);
  if (lineBreak !== -1) end = Math.min(end, lineBreak);
  for (let k = opener.end; k < end; k += 1) {
    if (SENTENCE_MARK.test(text[k] ?? '') && (k + 1 >= text.length || /\s/u.test(text[k + 1] ?? ''))) {
      end = k;
      break;
    }
  }
  let label = text
    .slice(from, Math.max(from, end))
    .replace(/\s+/gu, ' ')
    .replace(/^[#\s]+/u, '')
    .trim();
  if (label !== '' && SENTENCE_MARK.test(label[label.length - 1] ?? '')) label = label.slice(0, -1).trimEnd();
  label = Array.from(label).slice(0, MAX_LABEL_CHARS).join('').trim();
  return label === '' ? fallback : label;
}

function cutOf(text: string, occurrence: Occurrence): number {
  const lineStart = text.lastIndexOf('\n', occurrence.start - 1) + 1;
  return HEADING_PREFIX.test(text.slice(lineStart, occurrence.start)) ? lineStart : occurrence.start;
}

/** PD-5: an existing heading below an outline heading of level `level` gets one hash mark more than it, at most six. */
function relevel(body: string, level: number): string {
  let fence: string | null = null;
  const hashes = '#'.repeat(Math.min(6, level + 2));
  return body
    .split('\n')
    .map((line) => {
      const fenceMatch = FENCE.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1] ?? '```';
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const heading = HEADING.exec(line);
      const title = heading ? (heading[2] ?? '').trim() : '';
      return heading && title !== '' ? `${hashes} ${title}` : line;
    })
    .join('\n');
}

/**
 * Turns the numbered section markers of the first matching outline into Markdown headings: contents runs and cross-references are
 * dropped, each restart at variant_start is one variant under its own level-1 heading. Pure; the input comes back unchanged with a
 * null report when no outline applies or no marker is kept (PD-1).
 */
export function normalizeWithOutline(markdown: string, input: SectionOutlineInput | null | undefined): NormalizedOutline {
  if (!input || !input.outlines || input.outlines.length === 0) return { markdown, report: null };
  const text = markdown.replace(/\r\n?/g, '\n');
  const outline = pickOutline(text, input);
  if (outline === null) return { markdown, report: null };

  const { starts, protectedLines } = lineMap(text);
  const found = findOccurrences(text, outline, starts, protectedLines);
  let remaining = found.filter((occurrence) => !isCrossReference(text, occurrence, outline.crossRefPrefixes));
  if (outline.tocMaxSpanChars !== null) remaining = dropTocRuns(remaining, outline, outline.tocMaxSpanChars);
  const variants = splitVariants(remaining, outline.variantStart);
  const kept = variants.flatMap((variant) => variant.kept);
  if (kept.length === 0) return { markdown, report: null };

  const labels = variants.map((variant, index) => {
    const next = variant.opener === null ? text.length : (variant.kept[1]?.start ?? variants[index + 1]?.kept[0]?.start ?? text.length);
    return labelOf(text, variant, index + 1, outline.variantLabel, next);
  });

  const parts: string[] = [];
  const lead = text.slice(0, cutOf(text, kept[0] as Occurrence)).trimEnd();
  if (lead !== '') parts.push(lead);
  const firstOfVariant = new Map<Occurrence, string>();
  variants.forEach((variant, index) => firstOfVariant.set(variant.kept[0] as Occurrence, labels[index] ?? ''));
  kept.forEach((occurrence, index) => {
    const level = outline.sections[occurrence.section]?.level ?? 1;
    const label = firstOfVariant.get(occurrence);
    if (label !== undefined && variants.length > 1) parts.push(`# ${label}`);
    parts.push(`${'#'.repeat(level + 1)} ${occurrence.text.replace(/\s+/gu, ' ').trim()}`);
    const next = kept[index + 1];
    const raw = text.slice(occurrence.end, next ? cutOf(text, next) : text.length);
    const body = relevel(next ? raw.trim() : raw.trimStart(), level);
    if (body !== '') parts.push(body);
  });

  return {
    markdown: parts.join('\n\n'),
    report: {
      outline_id: outline.id,
      version: outline.version,
      variants: labels,
      markers_found: found.length,
      markers_kept: kept.length,
      markers_dropped: found.length - kept.length,
    },
  };
}
