import { env } from '@/lib/env';
import { LangidRequestSchema, LangidResponseSchema } from '@/lib/rag-eval/contracts.generated';

const SECRET_HEADER = 'x-sidecar-secret';
const LANGID_PATH = '/v1/langid';
const MAX_TEXT_CHARS = 1000;

export interface LangidAnswer {
  language: string;
  confidence: number;
}

export interface LangidClientOptions {
  /** langid_timeout_ms from eval/config/query-params.json (30 ms by default). */
  timeoutMs: number;
  /** The request signal; an abort is no answer. */
  signal?: AbortSignal;
  /** Defaults to RAG_SIDECAR_URL. */
  url?: string;
  /** Defaults to RAG_SIDECAR_SECRET. */
  secret?: string;
  fetch?: typeof fetch;
}

function endpoint(options: Pick<LangidClientOptions, 'url' | 'secret'>): { baseUrl: string; secret: string } {
  return {
    baseUrl: (options.url ?? env.RAG_SIDECAR_URL ?? '').trim().replace(/\/+$/u, ''),
    secret: (options.secret ?? env.RAG_SIDECAR_SECRET ?? '').trim(),
  };
}

/** True when the sidecar URL and shared secret are both set. */
export function langidConfigured(options: Pick<LangidClientOptions, 'url' | 'secret'> = {}): boolean {
  const { baseUrl, secret } = endpoint(options);
  return baseUrl !== '' && secret !== '';
}

/**
 * D-17 chain step 1, D-18: POSTs to the sidecar's /v1/langid with the text (capped at 1000 characters) and the enabled
 * candidates. Never throws: a timeout, abort, HTTP error, invalid body, missing configuration or a language outside the
 * candidates is no answer (null). Logs carry the status and latency only, never the text.
 */
export async function requestLanguageId(
  text: string,
  candidates: readonly string[],
  options: LangidClientOptions,
): Promise<LangidAnswer | null> {
  const { baseUrl, secret } = endpoint(options);
  if (!baseUrl || !secret || options.signal?.aborted) return null;
  const body = LangidRequestSchema.safeParse({ text: Array.from(text).slice(0, MAX_TEXT_CHARS).join(''), candidates: [...candidates] });
  if (!body.success) return null;

  const started = Date.now();
  const elapsed = () => Math.max(0, Date.now() - started);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, options.timeoutMs));
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

  try {
    const response = await (options.fetch ?? fetch)(`${baseUrl}${LANGID_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
      body: JSON.stringify(body.data),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      console.warn('[Langid] Sidecar request failed', { httpStatus: response.status, latencyMs: elapsed() });
      return null;
    }
    const parsed = LangidResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      console.warn('[Langid] Sidecar returned an invalid result', { issues: parsed.error.issues.length, latencyMs: elapsed() });
      return null;
    }
    const { language, confidence } = parsed.data;
    return language !== null && candidates.includes(language) ? { language, confidence } : null;
  } catch (error) {
    if (timedOut) console.warn('[Langid] Sidecar request timed out', { timeoutMs: options.timeoutMs });
    else if (!options.signal?.aborted) {
      console.warn('[Langid] Sidecar request failed', { error: error instanceof Error ? error.name : typeof error, latencyMs: elapsed() });
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
