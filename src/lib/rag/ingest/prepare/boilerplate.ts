import type { BoilerplateReport, BoilerplateRulesConfig } from '@/lib/rag-eval/contracts.generated';

export const CLEANER_VERSION = 0;
export interface BoilerplateRemoval {
  keys: string[];
  lineDigests: string[];
}
export function lineDigest(_text: string): string {
  return '';
}
export function cleanBoilerplate(input: { markdown: string; config: BoilerplateRulesConfig; [key: string]: unknown }): {
  markdown: string;
  removal: BoilerplateRemoval;
  report: BoilerplateReport;
  aboveReviewShare: boolean;
  warnings: string[];
} {
  return { markdown: '', removal: { keys: [], lineDigests: [] }, report: { cleaner_version: 1, rules_version: 1, lines_removed: 0, tokens_removed: 0, share: 0 }, aboveReviewShare: false, warnings: [] };
}
export function replayRemoval(_m: string, _r: BoilerplateRemoval, _p: readonly string[], _c: BoilerplateRulesConfig) {
  return { markdown: '', report: { cleaner_version: 1, rules_version: 1, lines_removed: 0, tokens_removed: 0, share: 0 }, aboveReviewShare: false };
}
export function removalTextMap(_r: BoilerplateRemoval, _p: readonly string[]): (text: string) => string {
  return () => '\u0000';
}
