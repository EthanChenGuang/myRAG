import { loadIngestConfig, type IngestConfig } from './config';
import { getIngestDeps } from './deps';

/** The ingest switches as the running process has them, for callers outside the pipeline that choose a write path per request. */
export function currentIngestConfig(): IngestConfig {
  return loadIngestConfig(getIngestDeps().ingestEnv());
}

/** D-02: the 503 body every unified write entry answers while an explicit unified pipeline has no chosen languages. */
export function unifiedIngestRefusal(): { error: string } | null {
  const blocked = currentIngestConfig().pipelineBlocked;
  return blocked ? { error: blocked } : null;
}
