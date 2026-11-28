import { getLanguageSettings, languageVariablesUnset } from '../../lang/settings';
import type { IngestConfig } from '../config';
import { currentIngestConfig } from '../current-config';

export const LANGUAGES_NOT_CONFIGURED = 'languages_not_configured';
export const LANGUAGE_AWARE_REQUIRES_UNIFIED = 'language_aware_ingest_requires_unified_pipeline';

/** Where a knowledge-base write that would use a legacy writer goes. */
export type LegacyUploadRoute = 'legacy' | 'unified' | typeof LANGUAGES_NOT_CONFIGURED;

/**
 * D-16: with RAG_LANGUAGE_AWARE_INGEST=on the legacy writers are not patched; their uploads go to the unified pipeline, which needs chosen
 * languages. With the switch off this returns 'legacy' without reading the language settings.
 */
export function legacyUploadRoute(config: Pick<IngestConfig, 'languageAwareIngest'>): LegacyUploadRoute {
  if (config.languageAwareIngest !== 'on') return 'legacy';
  if (languageVariablesUnset() || !getLanguageSettings().configured) return LANGUAGES_NOT_CONFIGURED;
  return 'unified';
}

/** The route for the running process. A configuration that cannot be read falls back to the raw switch, so `on` never reaches a legacy writer. */
export function currentLegacyUploadRoute(): LegacyUploadRoute {
  let languageAwareIngest: IngestConfig['languageAwareIngest'];
  try {
    languageAwareIngest = currentIngestConfig().languageAwareIngest;
  } catch {
    languageAwareIngest = (process.env.RAG_LANGUAGE_AWARE_INGEST ?? '').trim().toLowerCase() === 'on' ? 'on' : 'off';
  }
  return legacyUploadRoute({ languageAwareIngest });
}

/** Thrown by a legacy writer reached while language-aware ingestion is on: its caller must use the unified pipeline. */
export class LanguageAwareIngestError extends Error {
  readonly status = 503;
  readonly code: typeof LANGUAGES_NOT_CONFIGURED | typeof LANGUAGE_AWARE_REQUIRES_UNIFIED;
  readonly reason: string;

  constructor(code: typeof LANGUAGES_NOT_CONFIGURED | typeof LANGUAGE_AWARE_REQUIRES_UNIFIED) {
    super(`[Ingest] ${code}`);
    this.name = 'LanguageAwareIngestError';
    this.code = code;
    this.reason = code;
  }
}

/** Throws before the legacy splitter runs while RAG_LANGUAGE_AWARE_INGEST=on. */
export function assertLegacySplitterAllowed(): void {
  const route = currentLegacyUploadRoute();
  if (route === 'legacy') return;
  throw new LanguageAwareIngestError(route === 'unified' ? LANGUAGE_AWARE_REQUIRES_UNIFIED : LANGUAGES_NOT_CONFIGURED);
}
