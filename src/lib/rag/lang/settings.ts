import {
  normalizeLanguageSettings,
  validateLanguageSettings,
  type LanguageDeclaration,
  type LanguageValidationResult,
  type NormalizedLanguageSettings,
} from '../../../../config/rag/validate-language-settings.cjs';
import { parseRerankProviderId, rerankerSupportedLanguages } from '../rerank/languages';
import { getLanguageRegistry } from './registry';

export type LanguageSettings = NormalizedLanguageSettings;

let cached: LanguageSettings | null = null;
let trap: (() => never) | null = null;

function rawEnv(): { supported: string | undefined; primary: string | undefined } {
  return { supported: process.env.RAG_SUPPORTED_LANGUAGES, primary: process.env.RAG_PRIMARY_LANGUAGE };
}

/** D-01: the only reader of RAG_SUPPORTED_LANGUAGES and RAG_PRIMARY_LANGUAGE. Never throws on a bad value. */
export function getLanguageSettings(): LanguageSettings {
  if (trap) trap();
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

/** The reranker RAG_RERANKER selects with its declared languages; null for none (no reranker rule). */
export function activeRerankerDeclaration(): LanguageDeclaration | null {
  const id = parseRerankProviderId(process.env.RAG_RERANKER);
  return id === null ? null : { id, supportedLanguages: rerankerSupportedLanguages(id) };
}

export interface ValidateConfiguredLanguagesOptions {
  /** Phase 3.2.1 (03.2.1-01) passes the active embedding profile; null means not verified against it. */
  embeddingProfile?: LanguageDeclaration | null;
}

/** D-07 for the app entry point: the configured values against the registry and the active reranker. */
export function validateConfiguredLanguages(options: ValidateConfiguredLanguagesOptions = {}): LanguageValidationResult {
  if (trap) trap();
  const { supported, primary } = rawEnv();
  return validateLanguageSettings(
    { supported, primary },
    { registry: getLanguageRegistry(), reranker: activeRerankerDeclaration(), embeddingProfile: options.embeddingProfile ?? null },
  );
}

export function resetLanguageSettingsForTests(): void {
  cached = null;
}

/** Test seam: every reader call runs the trap first (the defaults test proves the legacy path never reads the settings). */
export function setLanguageSettingsTrapForTests(next: (() => never) | null): void {
  trap = next;
}
