import {
  normalizeLanguageSettings,
  validateLanguageSettings,
  type LanguageDeclaration,
  type LanguageValidationResult,
  type NormalizedLanguageSettings,
} from '../../../../config/rag/validate-language-settings.cjs';
import { defaultEmbeddingProfileDeclaration, embeddingProfileDeclaration } from '../embeddings/catalog';
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

/**
 * D-02: true when both language variables are blank. It looks at presence only and never runs the reader, so a legacy caller can skip
 * getLanguageSettings() entirely while the languages are unset.
 */
export function languageVariablesUnset(): boolean {
  const { supported, primary } = rawEnv();
  return (supported ?? '').trim() === '' && (primary ?? '').trim() === '';
}

/** The reranker RAG_RERANKER selects with its declared languages; null for none (no reranker rule). */
export function activeRerankerDeclaration(): LanguageDeclaration | null {
  const id = parseRerankProviderId(process.env.RAG_RERANKER);
  return id === null ? null : { id, supportedLanguages: rerankerSupportedLanguages(id) };
}

export interface ValidateConfiguredLanguagesOptions {
  /** The embedding profile's declaration (see validateConfiguredLanguagesAgainstActiveProfile); null means not verified against it. */
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

interface ProfileRef {
  id: string;
  provider: string;
  model: string;
}

let activeProfileReader: (() => Promise<ProfileRef>) | null = null;

async function readActiveProfile(): Promise<ProfileRef> {
  if (activeProfileReader) return activeProfileReader();
  // Loaded on call: active-profile.ts reaches the ingest config, which imports this module.
  const { getActiveProfile } = await import('../embeddings/active-profile');
  return getActiveProfile();
}

export interface ActiveEmbeddingDeclaration {
  declaration: LanguageDeclaration;
  /** False when the active profile could not be read and the default profile was checked instead. */
  verified: boolean;
}

/** D-07: the active profile's declaration from the catalog; the default profile's when the registry cannot be read. */
export async function activeEmbeddingDeclaration(): Promise<ActiveEmbeddingDeclaration> {
  try {
    return { declaration: embeddingProfileDeclaration(await readActiveProfile()), verified: true };
  } catch {
    return { declaration: defaultEmbeddingProfileDeclaration(), verified: false };
  }
}

/** D-07 for the app entry point with the active embedding profile (Phase 3.2.1); never throws for an unreachable registry. */
export async function validateConfiguredLanguagesAgainstActiveProfile(): Promise<LanguageValidationResult> {
  const { declaration, verified } = await activeEmbeddingDeclaration();
  const result = validateConfiguredLanguages({ embeddingProfile: declaration });
  return verified ? result : { ...result, verifiedAgainstActiveProfile: false };
}

/** Test seam for the active profile pointer; null restores the registry read. */
export function setActiveEmbeddingProfileReaderForTests(reader: (() => Promise<ProfileRef>) | null): void {
  activeProfileReader = reader;
}

export function resetLanguageSettingsForTests(): void {
  cached = null;
}

/** Test seam: every reader call runs the trap first (the defaults test proves the legacy path never reads the settings). */
export function setLanguageSettingsTrapForTests(next: (() => never) | null): void {
  trap = next;
}

