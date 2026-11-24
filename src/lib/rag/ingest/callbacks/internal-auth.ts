import { internalApiKeyMatches } from '@/lib/internal-api-key';

/** The header the sidecar worker sends its shared secret in. */
export const SIDECAR_SECRET_HEADER = 'x-sidecar-secret';

export type SidecarAuth = { ok: true } | { ok: false; status: 401; reason: 'secret_unset' | 'secret_rejected' };

export interface SidecarAuthDeps {
  /** The expected secret, read live: unset or empty refuses every call. */
  secret: () => string;
}

const defaults: SidecarAuthDeps = {
  secret: () => process.env.RAG_SIDECAR_SECRET ?? '',
};

/**
 * The only gate of the internal ingest callbacks: the secret is compared in constant time (hashing both sides), and an unset secret
 * refuses everything instead of matching an empty header. It runs before any ledger call, and the tenant is never taken from the request.
 */
export function checkSidecarSecret(headers: Pick<Headers, 'get'>, deps: SidecarAuthDeps = defaults): SidecarAuth {
  const expected = deps.secret();
  if (!expected) {
    console.error('[RAG Ingest] sidecar secret is not configured, internal callback refused');
    return { ok: false, status: 401, reason: 'secret_unset' };
  }
  if (!internalApiKeyMatches(headers.get(SIDECAR_SECRET_HEADER), expected)) {
    console.warn('[RAG Ingest] internal callback refused: secret rejected');
    return { ok: false, status: 401, reason: 'secret_rejected' };
  }
  return { ok: true };
}
