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

export function errorStatusOf(_error: unknown): number | null {
  return null;
}

export function fallbackReasonFor(_status: number | null | undefined): FallbackReason {
  return 'error';
}

export async function firstTokenGate<T extends GatePart>(
  stream: ReadableStream<T>,
  _options: FirstTokenGateOptions,
): Promise<FirstTokenGateResult<T>> {
  return { kind: 'ok', stream };
}
