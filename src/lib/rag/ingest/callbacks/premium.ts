import type { IngestionJob, ParseExternalRequest, ParseExternalResponse, ParseResult } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '../../tenant/scope';
import {
  CloudRefused,
  assertCloudAllowed,
  release,
  reservePremium,
  settle,
  type CloudRefusal,
  type Reservation,
} from '../guard/cloud-budget';
import { getObjectStore } from '../object-store';
import { getLlamaParseParser, tierFor } from '../parsers/llamaparse-v2';
import { ParserError, type ParseAttempt, type PendingJob } from '../parsers/shared';
import { getProcessingProfile } from '../profiles/load';
import { lookupParseCache, putParseResult } from '../parse-cache';
import type { IngestState } from '../types';
import type { CallbackResult } from './common';
import { PARSE_SLICE_MS } from './parse-external';

const PENDING_RETRY_MS = 2_000;
import { decodePremiumContinuation, encodePremiumContinuation } from './premium-continuation';

export const PREMIUM_CACHE_PARSER = 'llamaparse';

interface PremiumCursor {
  original_pages: number[];
  reserve_pages?: number;
}

interface PremiumBudgetState {
  reserved?: boolean;
  handle?: Reservation;
}

function premiumState(state: IngestState): PremiumBudgetState {
  const slot = (state as IngestState & { parseExternalPremium?: PremiumBudgetState }).parseExternalPremium;
  return slot ?? {};
}

function parseCursor(raw: string | null | undefined): PremiumCursor | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as PremiumCursor;
    if (!Array.isArray(parsed.original_pages) || parsed.original_pages.length === 0) return null;
    if (!parsed.original_pages.every((page) => Number.isInteger(page) && page >= 1)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pageMap(cursor: PremiumCursor): Map<number, number> {
  return new Map(cursor.original_pages.map((original, index) => [index + 1, original]));
}

function subpdfPrefix(job: IngestionJob): string | null {
  if (!job.file_sha256) return null;
  return `${job.tenant_key}/_parse-cache/${job.file_sha256}/`;
}

function refused(workerId: string, reason: CloudRefusal): CallbackResult<ParseExternalResponse> {
  return { status: 200, body: { worker_id: workerId, status: 'refused', reason } as ParseExternalResponse };
}

function pageTexts(result: ParseResult, pageMapBySub: Map<number, number>): ParseExternalResponse['pages'] {
  const sections = result.markdown.split(/\n\n+/).filter((part) => part.trim() !== '');
  const pages: NonNullable<ParseExternalResponse['pages']> = [];
  for (let sub = 1; sub <= pageMapBySub.size; sub += 1) {
    const original = pageMapBySub.get(sub);
    if (original === undefined) continue;
    const text = (sections[sub - 1] ?? sections[0] ?? '').trim();
    pages.push({ page: original, text, has_table: /\|.+\|/.test(text) && text.includes('| ---') });
  }
  return pages;
}

function premiumVersion(): string {
  const tier = tierFor(process.env.LLAMACLOUD_PARSING_MODE);
  return `llamaparse-v2/${tier}@latest`;
}

async function releaseOpen(handle: Reservation | null, signal: AbortSignal): Promise<void> {
  if (!handle) return;
  await release(handle, { signal }).catch(() => undefined);
}

/**
 * Premium mode: guarded LlamaParse on a worker-supplied sub-PDF with page remapping and resumable polling (D-18, D-19, D-53).
 */
export async function handlePremiumMode(
  job: IngestionJob,
  body: ParseExternalRequest,
  scope: TenantScope,
  options: { signal: AbortSignal; now: () => number; state: IngestState },
): Promise<CallbackResult<ParseExternalResponse>> {
  const { signal, now, state } = options;
  const jobId = job.id;
  if (!body.options_hash) return { status: 400, body: { error: 'options_hash_required' } };
  if (!body.subpdf_ref || !body.pages) return { status: 400, body: { error: 'premium_fields_required' } };

  const gate = assertCloudAllowed('parse');
  if (!gate.ok) return refused(body.worker_id, gate.reason);

  const prefix = subpdfPrefix(job);
  if (!prefix || !body.subpdf_ref.startsWith(prefix)) return { status: 400, body: { error: 'subpdf_ref_invalid' } };

  const cacheHit = await lookupParseCache(jobId, PREMIUM_CACHE_PARSER, premiumVersion(), body.options_hash, signal);
  if (cacheHit && body.continuation === null) {
    return { status: 200, body: { worker_id: body.worker_id, status: 'done', cache_id: cacheHit.id } as ParseExternalResponse };
  }

  const cursor = parseCursor(body.cursor);
  if (!cursor) return { status: 400, body: { error: 'cursor_invalid' } };
  const pageMapBySub = pageMap(cursor);

  let continuationJob: PendingJob | null = null;
  if (body.continuation) {
    const decoded = decodePremiumContinuation(body.continuation, jobId);
    if (!decoded) return { status: 400, body: { error: 'continuation_invalid' } };
    continuationJob = { parser: 'llamaparse', jobId: decoded.llamaJobId, submittedAt: new Date(now()).toISOString(), attempt: decoded.attemptNo };
  }

  let pdfBytes: Uint8Array | null = null;
  if (continuationJob === null) {
    const stored = await getObjectStore().get(body.subpdf_ref, { signal });
    if (!stored) return { status: 400, body: { error: 'subpdf_unavailable' } };
    pdfBytes = stored.bytes;
  }

  const budget = premiumState(state);
  let reservation = budget.handle ?? null;
  const reservePages = cursor.reserve_pages ?? cursor.original_pages.length;

  if (continuationJob === null && !budget.reserved) {
    const result = await reservePremium(
      {
        jobId,
        attemptNo: body.attempt_no,
        pages: reservePages,
        estUsd: job.est_cost_usd ?? 0,
        routing: job.settings.routing,
        queued: true,
      },
      { signal },
    );
    if (!result.ok) return refused(body.worker_id, result.reason);
    reservation = result.handle;
    (state as IngestState & { parseExternalPremium?: PremiumBudgetState }).parseExternalPremium = {
      reserved: true,
      handle: reservation ?? undefined,
    };
  }

  const parser = getLlamaParseParser();
  const pollUntil = now() + PARSE_SLICE_MS;
  const profile = getProcessingProfile(job.settings.doc_type);

  try {
    let attempt: ParseAttempt;
    try {
      attempt = await parser.parse({
        scope,
        filename: 'premium-range.pdf',
        mimeType: 'application/pdf',
        bytes: pdfBytes ?? new Uint8Array(0),
        profile,
        signal,
        now,
        deadline: now() + PARSE_SLICE_MS + 5_000,
        pollUntil,
        resume: continuationJob,
        onSubmitted: async () => undefined,
      });
    } catch (error) {
      if (error instanceof CloudRefused) return refused(body.worker_id, error.reason);
      if (error instanceof ParserError) {
        const retryable = ['network', 'timeout', 'job_lost'].includes(error.reason) || /^http_5\d\d$/.test(error.reason);
        await releaseOpen(reservation, signal);
        (state as IngestState & { parseExternalPremium?: PremiumBudgetState }).parseExternalPremium = {
          reserved: budget.reserved,
          handle: undefined,
        };
        return {
          status: 200,
          body: { worker_id: body.worker_id, status: 'failed', error_class: retryable ? 'parse_retryable' : error.reason } as ParseExternalResponse,
        };
      }
      throw error;
    }

    if (attempt.kind === 'pending') {
      const continuation = encodePremiumContinuation({ jobId, llamaJobId: attempt.job.jobId, attemptNo: attempt.job.attempt });
      return {
        status: 200,
        body: { worker_id: body.worker_id, status: 'pending', continuation, retry_after_ms: PENDING_RETRY_MS } as ParseExternalResponse,
      };
    }

    const { result } = attempt;
    const pagesSent = Math.min(cursor.original_pages.length, result.page_count);
    const entry = await putParseResult(jobId, PREMIUM_CACHE_PARSER, result.parser_version, body.options_hash, result, attempt.artifacts, signal);
    if (reservation) await settle(reservation, pagesSent, { signal });
    (state as IngestState & { parseExternalPremium?: PremiumBudgetState }).parseExternalPremium = {
      reserved: true,
      handle: undefined,
    };
    return {
      status: 200,
      body: { worker_id: body.worker_id, status: 'done', cache_id: entry.id, pages: pageTexts(result, pageMapBySub) } as ParseExternalResponse,
    };
  } catch (error) {
    await releaseOpen(reservation, signal);
    (state as IngestState & { parseExternalPremium?: PremiumBudgetState }).parseExternalPremium = {
      reserved: budget.reserved,
      handle: undefined,
    };
    throw error;
  }
}