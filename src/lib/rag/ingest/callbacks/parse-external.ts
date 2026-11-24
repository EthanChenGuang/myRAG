import type { ParseExternalRequest, ParseExternalResponse } from '@/lib/rag-eval/contracts.generated';
import { scopeFromIngestionJob } from '../../tenant/ingestion-job';
import { getIngestDeps } from '../deps';
import { advanceJob, getJobInternal } from '../ledger';
import { lookupParseCache, putParseResult } from '../parse-cache';
import { buildQueuedContext } from '../queued-context';
import { createLedgerStateStore } from '../state-store';
import { parseToResult } from '../stages/parse';
import { isTerminal, leaseHolds, mapError, refuse, type CallbackResult } from './common';

/** One callback call parses for at most this long; a LlamaParse job that is still running is handed back as pending. */
export const PARSE_SLICE_MS = 40_000;
const PENDING_RETRY_MS = 2_000;

/** The parser name of a cache entry written by the fixed chain: the entry is the chain's output whichever parser answered. */
export const CHAIN_CACHE_PARSER = 'chain';

/** What the chain's output depends on besides the file and the worker's options hash: the configured parser and the job's cloud switch. */
export function chainCacheVersion(parser: string, cloudAllowed: boolean): string {
  return `chain-v1:${parser}:cloud=${cloudAllowed ? 'on' : 'off'}`;
}

function done(cacheId: string, workerId: string): CallbackResult<ParseExternalResponse> {
  return { status: 200, body: { worker_id: workerId, status: 'done', cache_id: cacheId } as ParseExternalResponse };
}

function failed(workerId: string, errorClass: string): CallbackResult<ParseExternalResponse> {
  return { status: 200, body: { worker_id: workerId, status: 'failed', error_class: errorClass } as ParseExternalResponse };
}

function pending(workerId: string, continuation: string): CallbackResult<ParseExternalResponse> {
  return {
    status: 200,
    body: { worker_id: workerId, status: 'pending', continuation, retry_after_ms: PENDING_RETRY_MS } as ParseExternalResponse,
  };
}

/**
 * The parse-external callback, chain mode. The tenant is minted from the job row, never from the body. Under fixed routing the app
 * runs the unchanged Phase 3 chain (F-9) and caches its result under the worker's options hash (F-12); a cache hit converts nothing.
 */
export async function handleParseExternal(
  jobId: string,
  body: ParseExternalRequest,
  options: { signal: AbortSignal },
): Promise<CallbackResult<ParseExternalResponse>> {
  const { signal } = options;
  const deps = getIngestDeps();
  try {
    const job = await getJobInternal(jobId, { signal });
    if (!job) return refuse(404, 'job_not_found');
    if (isTerminal(job) || !leaseHolds(job, body.worker_id, deps.now())) return refuse(409, 'lease_lost');
    if (body.mode !== 'chain') return refuse(400, 'mode_not_supported');
    if (!body.options_hash) return refuse(400, 'options_hash_required');

    const scope = await scopeFromIngestionJob(jobId, { db: deps.db, signal });
    if (!scope) return refuse(404, 'job_not_found');

    const built = await buildQueuedContext({
      job,
      scope,
      signal,
      deadlineMs: PARSE_SLICE_MS,
      withOriginal: true,
      store: createLedgerStateStore({ jobId, worker: body.worker_id, signal, now: deps.now }),
    });
    if (!built.ok) {
      if (built.reason === 'original_unavailable') return failed(body.worker_id, 'original_unavailable');
      return refuse(built.reason === 'document_not_processing' ? 409 : 404, built.reason);
    }
    const { ctx } = built;

    // A continuation is trusted only when it names the parse job this job's own state recorded.
    if (body.continuation !== null && ctx.state.parseJob?.jobId !== body.continuation) ctx.state.parseJob = null;

    const version = chainCacheVersion(ctx.config.parser, job.settings.cloud_allowed);
    // An auto-detected type is refined while parsing; a cached result carries no refinement for a first parse of this job.
    const refinable = ctx.identity?.docTypeOrigin === 'auto' && ctx.state.docTypeDetection?.refined == null;
    if (body.continuation === null && !refinable) {
      const hit = await lookupParseCache(jobId, CHAIN_CACHE_PARSER, version, body.options_hash, signal);
      if (hit) return done(hit.id, body.worker_id);
    }

    const started = deps.now();
    const outcome = await parseToResult(ctx);
    if (outcome.kind === 'stopped') {
      if (outcome.outcome.kind === 'fail') return failed(body.worker_id, outcome.outcome.reason);
      const continuation = ctx.state.parseJob?.jobId ?? 'again';
      return pending(body.worker_id, continuation);
    }

    const { result, artifacts, warnings } = outcome.parsed;
    const merged = { ...result, warnings: [...new Set([...(result.warnings ?? []), ...warnings])] };
    const entry = await putParseResult(jobId, CHAIN_CACHE_PARSER, version, body.options_hash, merged, artifacts, signal);

    ctx.state.parseJob = null;
    await advanceJob(
      {
        jobId,
        worker: body.worker_id,
        stage: 'parse',
        status: 'parsing',
        stageState: { ...ctx.state },
        timingMs: Math.max(0, Math.round(deps.now() - started)),
        fields: { parser_used: result.parser, parser_version: result.parser_version, ...(result.page_count > 0 ? { pages: result.page_count } : {}) },
      },
      { signal },
    );
    return done(entry.id, body.worker_id);
  } catch (error) {
    return mapError('parse-external', error);
  }
}
