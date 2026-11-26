import { TENANT_LINE_MATCH_WINDOW, type TenantLineMatchVerdict, type TenantLinePatternEntry } from '../../patterns/tenant-line-pattern';
import { FENCE, HEADING } from '../chunkers/markdown-sections';
import { scanRuleSections, type ResolvedSectionRules, type SectionHeadingHit } from '../chunkers/rule-sections';
import type { LoadedSectionRuleSet } from '../rules/load';

/**
 * Heading hits of a tenant section rule set and the conformance check (TPL-01; D-11, D-17, D-19). Tenant heading patterns run only in the
 * worker; this module maps the worker's spans to plain hit data and judges the document on the same walk the rule-section chunker cuts.
 * Heading numbers are read by a fixed scanner of the repository, never by a tenant pattern. Results hold code words and counts only.
 */

export const SECTION_RULE_REASONS = ['no_heading_found', 'required_heading_missing', 'numbers_not_increasing'] as const;
export type SectionRuleReason = (typeof SECTION_RULE_REASONS)[number];

/** The contract caps of the hit map (Pydantic side: 5000 entries, keys of 1..1000 characters), plus a size cap for the saved state. */
export const SECTION_HITS_CAP = { maxEntries: 5000, maxKeyLength: 1000, maxJsonBytes: 256 * 1024 } as const;
export const HEADING_PATTERN_ID_PREFIX = 'h:';

/** One distinct trimmed line that may be a heading: `key` as it stands in the Markdown, `text` with heading marks removed (what is matched). */
export interface HeadingCandidate {
  key: string;
  text: string;
}

/** A heading candidate placed in the worker request: `input` is its index in the request lines. */
export interface HeadingInput {
  input: number;
  key: string;
}

export interface SectionRuleCounts {
  headings: number;
  variants: number;
  skipped: number;
}

export interface SectionRuleCheck {
  satisfied: boolean;
  reasons: SectionRuleReason[];
  counts: SectionRuleCounts;
}

/** Leading dotted number of a heading text, read by a fixed scanner: "2.10 Name" gives [2, 10]. */
const LEADING_NUMBER = /^(\d{1,9}(?:\.\d{1,9})*)(?=[.):\s]|$)/;

function bareText(trimmed: string): string {
  const heading = HEADING.exec(trimmed);
  const bare = heading ? (heading[2] ?? '').trim() : trimmed;
  return bare === '' ? trimmed : bare;
}

/** Distinct trimmed lines outside fenced blocks that are not table rows and fit the wrapper's match window once heading marks are removed. */
export function headingCandidates(markdown: string): HeadingCandidate[] {
  const seen = new Set<string>();
  const out: HeadingCandidate[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split(/\r\n|\r|\n/)) {
    const fenceMatch = FENCE.exec(raw);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const key = raw.trim();
    if (key === '' || key.startsWith('|') || seen.has(key)) continue;
    const text = bareText(key);
    if (text.length > TENANT_LINE_MATCH_WINDOW) continue;
    seen.add(key);
    out.push({ key, text });
  }
  return out;
}

/** The rule set's heading patterns as worker entries, in rule-set order, with ids `h:<index>`. */
export function headingPatterns(ruleSet: LoadedSectionRuleSet): TenantLinePatternEntry[] {
  return ruleSet.headings.map((heading, index) => ({ id: `${HEADING_PATTERN_ID_PREFIX}${index}`, kind: 'heading', pattern: heading.pattern, flags: heading.flags }));
}

function headingIndex(patternId: string, count: number): number | null {
  if (!patternId.startsWith(HEADING_PATTERN_ID_PREFIX)) return null;
  const rest = patternId.slice(HEADING_PATTERN_ID_PREFIX.length);
  if (!/^\d{1,3}$/.test(rest)) return null;
  const index = Number(rest);
  return index < count ? index : null;
}

/**
 * The hit map: each candidate line whose text a heading pattern matches from its first character, named by the first such pattern in
 * rule-set order. A timeout or an error gives no hit. Keys become own properties only (a line named like an object member stays data).
 */
export function resolveSectionHits(args: {
  candidates: readonly HeadingInput[];
  ruleSet: LoadedSectionRuleSet;
  verdict: TenantLineMatchVerdict;
}): Record<string, SectionHeadingHit> {
  if (args.verdict.kind !== 'ok') return {};
  const best = new Map<number, number>();
  for (const hit of args.verdict.hits) {
    if (hit.start !== 0) continue;
    const index = headingIndex(hit.patternId, args.ruleSet.headings.length);
    if (index === null) continue;
    const current = best.get(hit.inputIndex);
    if (current === undefined || index < current) best.set(hit.inputIndex, index);
  }
  const entries: Array<[string, SectionHeadingHit]> = [];
  for (const candidate of args.candidates) {
    const index = best.get(candidate.input);
    const heading = index === undefined ? undefined : args.ruleSet.headings[index];
    if (heading) entries.push([candidate.key, { name: heading.name, level: heading.level, restart: heading.restart }]);
  }
  return Object.fromEntries(entries);
}

/** The chunker's view of the rule set: plain hit data with the table-of-contents settings. */
export function resolvedSectionRules(ruleSet: LoadedSectionRuleSet, hits: Record<string, SectionHeadingHit>): ResolvedSectionRules {
  return { rule_set_id: ruleSet.id, version: ruleSet.version, skip_toc: ruleSet.skipToc, toc_min_run: ruleSet.tocMinRun, hits };
}

export function hitsOverCap(hits: Record<string, SectionHeadingHit>): boolean {
  const keys = Object.keys(hits);
  if (keys.length > SECTION_HITS_CAP.maxEntries) return true;
  if (keys.some((key) => key.length === 0 || key.length > SECTION_HITS_CAP.maxKeyLength)) return true;
  return Buffer.byteLength(JSON.stringify(hits), 'utf8') > SECTION_HITS_CAP.maxJsonBytes;
}

/** Headings that open a section, variants and skipped table-of-contents lines of the walk. */
export function sectionCounts(markdown: string, rules: ResolvedSectionRules): SectionRuleCounts {
  const scan = scanRuleSections(markdown, rules);
  const skipped = scan.events.filter((event) => event.skippedAsToc).length;
  return { headings: scan.events.length - skipped, variants: scan.variants.length, skipped };
}

function leadingNumber(text: string): number[] | null {
  const match = LEADING_NUMBER.exec(bareText(text));
  return match ? (match[1] ?? '').split('.').map(Number) : null;
}

function greater(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? -1;
    const right = b[i] ?? -1;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * Conformance of a document to its rule set on the walk of scanRuleSections, so table-of-contents runs and variants are judged exactly as
 * the chunker cuts them: some hit opens a section; every required heading opens a section (in every variant when the file has variants);
 * with increasing numbers asked for, a heading's leading number is greater than the previous same-level heading's within one variant and
 * one parent (a heading without a leading number is not compared).
 */
export function checkSectionRules(
  markdown: string,
  rules: ResolvedSectionRules,
  ruleSet: Pick<LoadedSectionRuleSet, 'headings' | 'requireIncreasingNumbers'>,
): SectionRuleCheck {
  const scan = scanRuleSections(markdown, rules);
  const opened = scan.events.filter((event) => !event.skippedAsToc);
  const counts: SectionRuleCounts = { headings: opened.length, variants: scan.variants.length, skipped: scan.events.length - opened.length };
  const reasons = new Set<SectionRuleReason>();
  if (opened.length === 0) reasons.add('no_heading_found');

  const required = new Set(ruleSet.headings.filter((heading) => heading.required).map((heading) => heading.name));
  const groups = scan.variants.length > 0
    ? scan.variants.map((variant) => opened.filter((event) => event.variantIndex === variant.index))
    : [opened];
  for (const group of groups) {
    const names = new Set(group.map((event) => event.name));
    for (const name of required) if (!names.has(name)) reasons.add('required_heading_missing');
  }

  if (ruleSet.requireIncreasingNumbers) {
    let variant: number | null = null;
    let last = new Map<number, number[]>();
    for (const event of opened) {
      if (event.variantIndex !== variant) {
        variant = event.variantIndex;
        last = new Map();
      }
      for (const level of [...last.keys()]) if (level > event.level) last.delete(level);
      const number = leadingNumber(event.text);
      if (number === null) continue;
      const previous = last.get(event.level);
      if (previous && !greater(number, previous)) reasons.add('numbers_not_increasing');
      last.set(event.level, number);
    }
  }

  const ordered = SECTION_RULE_REASONS.filter((reason) => reasons.has(reason));
  return { satisfied: ordered.length === 0, reasons: ordered, counts };
}
