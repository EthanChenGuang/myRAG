import { createHash } from 'node:crypto';
import { assertTenantScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';

const LOWER_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TENANT_KEY_RE = new RegExp(`^(?:s:default|[uo]:${LOWER_UUID})$`);
const QDRANT_PROFILE_RE = /^[a-z0-9_-]{1,128}$/;
const WEAVIATE_TENANT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isCanonicalTenantKey(value: unknown): value is string {
  return typeof value === 'string' && TENANT_KEY_RE.test(value);
}

/** The only tenant key that leaves the app (Postgres, Qdrant, Weaviate); vendor matching is case-sensitive. */
export function canonicalTenantKey(scope: TenantScope): string {
  assertTenantScope(scope);
  const key = scopeKey(scope).toLowerCase();
  if (!isCanonicalTenantKey(key)) throw new Error('[RAG Tenant] malformed tenant key');
  return key;
}

export function weaviateTenantName(key: string): string {
  if (!isCanonicalTenantKey(key)) throw new Error('[RAG Tenant] malformed tenant key');
  const name = key.replace(':', '_');
  if (!WEAVIATE_TENANT_RE.test(name)) throw new Error('[RAG Tenant] invalid Weaviate tenant name');
  return name;
}

/** Sanitising alone would map voyage-4 and voyage_4 to one class; the hash keeps them apart. */
export function weaviateCollectionName(profileId: string): string {
  if (typeof profileId !== 'string' || profileId.length === 0 || profileId.length > 128) {
    throw new Error('[RAG Tenant] invalid embedding profile id');
  }
  const sanitized = profileId.replace(/[^A-Za-z0-9_]/g, '_');
  const hash = createHash('sha256').update(profileId).digest('hex').slice(0, 8);
  return `Myrag_chunks_${sanitized}_${hash}`;
}

export function qdrantCollectionName(profileId: string): string {
  if (typeof profileId !== 'string' || !QDRANT_PROFILE_RE.test(profileId)) {
    throw new Error('[RAG Tenant] invalid embedding profile id');
  }
  return `myrag_chunks_${profileId}`;
}
