import { JobSettingsSnapshotSchema, type IngestionJob } from '@/lib/rag-eval/contracts.generated';
import { getIngestDeps } from '../deps';
import { enqueueTranslateLedgerJob } from '../ledger';
import type { PostPublishEvent } from '../post-publish';
import { getProcessingProfile } from '../profiles/load';
import { queueConfigFromProcessEnv } from '../queue-config';
import { loadRoutingConfig } from '../routing/config';
import { buildJobSettings } from '../routing/settings-snapshot';
import { isTenantKey } from '../writer';
import { translationTargets } from './produce';

/**
 * Queued chunk translation (D-29, research Open Question 6). With RAG_INGEST_ASYNC on, the post-publish hook enqueues one ledger job of
 * kind translate per target language of the tenant; the sidecar worker claims it and the app runs it through the translate callback.
 * The job's settings are the deployment's current snapshot (the worker validates every job against it) plus target_language; its parse
 * fields are never read. Translate jobs rank below uploads, so a backlog of translations never holds up ingestion.
 */

export const TRANSLATE_JOB_PRIORITY = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TranslateEnqueueRefused extends Error {
  constructor(readonly reason: string) {
    super(`[Translation] translate job refused (${reason})`);
    this.name = 'TranslateEnqueueRefused';
  }
}

function translateJobSettings(language: string): ReturnType<typeof buildJobSettings> {
  const profile = getProcessingProfile('general');
  if (!profile.min_tier || !profile.max_tier) throw new TranslateEnqueueRefused('profile_missing_tier_bounds');
  const snapshot = buildJobSettings({
    queueConfig: queueConfigFromProcessEnv(),
    profile,
    bounds: { min_tier: profile.min_tier, max_tier: profile.max_tier },
    routingConfig: loadRoutingConfig(),
  });
  const checked = JobSettingsSnapshotSchema.safeParse({ ...snapshot, target_language: language });
  if (!checked.success) throw new TranslateEnqueueRefused('invalid_target_language');
  return { ...snapshot, target_language: checked.data.target_language };
}

/** The published document's source (the ledger's source column takes the same values); null for another tenant's or an unknown id. */
async function documentSource(tenantKey: string, documentId: string, signal: AbortSignal): Promise<string | null> {
  const db = getIngestDeps().db();
  if (!db) throw new TranslateEnqueueRefused('db_unavailable');
  const response = await db.rpc('rag_get_ingest_origin', { p_document_id: documentId, p_tenant_key: tenantKey }).abortSignal(signal);
  if (response.error) throw new TranslateEnqueueRefused('origin_unavailable');
  const rows = (Array.isArray(response.data) ? response.data : response.data ? [response.data] : []) as Array<Record<string, unknown>>;
  const source = rows[0]?.source;
  return typeof source === 'string' && source ? source : null;
}

/** One job for the document and language; enqueuing again returns the job that is still open (the ledger function dedupes). */
export async function enqueueTranslateJob(tenantKey: string, documentId: string, language: string, options: { signal: AbortSignal }): Promise<IngestionJob> {
  if (!isTenantKey(tenantKey)) throw new TranslateEnqueueRefused('invalid_tenant_key');
  if (!UUID.test(documentId)) throw new TranslateEnqueueRefused('invalid_document_id');
  const id = documentId.toLowerCase();
  const settings = translateJobSettings(language);
  const source = await documentSource(tenantKey, id, options.signal);
  if (!source) throw new TranslateEnqueueRefused('document_not_found');
  return enqueueTranslateLedgerJob(tenantKey, { documentId: id, source, settings, priority: TRANSLATE_JOB_PRIORITY }, { signal: options.signal });
}

/** The post-publish hook under asynchronous ingestion: a job per target of the tenant, nothing when the gate refuses. Never throws. */
export async function enqueueTranslateJobs(event: PostPublishEvent, signal: AbortSignal): Promise<IngestionJob[]> {
  const targets = await translationTargets(event.tenantKey, signal);
  if (!targets.ok) return [];
  const jobs: IngestionJob[] = [];
  for (const language of targets.targets) {
    try {
      jobs.push(await enqueueTranslateJob(event.tenantKey, event.documentId, language, { signal }));
    } catch (error) {
      console.warn('[Translation] translate job not enqueued', {
        documentId: event.documentId,
        language,
        error: error instanceof TranslateEnqueueRefused ? error.reason : error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  if (jobs.length > 0) console.log('[Translation] translate jobs enqueued', { documentId: event.documentId, jobs: jobs.length });
  return jobs;
}
