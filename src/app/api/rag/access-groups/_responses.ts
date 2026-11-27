import { NextResponse } from 'next/server';
import type { z } from 'zod/v3';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { env } from '@/lib/env';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
  AccessGroupsError,
  loadRagConfig,
  type AccessGroup,
  type AccessGroupsReason,
  type AccessServiceDeps,
  type AccessStatus,
  type ConnectorMapRow,
  type DocumentAudience,
} from '@/lib/rag';

export const TAG = '[RAG Access]';
export const NO_STORE = { 'Cache-Control': 'no-store' };

type Detail = { path: string; message: string };

export function fail(status: number, error: string, details?: Detail[], extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json(
    { success: false, error, ...(details ? { details } : {}), ...(extra ?? {}) },
    { status, headers: NO_STORE },
  );
}

export const invalid = (error: z.ZodError): NextResponse =>
  fail(400, 'Invalid request data', error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));

export function ok(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json({ success: true, ...body }, { status, headers: NO_STORE });
}

/** The body of a write, or a 400 answer when it is not JSON. An empty body reads as {}. */
export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: fail(400, 'Invalid request data', [{ path: '', message: 'Body is not valid JSON' }]) };
  }
  if (raw.trim() === '') return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, response: fail(400, 'Invalid request data', [{ path: '', message: 'Body is not valid JSON' }]) };
  }
}

/** The organization the guard checks: the agreed workspace, or the query's when the body disagrees (the 400 then follows the guard). */
export function guardWorkspace(workspace: ReturnType<typeof requestedWorkspace> | null): string | null {
  if (!workspace) return null;
  return workspace.ok ? workspace.organizationId : workspace.queryOrganizationId;
}

/**
 * The workspace a request names: `organizationId` from the query string or the body. Both present and different is refused, so the guard
 * and the operation can never disagree on the tenant.
 */
export function requestedWorkspace(
  request: Request,
  body?: unknown,
): { ok: true; organizationId: string | null } | { ok: false; response: NextResponse; queryOrganizationId: string | null } {
  const fromQuery = new URL(request.url).searchParams.get('organizationId');
  const query = fromQuery === null || fromQuery === '' ? null : fromQuery;
  const raw = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).organizationId : undefined;
  const fromBody = raw === undefined || raw === null || raw === '' ? null : raw;
  if (fromBody !== null && typeof fromBody !== 'string') {
    return { ok: false, response: fail(400, 'Invalid request data', [{ path: 'organizationId', message: 'Expected string' }]), queryOrganizationId: query };
  }
  if (query !== null && fromBody !== null && query.trim().toLowerCase() !== fromBody.trim().toLowerCase()) {
    return {
      ok: false,
      response: fail(400, 'Invalid request data', [{ path: 'organizationId', message: 'Query and body name different workspaces' }]),
      queryOrganizationId: query,
    };
  }
  return { ok: true, organizationId: fromBody ?? query };
}

/** Whether RAG_DOC_ACCESS_GROUPS is on for this process (the value retrieval reads). */
export function accessGroupsEnabled(): boolean {
  return loadRagConfig({ RAG_DOC_ACCESS_GROUPS: process.env.RAG_DOC_ACCESS_GROUPS ?? env.RAG_DOC_ACCESS_GROUPS }).accessGroups === 'on';
}

/** Service dependencies for one request: the service-role client and the request's abort signal. */
export function serviceDeps(request: Request): AccessServiceDeps {
  return {
    db: () => {
      try {
        return getSupabaseAdmin() as unknown as ReturnType<AccessServiceDeps['db']>;
      } catch {
        return null;
      }
    },
    signal: request.signal,
  };
}

const CONFLICT: ReadonlySet<AccessGroupsReason> = new Set([
  'group_exists',
  'member_exists',
  'count_required',
  'mapping_exists',
  'rule_exists',
  'access_managed_by_connector',
]);

/** Reasons that only a broken guard could produce (the actor always comes from it): reported as unavailable, never as the caller's fault. */
const INTERNAL: ReadonlySet<AccessGroupsReason> = new Set(['actor_required']);

/**
 * UI-SPEC 8.2: a known reason is the error code (409 for conflicts, 404 for an unknown or other-tenant id, 400 otherwise); anything else
 * is 503 access_groups_unavailable. Logs carry the function, the SQL state and the reason only.
 */
export function failureOf(error: unknown): NextResponse {
  if (error instanceof AccessGroupsError && error.reason !== null && !INTERNAL.has(error.reason)) {
    const reason = error.reason;
    if (reason === 'not_found') return fail(404, 'not_found');
    if (reason === 'count_required') return fail(409, 'count_required', undefined, error.count === null ? undefined : { count: error.count });
    if (CONFLICT.has(reason)) return fail(409, reason);
    return fail(400, reason);
  }
  console.error(`${TAG} access groups route failed`, {
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof AccessGroupsError ? { rpc: error.rpc, code: error.code, reason: error.reason } : {}),
  });
  return fail(503, 'access_groups_unavailable');
}

/** The wire shape of one group (camelCase, as the services return it). */
export function groupOf(group: AccessGroup) {
  return { id: group.id, key: group.key, name: group.name, source: group.source, createdAt: group.createdAt };
}

/** The wire shape of one document's audience (UI-SPEC 8.1): groups as id and name pairs, never keys. */
export function audienceOf(audience: DocumentAudience) {
  return {
    documentId: audience.documentId,
    filename: audience.filename,
    docType: audience.docType,
    source: audience.source,
    status: audience.status,
    createdAt: audience.createdAt,
    kind: audience.kind,
    groups: audience.groupIds.map((id, index) => ({ id, name: audience.groupNames[index] ?? null })),
    peopleCount: audience.peopleCount,
    fallbackReason: audience.fallbackReason,
    connectorManaged: audience.connectorManaged,
  };
}

/** The wire shape of the Enforcement view (UI-SPEC 6.6): codes, object names, the embed group and the check time as ISO text. */
export function enforcementStatusOf(status: AccessStatus) {
  return {
    runningSwitch: status.runningSwitch,
    databaseFlag: status.databaseFlag,
    status: status.status,
    ready: status.ready,
    reasons: status.reasons,
    objects: status.objects,
    embedGroup: status.embedGroup,
    checkedAt: status.checkedAt === null ? null : new Date(status.checkedAt).toISOString(),
  };
}

/** A-10: connector mappings and sharing rules change who sees a document only in single-tenant mode. */
export function connectorVisibilityApplies(): boolean {
  return getDeploymentMode() === 'single-tenant';
}

/** The wire shape of one connector mapping row; the source id is returned exactly as the source gave it. */
export function mappingRowOf(row: ConnectorMapRow) {
  return { id: row.id, provider: row.provider, kind: row.kind, externalPrincipalId: row.externalPrincipalId, groupId: row.groupId, documents: row.documents };
}
