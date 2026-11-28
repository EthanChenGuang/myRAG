import type {
  LanguageErrorCode,
  LanguageFinding,
  LanguageValidationContext,
  LanguageWarningCode,
} from './validate-language-settings.cjs';

export type LanguageChangeRefusalCode = LanguageErrorCode | 'language_baseline_missing';

export interface LanguageChangeRefusal {
  code: LanguageChangeRefusalCode;
  language?: string;
  id?: string;
  command?: string;
}

export type LanguageChangeStep =
  | { kind: 'baseline'; languages: string[]; state: 'recorded' }
  | { kind: 'save' }
  | { kind: 'rebuild'; selection: 'language_add'; mechanism: 'reparse' };

export interface LanguageChangeInput {
  current: string | readonly string[] | null | undefined;
  proposed: string | readonly string[] | null | undefined;
  primary?: string | null;
}

export interface LanguageChangeContext extends LanguageValidationContext {
  hasBaseline?: (code: string) => boolean;
}

export interface LanguageChangePlan {
  ok: boolean;
  added: string[];
  removed: string[];
  refusals: LanguageChangeRefusal[];
  warnings: LanguageFinding<LanguageWarningCode>[];
  normalized: { languages: string[]; primary: string; supported: string } | null;
  steps: LanguageChangeStep[];
  notes: Array<{ code: 'removed_documents_stay_searchable'; language: string }>;
  /** Nothing was saved before: the Phase 3.2 first choice, with no baseline rule and no rebuild. */
  firstChoice: boolean;
  rebuild: { selection: 'language_add'; mechanism: 'reparse' } | null;
}

export const BASELINE_DIR: string;
export function baselineCommand(code: string): string;
export function baselineRelativePath(code: string): string | null;
export function planLanguageChange(input: LanguageChangeInput, context: LanguageChangeContext): LanguageChangePlan;
