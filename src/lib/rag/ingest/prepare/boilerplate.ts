import { createHash } from 'node:crypto';
import type { BoilerplateReport, BoilerplateRulesConfig } from '@/lib/rag-eval/contracts.generated';
import { FENCE, HEADING } from '../chunkers/markdown-sections';
import { countTokens } from '../text/tokens';
import { boilerplateConfig } from './boilerplate-config';
import { lineKey, type PageLines } from './page-lines';

/**
 * Page boilerplate cleaning (TPL-02, D-13 to D-16). Pure: the same Markdown, page lines, hit data and thresholds always give the same bytes,
 * removal record and report. Tenant line patterns are run elsewhere; their matches arrive here as line texts and are stored as digests only.
 */

export const CLEANER_VERSION = 1;

export const BOILERPLATE_PAGES_UNAVAILABLE = 'boilerplate_pages_unavailable';

export type BoilerplateMode = 'detect' | 'rules' | 'both';

export interface BoilerplateFragmentRule {
  max_length: number;
  min_page_share: number;
}

/** Sorted normalised keys removed by detect and the fragment rule, and sorted digests of the lines removed as line hits. */
export interface BoilerplateRemoval {
  keys: string[];
  lineDigests: string[];
}

type TextList = ReadonlySet<string> | readonly string[];

export interface CleanBoilerplateInput {
  markdown: string;
  pageLines: PageLines | null;
  mode: BoilerplateMode;
  config?: BoilerplateRulesConfig;
  lineHits?: TextList;
  fragmentRules?: readonly BoilerplateFragmentRule[];
  protectedLines?: TextList;
}

export interface CleanBoilerplateResult {
  markdown: string;
  removal: BoilerplateRemoval;
  report: BoilerplateReport;
  aboveReviewShare: boolean;
  warnings: string[];
}

export interface ReplayResult {
  markdown: string;
  report: BoilerplateReport;
  aboveReviewShare: boolean;
}

/** First 16 hexadecimal characters of the SHA-256 of the trimmed text. */
export function lineDigest(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 16);
}

function safeTokens(text: string): number {
  if (text === '') return 0;
  try {
    return countTokens(text);
  } catch {
    try {
      return countTokens(text.replace(/<\|/g, '< |'));
    } catch {
      return Math.ceil(text.length / 4);
    }
  }
}

const trimmedSet = (values: TextList | undefined): Set<string> => {
  const out = new Set<string>();
  if (!values) return out;
  for (const value of values) if (typeof value === 'string') out.add(value.trim());
  return out;
};

const isBlank = (text: string): boolean => text.trim() === '';
const isTableRow = (text: string): boolean => text.trim().startsWith('|');

interface Line {
  text: string;
  eol: string;
}

function splitLines(markdown: string): Line[] {
  const lines: Line[] = [];
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = breaks.exec(markdown)) !== null) {
    lines.push({ text: markdown.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: markdown.slice(start), eol: '' });
  return lines;
}

interface WalkResult {
  markdown: string;
  linesRemoved: number;
  tokensRemoved: number;
  usedKeys: Set<string>;
  usedDigests: Set<string>;
}

/** The one line walk of cleaning, replay and the text map: protection first, then removal by key or digest, then blank-line repair. */
function walk(markdown: string, keys: ReadonlySet<string>, digests: ReadonlySet<string>, protectedSet: ReadonlySet<string>): WalkResult {
  const usedKeys = new Set<string>();
  const usedDigests = new Set<string>();
  const result: WalkResult = { markdown, linesRemoved: 0, tokensRemoved: 0, usedKeys, usedDigests };
  if (markdown === '' || (keys.size === 0 && digests.size === 0)) return result;

  const lines = splitLines(markdown);
  const kept: Line[] = [];
  let fence: string | null = null;
  let pending = false;
  let lastRemoved = false;

  for (const line of lines) {
    const { text } = line;
    const fenceMatch = FENCE.exec(text);
    let isProtected = false;
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? '```';
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      isProtected = true;
    } else if (fence !== null) {
      isProtected = true;
    } else {
      const heading = HEADING.exec(text);
      if (heading && (heading[2] ?? '').trim() !== '') isProtected = true;
    }
    const trimmed = text.trim();
    if (!isProtected && (isTableRow(text) || protectedSet.has(trimmed))) isProtected = true;

    let removed = false;
    if (!isProtected && trimmed !== '') {
      const key = lineKey(text);
      if (keys.has(key)) {
        usedKeys.add(key);
        removed = true;
      } else if (digests.size > 0) {
        const digest = lineDigest(trimmed);
        if (digests.has(digest)) {
          usedDigests.add(digest);
          removed = true;
        }
      }
    }

    if (removed) {
      result.linesRemoved += 1;
      result.tokensRemoved += safeTokens(text);
      pending = true;
      lastRemoved = true;
      continue;
    }
    const previous = kept[kept.length - 1];
    if (pending && isBlank(text) && (previous === undefined || isBlank(previous.text))) {
      pending = false;
      lastRemoved = true;
      continue;
    }
    pending = false;
    lastRemoved = false;
    kept.push(line);
  }

  if (result.linesRemoved === 0) return result;
  if (pending && kept.length > 0 && isBlank(kept[kept.length - 1]!.text)) kept.pop();
  if (lastRemoved && kept.length > 0) {
    const finalEol = lines[lines.length - 1]!.eol;
    const tail = kept[kept.length - 1]!;
    kept[kept.length - 1] = { text: tail.text, eol: finalEol === '' ? '' : tail.eol };
  }
  result.markdown = kept.map((line) => line.text + line.eol).join('');
  return result;
}

function reportOf(input: string, walked: WalkResult, config: BoilerplateRulesConfig): { report: BoilerplateReport; aboveReviewShare: boolean } {
  const total = safeTokens(input);
  const raw = total === 0 ? 0 : walked.tokensRemoved / total;
  const share = Math.min(1, Math.round(raw * 10000) / 10000);
  const report: BoilerplateReport = {
    cleaner_version: CLEANER_VERSION,
    rules_version: config.rules_version,
    lines_removed: walked.linesRemoved,
    tokens_removed: walked.tokensRemoved,
    share,
  };
  return { report, aboveReviewShare: share > config.review_share };
}

function pageCounts(pageLines: PageLines, edgeLines: number | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { keys } of pageLines.pages) {
    const seen = new Set<string>();
    if (edgeLines === null) {
      for (const key of keys) seen.add(key);
    } else {
      for (const key of keys.slice(0, edgeLines)) seen.add(key);
      for (const key of keys.slice(Math.max(0, keys.length - edgeLines))) seen.add(key);
    }
    for (const key of seen) if (key !== '') counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function cleanBoilerplate(input: CleanBoilerplateInput): CleanBoilerplateResult {
  const config = input.config ?? boilerplateConfig();
  const { markdown, pageLines, mode } = input;
  const fragmentRules = mode === 'detect' ? [] : (input.fragmentRules ?? []);
  const warnings: string[] = [];
  const candidateKeys = new Set<string>();

  if (pageLines === null) {
    if (mode !== 'rules' || fragmentRules.length > 0) warnings.push(BOILERPLATE_PAGES_UNAVAILABLE);
  } else if (pageLines.pageCount >= config.min_pages && pageLines.pageCount > 0) {
    const total = pageLines.pageCount;
    if (mode !== 'rules') {
      for (const [key, count] of pageCounts(pageLines, config.edge_lines)) {
        if (count / total >= config.page_share && safeTokens(key) <= config.max_line_tokens) candidateKeys.add(key);
      }
    }
    if (fragmentRules.length > 0) {
      const counts = pageCounts(pageLines, null);
      for (const rule of fragmentRules) {
        const maxLength = Math.min(rule.max_length, config.fragment_max_length);
        const minShare = Math.max(rule.min_page_share, config.fragment_page_share);
        for (const [key, count] of counts) {
          if ([...key].length <= maxLength && count / total >= minShare) candidateKeys.add(key);
        }
      }
    }
  }

  const candidateDigests = new Set<string>();
  if (mode !== 'detect') {
    for (const hit of trimmedSet(input.lineHits)) if (hit !== '') candidateDigests.add(lineDigest(hit));
  }

  const walked = walk(markdown, candidateKeys, candidateDigests, trimmedSet(input.protectedLines));
  const removal: BoilerplateRemoval = { keys: [...walked.usedKeys].sort(), lineDigests: [...walked.usedDigests].sort() };
  return { markdown: walked.markdown, removal, ...reportOf(markdown, walked, config), warnings };
}

/** Applies a stored removal record again; on the original Markdown it repeats the first result byte for byte. */
export function replayRemoval(
  markdown: string,
  removal: BoilerplateRemoval,
  protectedLines: TextList = [],
  config: BoilerplateRulesConfig = boilerplateConfig(),
): ReplayResult {
  const walked = walk(markdown, new Set(removal.keys), new Set(removal.lineDigests), trimmedSet(protectedLines));
  return { markdown: walked.markdown, ...reportOf(markdown, walked, config) };
}

/** The same line removal as a text function, for parser chunk fields; it may return an empty string. */
export function removalTextMap(removal: BoilerplateRemoval, protectedLines: TextList = []): (text: string) => string {
  const keys = new Set(removal.keys);
  const digests = new Set(removal.lineDigests);
  const protectedSet = trimmedSet(protectedLines);
  return (text: string) => walk(text, keys, digests, protectedSet).markdown;
}
