export interface StageErrorCause {
  cause: string;
  status?: number;
  code?: string;
}

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Describes why a stage failed without its message: provider messages can echo part of an API key or the user's text, so only the
 * error class name, an HTTP status and a short provider error code are kept.
 */
export function describeStageCause(original: unknown): StageErrorCause {
  if (!original || typeof original !== 'object') return { cause: original === undefined ? 'unknown' : typeof original };
  const err = original as { name?: unknown; constructor?: { name?: unknown }; status?: unknown; code?: unknown; type?: unknown };
  const rawName = typeof err.name === 'string' && err.name ? err.name : typeof err.constructor?.name === 'string' ? err.constructor.name : 'Object';
  const out: StageErrorCause = { cause: SAFE_CODE.test(rawName) ? rawName : 'Error' };
  if (typeof err.status === 'number' && Number.isInteger(err.status)) out.status = err.status;
  const code = typeof err.code === 'string' ? err.code : typeof err.type === 'string' ? err.type : undefined;
  if (code && SAFE_CODE.test(code)) out.code = code;
  return out;
}
