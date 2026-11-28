import type { ProcessingProfile } from '../profiles/load';
import type { ChunkDraft, ChunkResult } from '../types';
import { FENCE, HEADING, type MarkdownChunkOptions } from './markdown-sections';
import { chunkTableSection } from './table-aware';

/** Resolved heading-hit data of one tenant rule set (D-17); produced in the worker, read here as plain data. */
export type ResolvedSectionRules = NonNullable<ProcessingProfile['chunker']['section_rules']>;
export type SectionHeadingHit = ResolvedSectionRules['hits'][string];

export interface RuleSectionsOptions extends MarkdownChunkOptions {
  rules?: ResolvedSectionRules | null;
}

/** One hit line of the walk, in document order. */
export interface RuleHeadingEvent {
  /** Index of the line in the document split at newlines (CRLF normalised). */
  lineIndex: number;
  /** The trimmed line text: the key of the hit. */
  text: string;
  name: string;
  level: number;
  restart: boolean;
  /** 1-based variant the line belongs to; null before the first restart occurrence or when the document has fewer than two. */
  variantIndex: number | null;
  /** Part of a table-of-contents run: the line opens no section and adds no text. */
  skippedAsToc: boolean;
}

export interface RuleSection {
  path: string[];
  lines: string[];
  /** Index into `events` of the hit that opened the section; null for the text before the first hit. */
  heading: number | null;
  variantIndex: number | null;
  variantLabel: string | null;
}

export interface RuleVariant {
  index: number;
  label: string;
  lineIndex: number;
}

export interface RuleSectionScan {
  events: RuleHeadingEvent[];
  sections: RuleSection[];
  variants: RuleVariant[];
}

export const RULE_SECTIONS_WITHOUT_RULES = 'rule_sections_without_rules';
const DEFAULT_TOC_MIN_RUN = 3;
const VARIANT_LABEL_MAX = 80;

const hasOwn = (map: object, key: string): boolean => Object.prototype.hasOwnProperty.call(map, key);
const isSeparatorRow = (line: string | undefined): boolean =>
  line !== undefined && line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
const isTableLine = (line: string, next: string | undefined): boolean =>
  line.trim().startsWith('|') || isSeparatorRow(line) || (line.includes('|') && isSeparatorRow(next));

function hitsOf(rules: ResolvedSectionRules | null | undefined): ResolvedSectionRules['hits'] | null {
  const hits = rules?.hits;
  return hits !== undefined && hits !== null && Object.keys(hits).length > 0 ? hits : null;
}

function labelOf(text: string): string {
  const heading = HEADING.exec(text);
  const bare = heading ? (heading[2] ?? '').trim() : text;
  return Array.from(bare === '' ? text : bare).slice(0, VARIANT_LABEL_MAX).join('');
}

/** Pass 1: hit lines outside fences and tables, with table-of-contents runs marked. */
function collectEvents(lines: readonly string[], hits: ResolvedSectionRules['hits'], rules: ResolvedSectionRules): RuleHeadingEvent[] {
  const events: RuleHeadingEvent[] = [];
  let fence: string | null = null;
  lines.forEach((line, lineIndex) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      return;
    }
    if (fence !== null || isTableLine(line, lines[lineIndex + 1])) return;
    const text = line.trim();
    if (text === '' || !hasOwn(hits, text)) return;
    const hit = hits[text] as SectionHeadingHit;
    events.push({ lineIndex, text, name: hit.name, level: hit.level, restart: hit.restart === true, variantIndex: null, skippedAsToc: false });
  });

  if (rules.skip_toc === false) return events;
  const minRun = rules.toc_min_run ?? DEFAULT_TOC_MIN_RUN;
  const onlyBlankBetween = (from: number, to: number): boolean => {
    for (let i = from + 1; i < to; i += 1) if ((lines[i] ?? '').trim() !== '') return false;
    return true;
  };
  let start = 0;
  while (start < events.length) {
    let end = start;
    while (end + 1 < events.length && onlyBlankBetween(events[end]!.lineIndex, events[end + 1]!.lineIndex)) end += 1;
    const run = events.slice(start, end + 1);
    // A run whose levels deepen at every step is a heading chain (a heading and its first sub-headings), not a table of contents.
    const chain = run.every((event, index) => index === 0 || event.level > run[index - 1]!.level);
    if (run.length >= minRun && !chain) for (let i = start; i < end; i += 1) events[i]!.skippedAsToc = true;
    start = end + 1;
  }
  return events;
}

function variantsOf(events: readonly RuleHeadingEvent[]): RuleVariant[] {
  const occurrences = events.filter((event) => event.restart && !event.skippedAsToc);
  if (occurrences.length < 2) return [];
  const labels = occurrences.map((event) => labelOf(event.text));
  const numbered = new Set(labels).size !== labels.length;
  return occurrences.map((event, index) => ({
    index: index + 1,
    label: numbered ? `${labels[index]} ${index + 1}` : (labels[index] ?? ''),
    lineIndex: event.lineIndex,
  }));
}

/**
 * The rule-section walk as data (D-17, D-19): which lines are headings, which were skipped as a table of contents, which variant each
 * belongs to, and the resulting sections with their paths and body lines. A line is a heading only when its trimmed text is a key of
 * `rules.hits`; nothing else (Markdown heading marks included) decides it.
 */
export function scanRuleSections(markdown: string, rules: ResolvedSectionRules | null | undefined): RuleSectionScan {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const hits = hitsOf(rules);
  if (hits === null || rules === null || rules === undefined) {
    return { events: [], sections: [{ path: [], lines, heading: null, variantIndex: null, variantLabel: null }], variants: [] };
  }

  const events = collectEvents(lines, hits, rules);
  const variants = variantsOf(events);
  const variantAt = new Map(variants.map((variant) => [variant.lineIndex, variant]));
  const eventAt = new Map(events.map((event, index) => [event.lineIndex, index]));

  const sections: RuleSection[] = [{ path: [], lines: [], heading: null, variantIndex: null, variantLabel: null }];
  let stack: Array<{ level: number; name: string }> = [];
  let variant: RuleVariant | null = null;

  lines.forEach((line, lineIndex) => {
    const eventIndex = eventAt.get(lineIndex);
    const event = eventIndex === undefined ? undefined : events[eventIndex];
    if (event === undefined || eventIndex === undefined) {
      sections[sections.length - 1]?.lines.push(line);
      return;
    }
    const started = variantAt.get(lineIndex);
    if (started !== undefined) {
      variant = started;
      stack = [];
    }
    event.variantIndex = variant?.index ?? null;
    if (event.skippedAsToc) return;
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= event.level) stack.pop();
    stack.push({ level: event.level, name: event.name });
    const names = stack.map((entry) => entry.name);
    sections.push({
      path: variant === null ? names : [variant.label, ...names],
      lines: [],
      heading: eventIndex,
      variantIndex: variant?.index ?? null,
      variantLabel: variant?.label ?? null,
    });
  });
  return { events, sections, variants };
}

/**
 * Chunker kind `rule_sections` (D-17, D-19, D-20): cuts the Markdown into the sections a tenant rule set allows, from resolved hit data
 * only, and packs each section with the table-aware section packer under the profile budget. Chunks of a variant carry the variant label
 * as the first path element and `variant_index` / `variant_label` in metadata. Chunks carry no page numbers.
 */
export function chunkRuleSections(markdown: string, options: RuleSectionsOptions): ChunkResult {
  const { rules, ...budget } = options;
  const warnings = new Set<string>();
  if (hitsOf(rules) === null) warnings.add(RULE_SECTIONS_WITHOUT_RULES);
  const chunks: ChunkDraft[] = [];
  for (const section of scanRuleSections(markdown, rules).sections) {
    const packed = chunkTableSection(section.path, section.lines, budget, warnings);
    if (section.variantIndex === null || section.variantLabel === null) {
      chunks.push(...packed);
      continue;
    }
    for (const draft of packed) {
      chunks.push({ ...draft, metadata: { ...draft.metadata, variant_index: section.variantIndex, variant_label: section.variantLabel } });
    }
  }
  return { chunks, warnings: [...warnings] };
}
