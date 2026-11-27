import { BackendNotReadyError } from '../external';
import { RetrievalBackendError } from '../supabase-rpc';

const TENANT_MISSING_RE = /tenant\b[^]*?\bnot (?:found|active)|tenant\b[^]*?\b(?:is )?(?:inactive|cold|frozen|offloaded)|tenant does not exist/i;
const COLLECTION_MISSING_RE = /could not find class|class\b[^]*?\b(?:not found|does not exist)|collection\b[^]*?\b(?:not found|does not exist)/i;
const PERMISSION_RE = /\b(?:401|403)\b|forbidden|unauthori[sz]ed|permission/i;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

export function isWeaviateTenantMissing(error: unknown): boolean {
  return TENANT_MISSING_RE.test(messageOf(error));
}

/**
 * A-4, D-07, D-11: a missing or inactive tenant and a missing collection mean "not ready", never a retry without a tenant.
 * Everything else is a backend error carrying a code only; vendor messages can echo request data and are not kept.
 */
export function mapWeaviateError(error: unknown, operation: string): Error {
  if (error instanceof BackendNotReadyError || error instanceof RetrievalBackendError) return error;
  if (error instanceof Error && error.name === 'AbortError') return error;
  const message = messageOf(error);
  if (TENANT_MISSING_RE.test(message)) return new BackendNotReadyError('weaviate', 'tenant_missing');
  if (COLLECTION_MISSING_RE.test(message)) return new BackendNotReadyError('weaviate', 'collection_missing');
  if (PERMISSION_RE.test(message)) return new RetrievalBackendError(`weaviate.${operation}`, 'permission_denied');
  return new RetrievalBackendError(`weaviate.${operation}`, 'backend_error');
}
