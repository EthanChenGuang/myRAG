import type { GateLang } from './gate-language';

export type Lang = GateLang;
export type Transform = 'condense_history' | 'normalize_dates' | 'decompose' | 'expand' | 'translate';

export const GATE_RULE_IDS = [] as const;

export type GateRuleId = string;

export interface GateResult {
  rewrite: boolean;
  transforms: Transform[];
  reasons: GateRuleId[];
  lang: Lang;
  protectedTokens: string[];
  skipRetrieval?: boolean;
}

export interface GateContext {
  hasHistory: boolean;
  kbLang?: Lang;
  now: Date;
  kbShares?: Partial<Record<Lang, number>>;
}

export type RelativeTimeMatch = { term: string; unit: string; offset: number | null; n?: number };

export function matchRelativeTime(_q: string): RelativeTimeMatch[] {
  return [];
}

export function needsRewrite(_q: string, _ctx: GateContext): GateResult {
  return { rewrite: false, transforms: [], reasons: [], lang: 'en', protectedTokens: [] };
}
