import type { InjectionRuleSet } from '@/lib/rag-eval/contracts.generated';

export interface InjectionScanResult {
  matched: boolean;
  rule_ids: string[];
  snippets: string[];
}

export function parseInjectionRuleSet(raw: unknown): InjectionRuleSet {
  return raw as InjectionRuleSet;
}

export function loadInjectionRules(): InjectionRuleSet {
  return { schema_version: 1, rules: [] };
}

export function scanText(_text: string): InjectionScanResult {
  return { matched: false, rule_ids: [], snippets: [] };
}

export function resetInjectionRulesForTests(): void {}

export function setInjectionRulesForTests(_raw: unknown): void {}
