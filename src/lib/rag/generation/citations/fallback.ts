export type FallbackReason =
  | 'status_400'
  | 'status_401'
  | 'status_404'
  | 'status_429'
  | 'status_5xx'
  | 'error'
  | 'refusal'
  | 'timeout';

export const CLAUDE_FIRST_TOKEN_TIMEOUT_MS = 8000;

export interface GatePart {
  type: string;
  finishReason?: string;
}

export type FirstTokenGateResult<T> = { kind: 'ok'; stream: ReadableStream<T> } | { kind: 'fallback'; reason: FallbackReason };

export interface FirstTokenGateOptions {
  timeoutMs?: number;
  /** The HTTP status of the error the caller captured in streamText's onError, if any. */
  errorStatus: () => number | null | undefined;
  /** Aborts the direct call. */
  abort: () => void;
}

/** The HTTP status of a provider error (APICallError.statusCode), or null. */
export function errorStatusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as { statusCode?: unknown; status?: unknown };
  const status = typeof record.statusCode === 'number' ? record.statusCode : record.status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

export function fallbackReasonFor(status: number | null | undefined): FallbackReason {
  if (status === 400) return 'status_400';
  if (status === 401) return 'status_401';
  if (status === 404) return 'status_404';
  if (status === 429) return 'status_429';
  if (typeof status === 'number' && status >= 500 && status <= 599) return 'status_5xx';
  return 'error';
}

const REFUSAL_FINISH_REASONS = new Set(['content-filter']);
const FIRST_TOKEN_PARTS = new Set(['text-delta', 'reasoning-delta']);

/**
 * D-10 and research Pattern 5: holds the direct call's UI parts until the first text delta. An error,
 * a refusal with no text, or no first token in time discards the buffer and asks for the fallback;
 * after the first text delta everything is forwarded unchanged, late errors included.
 */
export async function firstTokenGate<T extends GatePart>(
  stream: ReadableStream<T>,
  options: FirstTokenGateOptions,
): Promise<FirstTokenGateResult<T>> {
  const reader = stream.getReader();
  const buffer: T[] = [];
  const timeoutMs = options.timeoutMs ?? CLAUDE_FIRST_TOKEN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const giveUp = (reason: FallbackReason): FirstTokenGateResult<T> => {
    clearTimer();
    try {
      options.abort();
    } catch {
      // the direct call is discarded either way
    }
    reader.cancel().catch(() => {});
    return { kind: 'fallback', reason };
  };
  const replay = (done: boolean): FirstTokenGateResult<T> => {
    clearTimer();
    const pending = buffer.splice(0);
    const out = new ReadableStream<T>({
      start(controller) {
        for (const part of pending) controller.enqueue(part);
        if (done) controller.close();
      },
      async pull(controller) {
        if (done) return;
        try {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return { kind: 'ok', stream: out };
  };

  for (;;) {
    let next: ReadableStreamReadResult<T> | 'timeout';
    try {
      next = await Promise.race([reader.read(), timedOut]);
    } catch {
      return giveUp(fallbackReasonFor(options.errorStatus()));
    }
    if (next === 'timeout') return giveUp('timeout');
    if (next.done) return replay(true);
    const part = next.value;
    if (part.type === 'error') return giveUp(fallbackReasonFor(options.errorStatus()));
    if (part.type === 'finish' && part.finishReason && REFUSAL_FINISH_REASONS.has(part.finishReason)) {
      return giveUp('refusal');
    }
    buffer.push(part);
    if (FIRST_TOKEN_PARTS.has(part.type)) clearTimer();
    if (part.type === 'text-delta') return replay(false);
  }
}
