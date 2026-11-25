import type { TenantScope } from '@/lib/rag/tenant/scope';

export function isCanonicalTenantKey(_value: unknown): _value is string {
  return false;
}

export function canonicalTenantKey(_scope: TenantScope): string {
  return '';
}

export function weaviateTenantName(_key: string): string {
  return '';
}

export function weaviateCollectionName(_profileId: string): string {
  return '';
}

export function qdrantCollectionName(_profileId: string): string {
  return '';
}
