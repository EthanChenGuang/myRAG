import type { OutputLinkPolicy, CompiledOutputGuardRules } from './link-targets';

export type OutputGuardMode = 'flag' | 'enforce';

export interface OutputGuardPolicy {
  mode: OutputGuardMode;
  links: OutputLinkPolicy;
  placeholder: string;
  rules?: CompiledOutputGuardRules;
  bounds?: { url?: number; linkText?: number };
}

export interface OutputGuardLinkSummary {
  mode: OutputGuardMode;
  rules_version: string;
  links_checked: number;
  links_removed: number;
  credential_blocked: number;
  credential_warned: number;
  rule_ids: string[];
  readonly removedTargets: readonly string[];
}

export interface OutputGuard {
  push(textId: string, delta: string): string;
  flush(textId: string): string;
  summary(): OutputGuardLinkSummary;
}

function emptySummary(policy: OutputGuardPolicy): OutputGuardLinkSummary {
  return {
    mode: policy.mode,
    rules_version: 'stub',
    links_checked: 0,
    links_removed: 0,
    credential_blocked: 0,
    credential_warned: 0,
    rule_ids: [],
    removedTargets: [],
  };
}

export function createOutputGuard(policy: OutputGuardPolicy): OutputGuard {
  return { push: (_id, delta) => delta, flush: () => '', summary: () => emptySummary(policy) };
}

export function guardWholeText(text: string, policy: OutputGuardPolicy): { text: string; summary: OutputGuardLinkSummary } {
  return { text, summary: emptySummary(policy) };
}
