import { z } from 'zod/v3';

/**
 * An inline unified upload that runs out of its request budget answers 202 with status processing and no job id. Nothing else
 * continues it, so the client calls POST /api/rag/ingest/{id}/resume (a fresh budget per call) until the version settles.
 */
export const INGEST_RESUME_MAX_ATTEMPTS = 20;
/** Calls in a row that leave the stage and chunk count unchanged (and no parse job pending) before the loop gives up. */
export const INGEST_RESUME_MAX_STALLED = 3;
export const INGEST_RESUME_BASE_DELAY_MS = 1000;
export const INGEST_RESUME_MAX_DELAY_MS = 15000;

const SETTLED = new Set(['ready', 'quarantined', 'pending_review']);
/** The resume call can never continue these: it reports processing but has no stage to start from. */
const UNRESUMABLE_REASONS = new Set(['resume_state_missing']);

const ResumeBodySchema = z.object({
  status: z.string().min(1).max(64),
  reason: z.string().max(64).nullish(),
  chunkCount: z.number().int().nonnegative().nullish(),
});

const StatusBodySchema = z.object({
  status: z.string().min(1).max(64).optional(),
  lastCompleted: z.string().max(64).nullish(),
  warnings: z.array(z.string().max(128)).max(50).optional(),
});

export interface ResumeSnapshot {
  status: string;
  reason: string | null;
  chunkCount: number;
}

export interface StageSnapshot {
  stage: string | null;
  parsePending: boolean;
}

export function parseResumeBody(body: unknown): ResumeSnapshot | null {
  const parsed = ResumeBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return { status: parsed.data.status, reason: parsed.data.reason ?? null, chunkCount: parsed.data.chunkCount ?? 0 };
}

export function parseStatusBody(body: unknown): StageSnapshot | null {
  const parsed = StatusBodySchema.safeParse(body);
  if (!parsed.success) return null;
  return { stage: parsed.data.lastCompleted ?? null, parsePending: (parsed.data.warnings ?? []).includes('parse_pending') };
}

/** True for the 202 an inline upload answers when its budget ran out: processing, a document id, no queued job. */
export function needsResume(httpStatus: number, body: unknown): boolean {
  if (httpStatus !== 202 || !body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  const id = record.documentId ?? record.id;
  return record.status === 'processing' && typeof id === 'string' && id.length > 0 && !record.jobId;
}

export function resumeDelayMs(stalled: number): number {
  return Math.min(INGEST_RESUME_BASE_DELAY_MS * 2 ** stalled, INGEST_RESUME_MAX_DELAY_MS);
}

export type ResumeCall = { ok: true; snapshot: ResumeSnapshot } | { ok: false; httpStatus: number };

export interface ResumeProgress {
  attempt: number;
  maxAttempts: number;
  stage: string | null;
  chunkCount: number;
}

export type ResumeLoopResult =
  | { kind: 'settled'; status: string; attempts: number }
  | { kind: 'failed'; reason: string; attempts: number }
  /** The document could not be continued: the calls stopped making progress, or the server can never resume it. */
  | { kind: 'stalled'; reason: string; attempts: number }
  | { kind: 'exhausted'; attempts: number }
  /** 401, 403 or 404: the caller may not resume this document. */
  | { kind: 'refused'; httpStatus: number; attempts: number }
  | { kind: 'cancelled'; attempts: number };

export interface ResumeLoopOptions {
  resume: (documentId: string, signal: AbortSignal) => Promise<ResumeCall>;
  /** Reads the last completed stage after a call that left the document processing; optional. */
  readStage?: (documentId: string, signal: AbortSignal) => Promise<StageSnapshot | null>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  maxAttempts?: number;
  maxStalled?: number;
  onProgress?: (progress: ResumeProgress) => void;
}

const REFUSED = new Set([401, 403, 404]);

/** Calls resume until the version settles, fails, stops making progress, the attempts run out, or the signal aborts. */
export async function resumeIngestUntilSettled(documentId: string, options: ResumeLoopOptions): Promise<ResumeLoopResult> {
  const maxAttempts = options.maxAttempts ?? INGEST_RESUME_MAX_ATTEMPTS;
  const maxStalled = options.maxStalled ?? INGEST_RESUME_MAX_STALLED;
  const { signal } = options;
  let stalled = 0;
  let lastKey: string | null = null;
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (signal.aborted) return { kind: 'cancelled', attempts };
    attempts += 1;
    let call: ResumeCall;
    try {
      call = await options.resume(documentId, signal);
    } catch {
      if (signal.aborted) return { kind: 'cancelled', attempts };
      call = { ok: false, httpStatus: 0 };
    }
    if (signal.aborted) return { kind: 'cancelled', attempts };

    let progressed = false;
    let parsePending = false;
    if (!call.ok) {
      if (REFUSED.has(call.httpStatus)) return { kind: 'refused', httpStatus: call.httpStatus, attempts };
    } else {
      const { snapshot } = call;
      if (SETTLED.has(snapshot.status)) return { kind: 'settled', status: snapshot.status, attempts };
      if (snapshot.status === 'failed') return { kind: 'failed', reason: snapshot.reason ?? 'failed', attempts };
      if (snapshot.reason && UNRESUMABLE_REASONS.has(snapshot.reason)) return { kind: 'stalled', reason: snapshot.reason, attempts };
      let stage: StageSnapshot | null = null;
      if (options.readStage) {
        try {
          stage = await options.readStage(documentId, signal);
        } catch {
          stage = null;
        }
        if (signal.aborted) return { kind: 'cancelled', attempts };
      }
      parsePending = stage?.parsePending ?? false;
      const key = `${stage?.stage ?? ''}|${snapshot.chunkCount}`;
      progressed = lastKey === null || key !== lastKey;
      lastKey = key;
      options.onProgress?.({ attempt: attempts, maxAttempts, stage: stage?.stage ?? null, chunkCount: snapshot.chunkCount });
    }

    // A pending external parse job legitimately keeps the same stage between calls; it is bounded by maxAttempts only.
    if (progressed || parsePending) stalled = 0;
    else stalled += 1;
    if (stalled >= maxStalled) {
      const reason = call.ok ? (call.snapshot.reason ?? 'no_progress') : 'resume_unavailable';
      return { kind: 'stalled', reason, attempts };
    }
    if (attempts >= maxAttempts) break;
    try {
      await options.sleep(resumeDelayMs(stalled), signal);
    } catch {
      return { kind: 'cancelled', attempts };
    }
  }
  return { kind: 'exhausted', attempts };
}

/** setTimeout that rejects when the signal aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The fetch-backed calls of the loop for one workspace; workspaceQuery is '' or '?organizationId=…'. */
export function ingestResumeFetchers(workspaceQuery: string, fetchImpl: typeof fetch = fetch) {
  return {
    resume: async (documentId: string, signal: AbortSignal): Promise<ResumeCall> => {
      const response = await fetchImpl(`/api/rag/ingest/${encodeURIComponent(documentId)}/resume${workspaceQuery}`, { method: 'POST', signal });
      if (!response.ok) return { ok: false, httpStatus: response.status };
      const snapshot = parseResumeBody(await response.json().catch(() => null));
      return snapshot ? { ok: true, snapshot } : { ok: false, httpStatus: 0 };
    },
    readStage: async (documentId: string, signal: AbortSignal): Promise<StageSnapshot | null> => {
      const response = await fetchImpl(`/api/rag/ingest/${encodeURIComponent(documentId)}${workspaceQuery}`, { signal });
      if (!response.ok) return null;
      return parseStatusBody(await response.json().catch(() => null));
    },
  };
}
