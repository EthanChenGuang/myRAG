export type LanguageErrorCode =
  | 'empty_set'
  | 'unknown_language'
  | 'primary_not_in_set'
  | 'incomplete_pack'
  | 'embedding_profile_unsupported'
  | 'reranker_unsupported';

export type LanguageWarningCode = 'groundedness_not_checked';

export interface LanguageFinding<C extends string> {
  code: C;
  language?: string;
  id?: string;
}

export interface LanguageRegistryInput {
  packs: ReadonlyArray<{ code: string; [key: string]: unknown }>;
}

export interface LanguageDeclaration {
  id: string;
  supportedLanguages: readonly string[];
}

export interface LanguageValidationContext {
  registry: LanguageRegistryInput;
  reranker?: LanguageDeclaration | null;
  embeddingProfile?: LanguageDeclaration | null;
}

export interface LanguageCandidate {
  supported?: string | readonly string[] | null;
  primary?: string | null;
}

export interface LanguageValidationResult {
  ok: boolean;
  errors: LanguageFinding<LanguageErrorCode>[];
  warnings: LanguageFinding<LanguageWarningCode>[];
  verifiedAgainstActiveProfile: boolean;
  normalized: { languages: string[]; primary: string; supported: string } | null;
}

export interface NormalizedLanguageSettings {
  configured: boolean;
  languages: string[];
  primary: string | null;
  monolingual: boolean;
}

/** Phase 5.2 D-08: every fixed-text key as `<group>.<key>`. */
export const TEXT_KEYS: readonly string[];

export function parseLanguageList(raw: string | readonly string[] | null | undefined): string[];
export function normalizeLanguageSettings(
  rawSupported: string | null | undefined,
  rawPrimary: string | null | undefined,
  registry: LanguageRegistryInput,
): NormalizedLanguageSettings;
export function validateLanguageSettings(
  candidate: LanguageCandidate,
  context: LanguageValidationContext,
): LanguageValidationResult;
