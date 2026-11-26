import { z } from 'zod/v3';
import type { NextResponse } from 'next/server';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import type { AttributeAdminFailure, RuleFailure } from '@/lib/rag';
import { OrganizationIdSchema, admission, invalidRequest, issues, jsonNoStore, type Admission } from '../scope-vocabulary/_lib';

export { OrganizationIdSchema, admission, invalidRequest, issues, jsonBody, jsonNoStore } from '../scope-vocabulary/_lib';
export type { Admission, Details } from '../scope-vocabulary/_lib';

/**
 * Shared helpers of the Phase 3.3 tenant rule-data routes (section-rules, boilerplate-rules, attribute-schema, attribute-header). The
 * tenant key and the actor come only from the admission; answers carry code words, ids and counts, never a pattern, a name or a database
 * message.
 */
const QuerySchema = z.object({ organizationId: OrganizationIdSchema });

/** The guard of every tenant rule-data route: query parse, checkAdminOrOrgAdmin, then the admission (the scope-vocabulary order). */
export async function admit(request: Request): Promise<Admission> {
  const query = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, query.success ? query.data.organizationId : null));
  if (!admitted.ok) return admitted;
  if (!query.success) return { ok: false, response: invalidRequest(issues(query.error)) };
  return admitted;
}

/** A switch that is effectively off: the route answers 404 before any lookup, and nothing is read or written. */
export function notFoundUnless(enabled: boolean): NextResponse | null {
  return enabled ? null : jsonNoStore({ success: false, error: 'Not found' }, 404);
}

export type TenantDataFailure = RuleFailure | { ok: false; reason: AttributeAdminFailure };

/**
 * Fixed answers for the failure words of the rule and attribute schema services (D-12). `patternPath` turns a refused pattern's index into
 * the body path of that pattern; the finding codes are the details, the pattern itself is never echoed. An unknown and a foreign id get the
 * same 404 body.
 */
export function tenantDataFailure(failure: TenantDataFailure, patternPath?: (index: number) => string): NextResponse {
  switch (failure.reason) {
    case 'invalid_tenant_pattern': {
      const index = 'patternIndex' in failure ? failure.patternIndex : 0;
      const path = patternPath ? patternPath(index) : String(index);
      const findings = 'findings' in failure ? failure.findings : [];
      return jsonNoStore({ success: false, error: 'invalid_tenant_pattern', details: findings.map((code) => ({ path, message: code })) }, 400);
    }
    case 'invalid_attribute_type':
      return jsonNoStore({ success: false, error: failure.reason }, 400);
    case 'invalid_argument':
      return jsonNoStore({ success: false, error: 'Invalid request' }, 400);
    case 'limit_reached':
      return jsonNoStore({ success: false, error: 'limit_reached', limit: 'limit' in failure ? failure.limit : null }, 409);
    case 'name_exists':
    case 'unknown_placeholder':
      return jsonNoStore({ success: false, error: failure.reason }, 409);
    case 'not_found':
      return jsonNoStore({ success: false, error: 'not_found' }, 404);
    case 'not_admin':
      return jsonNoStore({ success: false, error: 'Forbidden' }, 403);
    default:
      return jsonNoStore({ success: false, error: 'Tenant rule administration is unavailable' }, 503);
  }
}
