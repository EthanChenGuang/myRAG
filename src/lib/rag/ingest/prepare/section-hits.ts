import type { TenantLineMatchVerdict, TenantLinePatternEntry } from '../../patterns/tenant-line-pattern';
import type { ResolvedSectionRules, SectionHeadingHit } from '../chunkers/rule-sections';
import type { LoadedSectionRuleSet } from '../rules/load';

export const SECTION_RULE_REASONS = ['no_heading_found', 'required_heading_missing', 'numbers_not_increasing'] as const;
export type SectionRuleReason = (typeof SECTION_RULE_REASONS)[number];

export const SECTION_HITS_CAP = { maxEntries: 5000, maxKeyLength: 1000, maxJsonBytes: 256 * 1024 } as const;
export const HEADING_PATTERN_ID_PREFIX = 'h:';

export interface HeadingCandidate {
  key: string;
  text: string;
}

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

export function headingCandidates(_markdown: string): HeadingCandidate[] {
  return [];
}

export function headingPatterns(_ruleSet: LoadedSectionRuleSet): TenantLinePatternEntry[] {
  return [];
}

export function resolveSectionHits(_args: {
  candidates: readonly HeadingInput[];
  ruleSet: LoadedSectionRuleSet;
  verdict: TenantLineMatchVerdict;
}): Record<string, SectionHeadingHit> {
  return {};
}

export function resolvedSectionRules(ruleSet: LoadedSectionRuleSet, hits: Record<string, SectionHeadingHit>): ResolvedSectionRules {
  return { rule_set_id: ruleSet.id, version: ruleSet.version, skip_toc: ruleSet.skipToc, toc_min_run: ruleSet.tocMinRun, hits };
}

export function hitsOverCap(_hits: Record<string, SectionHeadingHit>): boolean {
  return false;
}

export function checkSectionRules(
  _markdown: string,
  _rules: ResolvedSectionRules,
  _ruleSet: Pick<LoadedSectionRuleSet, 'headings' | 'requireIncreasingNumbers'>,
): SectionRuleCheck {
  return { satisfied: true, reasons: [], counts: { headings: 0, variants: 0, skipped: 0 } };
}
