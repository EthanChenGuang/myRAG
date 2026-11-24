import { loadIngestConfig } from './config';
import { getIngestDeps } from './deps';
import { REGISTERED_STAGES, runIngestStages } from './runner';
import { createIngestTrace, finishIngestTrace } from './trace';
import {
  DEFAULT_INGEST_DEADLINE_MS,
  emptyIngestState,
  type IngestInput,
  type IngestResult,
  type StageContext,
} from './types';
import { createIngestWriter } from './writer';

export { getIngestStatus, resumeIngest } from './status';
export type { IngestStatusView, ResumeIngestOptions } from './status';
export { currentIngestConfig } from './current-config';
export { buildSourceKey } from './identity';
export type {
  IngestInput,
  IngestOptions,
  IngestOrigin,
  IngestResult,
  IngestSource,
  IngestStatus,
} from './types';

/**
 * The one entry point of the unified ingestion pipeline: turns an upload into a ready, current version of
 * its document, scoped to the tenant that minted `scope`.
 */
export async function ingest(input: IngestInput): Promise<IngestResult> {
  const deps = getIngestDeps();
  const db = deps.db();
  if (!db) {
    console.error('[Ingest] admin client unavailable');
    return { status: 'failed', documentId: null, version: null, parserUsed: null, chunkCount: 0, warnings: [], reason: 'db_unavailable' };
  }

  const ctx: StageContext = {
    input,
    deps,
    writer: createIngestWriter({ db, scope: input.scope, signal: input.signal }),
    config: loadIngestConfig(deps.ingestEnv()),
    signal: input.signal,
    deadline: deps.now() + (input.deadlineMs ?? DEFAULT_INGEST_DEADLINE_MS),
    state: emptyIngestState(),
    warnings: [],
    identity: null,
    document: null,
    parserUsed: null,
    work: { parseText: null, parserVersion: null, chunks: [], chunksWritten: 0 },
  };
  const trace = createIngestTrace(input.scope, input.trace);
  const result = await runIngestStages(ctx, REGISTERED_STAGES, { trace });
  if (trace?.owned) finishIngestTrace(trace, result);
  return result;
}
