import { loadIngestConfig, type IngestConfig } from './config';
import { getIngestDeps } from './deps';

/** The ingest switches as the running process has them, for callers outside the pipeline that choose a write path per request. */
export function currentIngestConfig(): IngestConfig {
  return loadIngestConfig(getIngestDeps().ingestEnv());
}
