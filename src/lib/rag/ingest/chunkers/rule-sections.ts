import type { ProcessingProfile } from '../profiles/load';
import type { ChunkResult } from '../types';
import type { MarkdownChunkOptions } from './markdown-sections';

export type ResolvedSectionRules = NonNullable<ProcessingProfile['chunker']['section_rules']>;

export interface RuleSectionsOptions extends MarkdownChunkOptions {
  rules?: ResolvedSectionRules | null;
}

export interface RuleHeadingEvent {
  lineIndex: number;
  text: string;
  name: string;
  level: number;
  restart: boolean;
  variantIndex: number | null;
  skippedAsToc: boolean;
}

export interface RuleSection {
  path: string[];
  lines: string[];
  heading: number | null;
  variantIndex: number | null;
  variantLabel: string | null;
}

export interface RuleSectionScan {
  events: RuleHeadingEvent[];
  sections: RuleSection[];
  variants: Array<{ index: number; label: string; lineIndex: number }>;
}

export function scanRuleSections(_markdown: string, _rules: ResolvedSectionRules | null | undefined): RuleSectionScan {
  return { events: [], sections: [], variants: [] };
}

export function chunkRuleSections(_markdown: string, _options: RuleSectionsOptions): ChunkResult {
  return { chunks: [], warnings: [] };
}
