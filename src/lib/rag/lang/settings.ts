import {
  normalizeLanguageSettings,
  validateLanguageSettings,
  type LanguageDeclaration,
  type LanguageValidationResult,
  type NormalizedLanguageSettings,
} from '../../../../config/rag/validate-language-settings.cjs';
import { getLanguageRegistry } from './registry';

export type LanguageSettings = NormalizedLanguageSettings;

let cached: LanguageSettings | null = null;

function rawEnv(): { supported: string | undefined; primary: string | undefined } {
  return { supported: process.env.RAG_SUPPORTED_LANGUAGES, primary: process.env.RAG_PRIMARY_LANGUAGE };
}

/** D-01: the only reader of RAG_SUPPORTED_LANGUAGES and RAG_PRIMARY_LANGUAGE. Never throws on a bad value. */
export function getLanguageSettings(): LanguageSettings {
  if (cached) return cached;
  const { supported, primary } = rawEnv();
  try {
    cached = normalizeLanguageSettings(supported, primary, getLanguageRegistry());
  } catch (error) {
    console.error('[Language Settings] Could not read the language settings', {
      message: error instanceof Error ? error.message : String(error),
    });
    cached = { configured: false, languages: [], primary: null, monolingual: false };
  }
  return cached;
}

export interface ValidateConfiguredLanguagesOptions {
  reranker?: LanguageDeclaration | null;
  /** Phase 3.2.1 (03.2.1-01) passes the active embedding profile; null means not verified against it. */
  embeddingProfile?: LanguageDeclaration | null;
}

/** D-07 for the app entry point: the configured values against the registry. */
export function validateConfiguredLanguages(options: ValidateConfiguredLanguagesOptions = {}): LanguageValidationResult {
  const { supported, primary } = rawEnv();
  return validateLanguageSettings(
    { supported, primary },
    { registry: getLanguageRegistry(), reranker: options.reranker ?? null, embeddingProfile: options.embeddingProfile ?? null },
  );
}

export function resetLanguageSettingsForTests(): void {
  cached = null;
}
