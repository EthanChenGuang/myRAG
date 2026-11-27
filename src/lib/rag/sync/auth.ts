import { internalApiKeyMatches } from '@/lib/internal-api-key';

const MIN_SECRET_LENGTH = 32;
const BEARER_RE = /^Bearer\s+(\S+)$/i;

export type VectorSyncAccessResult = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * The drain route's gate (D-04, A-6): `Authorization: Bearer <RAG_VECTOR_SYNC_SECRET>`. Fails closed: an unset or short secret
 * answers 503 before any header is read; a missing, malformed or wrong token answers 401. The comparison is constant time.
 */
export function checkVectorSyncAccess(headers: Headers, secret: string | undefined): VectorSyncAccessResult {
  const expected = secret ?? '';
  if (expected.length < MIN_SECRET_LENGTH) {
    return { ok: false, status: 503, error: 'Vector sync endpoint is not configured' };
  }
  const authorization = headers.get('authorization');
  const match = authorization ? BEARER_RE.exec(authorization.trim()) : null;
  if (!match || !internalApiKeyMatches(match[1], expected)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}
