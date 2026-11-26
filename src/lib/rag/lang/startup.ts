import { DEFAULT_PIPELINE, shippedDefaultPipeline } from '../config';
import { getRagDeps } from '../deps';
import { DEFAULT_INGEST_PIPELINE } from '../ingest/config';
import { LANGUAGES_NOT_CONFIGURED, resolvePipelines, type PipelineResolution, type ShippedPipelineDefaults } from './resolve';
import { getLanguageSettings, validateConfiguredLanguages } from './settings';

export const SHIPPED_PIPELINE_DEFAULTS: ShippedPipelineDefaults = { retrieval: DEFAULT_PIPELINE, ingest: DEFAULT_INGEST_PIPELINE };

/** The shipped defaults in force at call time, so the startup check and the request resolver judge an unset variable alike. */
export function shippedPipelineDefaults(): ShippedPipelineDefaults {
  return { retrieval: shippedDefaultPipeline(), ingest: DEFAULT_INGEST_PIPELINE };
}

let checked = false;

/**
 * D-02 startup check: one log when an unset pipeline variable serves legacy because the languages are not chosen,
 * and one warning per path that answers languages_not_configured. Logs at most once per process; never throws.
 */
export function verifyLanguageSettingsAtStartup(defaults: ShippedPipelineDefaults = shippedPipelineDefaults()): PipelineResolution | null {
  if (checked) return null;
  checked = true;
  try {
    const resolution = resolvePipelines(getRagDeps().rawPipelineEnv(), defaults, getLanguageSettings);
    if (resolution.servedLegacyBecauseUnset) console.warn('[RAG Languages] not configured — serving legacy');
    const blocked = [
      ...(resolution.retrieval.pipeline === LANGUAGES_NOT_CONFIGURED ? ['RAG_PIPELINE'] : []),
      ...(resolution.ingest.pipeline === LANGUAGES_NOT_CONFIGURED ? ['RAG_INGEST_PIPELINE'] : []),
    ];
    for (const variable of blocked) {
      const errors = validateConfiguredLanguages().errors.map((error) => error.code);
      console.warn(`[RAG Languages] ${variable} asks for the new pipeline but the supported languages are not configured; it answers ${LANGUAGES_NOT_CONFIGURED}`, {
        variable,
        errors,
      });
    }
    return resolution;
  } catch (error) {
    console.error('[RAG Languages] startup language check failed', { error: error instanceof Error ? error.name : 'unknown' });
    return null;
  }
}

export function resetLanguageStartupCheckForTests(): void {
  checked = false;
}

export async function verifyLanguagesAgainstEmbeddingProfileAtStartup(): Promise<null> {
  return null;
}

export function resetLanguageEmbeddingStartupCheckForTests(): void {}
