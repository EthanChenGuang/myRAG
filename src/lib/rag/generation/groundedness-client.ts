import { env } from '@/lib/env';
import {
  GroundednessRequestSchema,
  GroundednessResultSchema,
  type GroundednessRequest,
  type GroundednessResult,
} from '@/lib/rag-eval/contracts.generated';
import { readGenerationConfig } from './config';

const SECRET_HEADER = 'x-sidecar-secret';
const GROUNDEDNESS_PATH = '/v1/groundedness';

export interface GroundednessClientOptions {
  /** Defaults to RAG_SIDECAR_URL. */
  url?: string;
  /** Defaults to RAG_SIDECAR_SECRET. */
  secret?: string;
  /** Defaults to RAG_GROUNDEDNESS_TIMEOUT_MS. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

type FailureReason = 'timeout' | 'error' | 'scorer_unavailable';

function notChecked(reason: FailureReason, latencyMs: number): GroundednessResult {
  return { status: 'not_checked', scorer: 'none', score: null, reason, truncated: false, latency_ms: latencyMs };
}

function resolveTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
  return readGenerationConfig().groundednessTimeoutMs;
}

/**
 * POSTs to the sidecar's /v1/groundedness (D-11) and never throws (D-15): a timeout, an HTTP error,
 * a transport failure or an invalid body all come back as not_checked. Logs carry no request text.
 */
export async function requestGroundedness(
  request: GroundednessRequest,
  options: GroundednessClientOptions = {},
): Promise<GroundednessResult> {
  const baseUrl = (options.url ?? env.RAG_SIDECAR_URL ?? '').trim().replace(/\/+$/, '');
  const secret = (options.secret ?? env.RAG_SIDECAR_SECRET ?? '').trim();
  if (!baseUrl || !secret) return notChecked('scorer_unavailable', 0);

  const started = Date.now();
  const elapsed = () => Math.max(0, Date.now() - started);
  const body = GroundednessRequestSchema.safeParse(request);
  if (!body.success) {
    console.warn('[Groundedness] Invalid request, not sent', { issues: body.error.issues.length });
    return notChecked('error', elapsed());
  }

  const timeoutMs = resolveTimeout(options.timeoutMs);
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(`${baseUrl}${GROUNDEDNESS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
      body: JSON.stringify(body.data),
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      console.warn('[Groundedness] Sidecar request failed', { httpStatus: response.status, latencyMs: elapsed() });
      return notChecked('error', elapsed());
    }
    const raw: unknown = await response.json();
    const parsed = GroundednessResultSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn('[Groundedness] Sidecar returned an invalid result', { issues: parsed.error.issues.length });
      return notChecked('error', elapsed());
    }
    return parsed.data;
  } catch (error) {
    if (timedOut) {
      console.warn('[Groundedness] Sidecar request timed out', { timeoutMs });
      return notChecked('timeout', elapsed());
    }
    const name = error instanceof Error ? error.name : typeof error;
    console.warn('[Groundedness] Sidecar request failed', { error: name, latencyMs: elapsed() });
    return notChecked('error', elapsed());
  } finally {
    clearTimeout(timer);
  }
}
