import type { IngestionJob, TranslateCallbackRequest, TranslateCallbackResponse } from '@/lib/rag-eval/contracts.generated';
import { getIngestDeps } from '../deps';
import { advanceJob, failJob, getJobInternal } from '../ledger';
import { translateDocumentChunks, type TranslationRunResult } from '../translate/produce';
import { isTerminal, leaseHolds, mapError, refuse, type CallbackResult } from './common';

/**
 * The share of the worker's deadline in which new chunks are started; the rest covers the chunk in flight, its vectors and the writes.
 * There is no hard abort: an aborted run would lose the page it has not written yet. Pages are small, so each slice writes often.
 */
const BUDGET_SHARE = 0.5;
const SLICE_PAGE_SIZE = 4;

type Reply = CallbackResult<TranslateCallbackResponse>;

function answer(workerId: string, body: Pick<TranslateCallbackResponse, 'outcome'> & Partial<Omit<TranslateCallbackResponse, 'worker_id' | 'outcome'>>): Reply {
  return { status: 200, body: { worker_id: workerId, status: null, remaining: null, reason: null, ...body } };
}

/** A gate refusal is not a failure of the job: the tenant turned translation off, or no longer has the target. Nothing is left to do. */
const NOTHING_TO_DO = new Set(['switch_off', 'monolingual', 'languages_not_configured', 'tenant_disabled', 'no_targets']);

async function finish(job: IngestionJob, workerId: string, stageState: Record<string, unknown>, timingMs: number, signal: AbortSignal): Promise<Reply> {
  const done = await advanceJob({ jobId: job.id, worker: workerId, stage: 'ready', status: 'ready', stageState, timingMs }, { signal });
  return answer(workerId, { outcome: 'done', status: done.status, remaining: 0 });
}

/**
 * The worker's callback for a job of kind translate (D-29). The secret was checked by the route; the tenant, the document and the target
 * language come from the job row only. One call translates within its share of the worker's deadline: when chunks remain it records the
 * progress (status embedding) and answers continue, so one call never runs past the route's limit; when none remain the job is ready. A
 * model or store failure answers retry and the worker fails the job retryably under the ledger's rules. Nothing here writes the document
 * row, an ingest job, a parse attempt or a parse-cache row. Logs carry ids and counts only.
 */
export async function handleTranslateCallback(jobId: string, body: TranslateCallbackRequest, options: { signal: AbortSignal }): Promise<Reply> {
  const deps = getIngestDeps();
  const workerId = body.worker_id;
  try {
    const job = await getJobInternal(jobId, { signal: options.signal });
    if (!job) return refuse(404, 'job_not_found');
    if (job.kind !== 'translate') return refuse(409, 'kind_mismatch');
    if (isTerminal(job)) return answer(workerId, { outcome: 'done', status: job.status, reason: job.error_class ?? null });
    if (!leaseHolds(job, workerId, deps.now())) return refuse(409, 'lease_lost');

    const language = job.settings.target_language ?? null;
    if (!job.document_id || !language) {
      const failed = await failJob(jobId, workerId, 'translate_invalid_job', false, { signal: options.signal });
      return answer(workerId, { outcome: 'done', status: failed.status, reason: 'invalid_job' });
    }

    const started = deps.now();
    const result: TranslationRunResult = await translateDocumentChunks(job.document_id, job.tenant_key, {
      budgetMs: Math.floor(body.deadline_ms * BUDGET_SHARE),
      languages: [language],
      pageSize: SLICE_PAGE_SIZE,
      signal: options.signal,
    });
    const timingMs = Math.max(0, Math.round(deps.now() - started));

    if (!result.ok) {
      if (NOTHING_TO_DO.has(result.reason)) return await finish(job, workerId, { skipped: result.reason }, timingMs, options.signal);
      return answer(workerId, { outcome: 'retry', reason: result.reason });
    }
    const progress = { translated: result.translated, gaps: result.gaps, remaining: result.remaining };
    if (result.remaining === 0) return await finish(job, workerId, progress, timingMs, options.signal);
    if (result.stopped === 'time_budget') {
      await advanceJob({ jobId, worker: workerId, stage: 'embed', status: 'embedding', stageState: progress, timingMs }, { signal: options.signal });
      return answer(workerId, { outcome: 'continue', remaining: result.remaining, reason: 'time_budget' });
    }
    // model_unavailable, write_failed or a dropped request: the worker fails the job retryably; what was written stays.
    console.warn('[Translation] translate job slice stopped', { jobId, stopped: result.stopped, remaining: result.remaining });
    return answer(workerId, { outcome: 'retry', remaining: result.remaining, reason: result.stopped ?? 'incomplete' });
  } catch (error) {
    return mapError('translate', error);
  }
}
