export type LangChainTransform = 'condense' | 'expand' | 'hyde' | 'decompose' | 'translate';
export type LangChainAdapterErrorKind = 'unavailable' | 'aborted' | 'invalid_output' | 'error';

/** Same kinds as the native QueryLlmError; the message names only the transform and the kind, never prompt or output text. */
export class LangChainAdapterError extends Error {
  constructor(
    readonly kind: LangChainAdapterErrorKind,
    readonly transform: LangChainTransform,
  ) {
    super(`langchain ${transform}: ${kind}`);
    this.name = 'LangChainAdapterError';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /abort/iu.test(error.message));
}

/** Maps any failure to an adapter error: an abort when the request signal fired, a parse failure as invalid_output. */
export function toAdapterError(error: unknown, signal: AbortSignal, transform: LangChainTransform): LangChainAdapterError {
  if (signal.aborted) return new LangChainAdapterError('aborted', transform);
  if (error instanceof LangChainAdapterError) return error;
  if (isAbortError(error)) return new LangChainAdapterError('aborted', transform);
  if (error instanceof Error && error.name === 'OutputParserException') return new LangChainAdapterError('invalid_output', transform);
  return new LangChainAdapterError('error', transform);
}

/** Rejects as soon as the signal fires, whether or not the LangChain call honours it. */
export function raceAbort<T>(work: () => Promise<T>, signal: AbortSignal, transform: LangChainTransform): Promise<T> {
  if (signal.aborted) return Promise.reject(new LangChainAdapterError('aborted', transform));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LangChainAdapterError('aborted', transform));
    signal.addEventListener('abort', onAbort, { once: true });
    work().then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new LangChainAdapterError('aborted', transform));
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(toAdapterError(error, signal, transform));
      },
    );
  });
}
