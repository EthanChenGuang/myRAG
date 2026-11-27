import { scopeAccessFilter } from '../tenant/access';
import type { TenantScope } from '../tenant/scope';
import { accessKeyPartOf } from './keys';

/**
 * D-23, A-05: CacheKeyParts.accessGroupSetHash for a request: accessKeyPartOf(scopeAccessFilter(scope)). A scope never resolved for access
 * while RAG_DOC_ACCESS_GROUPS is on throws, so no key is built for it. Kept apart from ./keys so that module stays free of the env and deps
 * graph.
 */
export function cacheAccessKeyPart(scope: TenantScope): string {
  return accessKeyPartOf(scopeAccessFilter(scope));
}
