import { RefusalFeedbackRequestSchema, type RefusalFeedbackRequest } from '@/lib/rag-eval/contracts.generated';
import {
  pickRefusalMetadata,
  RefusalFeedbackValueSchema,
  type RefusalFeedbackValue,
  type RefusalReason,
  type RefusalVote,
} from '@/lib/chat/answer-metadata';

export type RefusalFeedbackResult = { ok: true; feedback: RefusalFeedbackValue } | { ok: false; retry: true } | { ok: false; hidden: true };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface RefusalFeedbackDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
export type RefusalControlAction = { type: 'vote'; vote: RefusalVote } | { type: 'reason'; reason: RefusalReason };

export const REFUSAL_REASONS: readonly RefusalReason[] = ['answer_exists', 'wrong_language', 'other'];
export const REFUSAL_NOT_FOUND_RETRY_MS = 2000;
export const REFUSAL_TIMEOUT_MS = 10000;

const TRACE_ID = /^[0-9a-f]{32}$/;

// Page-session state: cleared on reload, never persisted.
const hiddenTraces = new Set<string>();
const sentSignals = new Set<string>();
const stoppedSignalTraces = new Set<string>();
const messageTraces = new Map<string, string>();
let panelMessageId: string | null = null;

const defaultFetch: FetchLike = (url, init) => fetch(url, init);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value);
}

/** True after two 404s for this trace in this page session (switch off, or not the caller's row). */
export function isRefusalControlHidden(traceId: string): boolean {
  return hiddenTraces.has(traceId);
}

/** D-08: a finished assistant refusal with a valid trace id, outside incognito chats, not hidden by a 404 in this session. */
export function shouldShowRefusalControl(input: {
  role: string;
  finished: boolean;
  metadata: unknown;
  isGhostMode: boolean;
  chatId: string | null | undefined;
}): boolean {
  if (input.role !== 'assistant' || !input.finished || input.isGhostMode) return false;
  if (typeof input.chatId === 'string' && input.chatId.startsWith('ghost-')) return false;
  const metadata = input.metadata && typeof input.metadata === 'object' ? (input.metadata as Record<string, unknown>) : undefined;
  if (!metadata || pickRefusalMetadata(metadata).refusal !== true) return false;
  return isTraceId(metadata.ragTraceId) && !hiddenTraces.has(metadata.ragTraceId);
}

/** The request a choice or chip sends, or null when it changes nothing (the chosen button again, a chip without expected_answer). */
export function refusalRequestFor(current: RefusalFeedbackValue | null, action: RefusalControlAction): RefusalFeedbackRequest | null {
  if (action.type === 'vote') {
    if (current?.vote === action.vote) return null;
    return { vote: action.vote, reasons: [] };
  }
  if (current?.vote !== 'expected_answer') return null;
  const chosen = new Set(current.reasons);
  if (chosen.has(action.reason)) chosen.delete(action.reason);
  else chosen.add(action.reason);
  return { vote: 'expected_answer', reasons: REFUSAL_REASONS.filter((reason) => chosen.has(reason)) };
}

async function sendOnce(
  doFetch: FetchLike,
  traceId: string,
  body: RefusalFeedbackRequest,
  timeoutMs: number,
): Promise<RefusalFeedbackResult | 'not_found'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`/api/rag/retrieval/${traceId}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 404) return 'not_found';
    if (!response.ok) return { ok: false, retry: true };
    const parsed = RefusalFeedbackValueSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, feedback: parsed.data } : { ok: false, retry: true };
  } catch {
    return { ok: false, retry: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * D-08: saves the caller's vote on their own refusal. A first 404 is retried once after 2 s (the log row is written after the
 * response); a second hides the control for this trace until reload. Every other failure offers a retry; nothing throws.
 */
export async function postRefusalFeedback(
  traceId: string,
  body: RefusalFeedbackRequest,
  deps: RefusalFeedbackDeps = {},
): Promise<RefusalFeedbackResult> {
  if (!isTraceId(traceId)) return { ok: false, hidden: true };
  const request = RefusalFeedbackRequestSchema.safeParse(
    body.vote === 'correct_refusal' ? { vote: body.vote, reasons: [] } : { vote: body.vote, reasons: body.reasons ?? [] },
  );
  if (!request.success) return { ok: false, retry: true };
  const doFetch = deps.fetch ?? defaultFetch;
  const timeoutMs = deps.timeoutMs ?? REFUSAL_TIMEOUT_MS;

  const first = await sendOnce(doFetch, traceId, request.data, timeoutMs);
  if (first !== 'not_found') return first;
  await (deps.sleep ?? defaultSleep)(REFUSAL_NOT_FOUND_RETRY_MS);
  const second = await sendOnce(doFetch, traceId, request.data, timeoutMs);
  if (second !== 'not_found') return second;
  hiddenTraces.add(traceId);
  return { ok: false, hidden: true };
}

/** D-12: chat-message records which trace a message belongs to, so a source of that message can be resolved; undefined removes it. */
export function registerMessageTrace(messageId: string, traceId: string | undefined): void {
  if (traceId && isTraceId(traceId)) messageTraces.set(messageId, traceId);
  else messageTraces.delete(messageId);
}

export function traceForMessage(messageId: string): string | undefined {
  return messageTraces.get(messageId);
}

/** The message whose sources the panel currently lists. */
export function setSourcesMessage(messageId: string | null): void {
  panelMessageId = messageId;
}

export function sourcesMessage(): string | null {
  return panelMessageId;
}

/** Stays in the browser: the citation number for a chip, else the document id, else the URL. */
export function sourceKeyOf(source: { documentId?: string; url?: string; citation?: { n: number } }): string | null {
  if (source.citation) return `citation:${source.citation.n}`;
  if (source.documentId) return `doc:${source.documentId}`;
  if (source.url) return `url:${source.url}`;
  return null;
}

/**
 * D-12: one fire-and-forget POST per source per trace in the page session. Only the trace id and a constant body leave the
 * browser; any failure is swallowed, and after a 404 nothing more is sent for that trace. Returns whether a request was sent.
 */
export function postSourceOpened(traceId: string, sourceKey: string, deps: { fetch?: FetchLike } = {}): boolean {
  if (!isTraceId(traceId) || stoppedSignalTraces.has(traceId)) return false;
  const key = `${traceId}\u0000${sourceKey}`;
  if (sentSignals.has(key)) return false;
  sentSignals.add(key);
  try {
    const pending = (deps.fetch ?? defaultFetch)(`/api/rag/retrieval/${traceId}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: true,
      body: JSON.stringify({ kind: 'source_opened' }),
    });
    void Promise.resolve(pending).then(
      (response) => {
        if (response?.status === 404) stoppedSignalTraces.add(traceId);
      },
      () => {},
    );
  } catch {
    // swallowed: the signal never affects the UI
  }
  return true;
}

/** Test helper: forgets the page-session state. */
export function resetRefusalFeedbackSession(): void {
  hiddenTraces.clear();
  sentSignals.clear();
  stoppedSignalTraces.clear();
  messageTraces.clear();
  panelMessageId = null;
}
