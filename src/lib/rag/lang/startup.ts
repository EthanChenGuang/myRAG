import { DEFAULT_PIPELINE } from '../config';
import { getRagDeps } from '../deps';
import { DEFAULT_INGEST_PIPELINE } from '../ingest/config';
import { LANGUAGES_NOT_CONFIGURED, resolvePipelines, type PipelineResolution, type ShippedPipelineDefaults } from './resolve';
import { getLanguageSettings, validateConfiguredLanguages } from './settings';

export const SHIPPED_PIPELINE_DEFAULTS: ShippedPipelineDefaults = { retrieval: DEFAULT_PIPELINE, ingest: DEFAULT_INGEST_PIPELINE };

let checked = false;

/**
 * D-02 startup check: one log when an unset pipeline variable serves legacy because the languages are not chosen,
 * and one warning per path that answers languages_not_configured. Logs at most once per process; never throws.
 */
export function verifyLanguageSettingsAtStartup(defaults: ShippedPipelineDefaults = SHIPPED_PIPELINE_DEFAULTS): PipelineResolution | null {
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
