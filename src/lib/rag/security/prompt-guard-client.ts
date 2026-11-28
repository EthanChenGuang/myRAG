import { env } from '@/lib/env';
import {
  InjectionClassifyRequestSchema,
  InjectionClassifyResponseSchema,
  type InjectionClassifyResponse,
} from '@/lib/rag-eval/contracts.generated';

const SECRET_HEADER = 'x-sidecar-secret';
const CLASSIFY_PATH = '/v1/injection/classify';
const MAX_ITEMS_PER_REQUEST = 32;

export interface PromptGuardItem {
  id: string;
  text: string;
}

export type PromptGuardResult = InjectionClassifyResponse['results'][number];

export type PromptGuardFailure =
  | 'not_configured'
  | 'timeout'
  | 'aborted'
  | 'malformed'
  | 'unreachable'
  | 'invalid_request'
  | `http_${number}`;

export type PromptGuardOutcome =
  | { ok: true; modelId: string | null; revision: string | null; results: PromptGuardResult[] }
  | { ok: false; reason: PromptGuardFailure };

export interface PromptGuardClientConfig {
  url: string;
  secret: string;
}

export interface PromptGuardOptions {
  signal?: AbortSignal;
  /** Deadline for the whole call, across every batch. */
  timeoutMs: number;
  /** Defaults to RAG_SIDECAR_URL and RAG_SIDECAR_SECRET. */
  config?: PromptGuardClientConfig;
  fetch?: typeof fetch;
}

class Failure extends Error {
  constructor(readonly reason: PromptGuardFailure) {
    super(reason);
  }
}

function defaultConfig(): PromptGuardClientConfig {
  return { url: env.RAG_SIDECAR_URL ?? '', secret: env.RAG_SIDECAR_SECRET ?? '' };
}

function batches(items: PromptGuardItem[]): PromptGuardItem[][] {
  const out: PromptGuardItem[][] = [];
  for (let index = 0; index < items.length; index += MAX_ITEMS_PER_REQUEST) {
    out.push(items.slice(index, index + MAX_ITEMS_PER_REQUEST));
  }
  return out;
}

async function classifyBatch(
  batch: PromptGuardItem[],
  endpoint: string,
  secret: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<InjectionClassifyResponse> {
  const request = InjectionClassifyRequestSchema.safeParse({ items: batch });
  if (!request.success) throw new Failure('invalid_request');
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
    body: JSON.stringify(request.data),
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Failure(`http_${response.status}`);
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Failure('malformed');
  }
  const parsed = InjectionClassifyResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Failure('malformed');
  const results = parsed.data.results;
  if (results.length !== batch.length || results.some((result, index) => result.id !== batch[index].id)) {
    throw new Failure('malformed');
  }
  return parsed.data;
}

/**
 * Asks the sidecar's Prompt Guard endpoint (D-08) for one verdict per item, in request order. Never
 * throws (D-09): every failure comes back as `{ ok: false, reason }`. Logs carry ids and counts only.
 */
export async function classifyWithPromptGuard(
  items: PromptGuardItem[],
  options: PromptGuardOptions,
): Promise<PromptGuardOutcome> {
  const config = options.config ?? defaultConfig();
  const baseUrl = (config.url ?? '').trim().replace(/\/+$/, '');
  const secret = (config.secret ?? '').trim();
  if (!baseUrl || !secret) return { ok: false, reason: 'not_configured' };
  if (options.signal?.aborted) return { ok: false, reason: 'aborted' };
  if (items.length === 0) return { ok: true, modelId: null, revision: null, results: [] };

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 1;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = `${baseUrl}${CLASSIFY_PATH}`;

  const results: PromptGuardResult[] = [];
  let modelId: string | null = null;
  let revision: string | null = null;
  try {
    for (const batch of batches(items)) {
      if (signal.aborted) throw signal.reason;
      const response = await classifyBatch(batch, endpoint, secret, signal, fetchImpl);
      if (modelId !== null && (response.model_id !== modelId || response.revision !== revision)) {
        throw new Failure('malformed');
      }
      modelId = response.model_id;
      revision = response.revision;
      results.push(...response.results);
    }
  } catch (error) {
    let reason: PromptGuardFailure;
    if (options.signal?.aborted) reason = 'aborted';
    else if (deadline.aborted) reason = 'timeout';
    else if (error instanceof Failure) reason = error.reason;
    else reason = 'unreachable';
    console.warn('[RAG Security] Prompt Guard request failed', { reason, items: items.length });
    return { ok: false, reason };
  }
  return { ok: true, modelId, revision, results };
}
