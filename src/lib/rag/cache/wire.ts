import { maskPII } from '../trace/mask';

/** The sidecar contract caps the stored query text; pgvector uses the same cap so both backends hold the same text. */
export const MAX_MASKED_QUERY_CHARS = 8000;

export type SemanticCacheFailure =
  | 'not_configured'
  | 'invalid_vector'
  | 'invalid_threshold'
  | 'invalid_answer'
  | 'invalid_request'
  | 'empty_query'
  | 'rpc_error'
  | 'malformed_response'
  | 'sources_unverifiable'
  | `http_${number}`;

/** A typed backend failure; its reason is safe to log (no query text, no answer, no key). */
export class SemanticCacheBackendError extends Error {
  readonly reason: SemanticCacheFailure;
  readonly code: string | null;

  constructor(reason: SemanticCacheFailure, code: string | null = null) {
    super(`[Semantic Cache] ${reason}${code ? ` (${code})` : ''}`);
    this.name = 'SemanticCacheBackendError';
    this.reason = reason;
    this.code = code;
  }
}

export function requireFiniteVector(vector: unknown): number[] {
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new SemanticCacheBackendError('invalid_vector');
  }
  return vector as number[];
}

/** The pgvector text form PostgREST casts to halfvec. */
export function halfvecLiteral(vector: unknown): string {
  return `[${requireFiniteVector(vector).join(',')}]`;
}

export function resolveMaxDistance(requested: number | undefined, fallback: number): number {
  const value = requested ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    throw new SemanticCacheBackendError('invalid_threshold');
  }
  return value;
}

/** The Phase 2 masker over the standalone query (D-34); empty text is refused. */
export function maskQueryText(text: string): string {
  const masked = maskPII(typeof text === 'string' ? text : '').trim().slice(0, MAX_MASKED_QUERY_CHARS);
  if (masked.length === 0) throw new SemanticCacheBackendError('empty_query');
  return masked;
}

/** A scalar RPC answer: the value itself, or the single value of a one-row, one-column answer. */
export function scalarOf(data: unknown, fn: string): unknown {
  if (!Array.isArray(data)) return data;
  if (data.length !== 1) return undefined;
  const row = data[0];
  if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
    const values = Object.values(row as Record<string, unknown>);
    if (fn in (row as Record<string, unknown>)) return (row as Record<string, unknown>)[fn];
    return values.length === 1 ? values[0] : undefined;
  }
  return row;
}
