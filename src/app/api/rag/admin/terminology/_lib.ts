import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { TerminologyEntrySchema } from '@/lib/rag-eval/contracts.generated';
import { resolveAdminWorkspaceScope, scopeKey, terminologyEnabledLanguages, type TerminologyAdminFailed } from '@/lib/rag';

export const TAG = '[RAG Admin]';
export const NO_STORE = { 'Cache-Control': 'no-store' };

type Details = Array<{ path: string; message: string }>;

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ success: false, error, ...extra }, { status, headers: NO_STORE });
}

export function ok(body: Record<string, unknown>, status = 200): NextResponse {
  return NextResponse.json({ success: true, ...body }, { status, headers: NO_STORE });
}

export const invalid = (error: z.ZodError): NextResponse =>
  fail(400, 'Invalid request data', { details: error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) as Details });

/** The parsed JSON body, or the 400 for a body that is not JSON. */
export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: fail(400, 'Invalid request data', { details: [{ path: '', message: 'Body is not valid JSON' }] }) };
  }
}

export const LayerSchema = z.enum(['shared', 'workspace']);
export type Layer = z.infer<typeof LayerSchema>;
const OrganizationId = z.string().uuid().nullish();
const ExpectedVersion = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const QueryInt = (max: number) => z.coerce.number().int().min(0).max(max);

/** The entry fields of the generated contract; id, layer and suppression come from the URL and the scope, never from the body. */
const EntryFields = TerminologyEntrySchema.omit({ id: true, layer: true, suppresses_entry_id: true });
const Target = { layer: LayerSchema, organization_id: OrganizationId, expected_version: ExpectedVersion };

/** Strict: a body naming an actor, a tenant key or any other unknown field is a 400 (T-0411-24). */
export const CreateBodySchema = EntryFields.extend(Target).strict();
export const PatchBodySchema = EntryFields.partial().extend(Target).strict();
export const SuppressionBodySchema = z
  .object({ organization_id: OrganizationId, shared_entry_id: z.string().uuid(), suppressed: z.boolean(), expected_version: ExpectedVersion })
  .strict();
export const ListQuerySchema = z
  .object({
    layer: LayerSchema.default('shared'),
    organization_id: OrganizationId,
    search: z.string().max(64).nullish(),
    limit: QueryInt(100).nullish(),
    offset: QueryInt(1_000_000).nullish(),
  })
  .strict();
export const DeleteQuerySchema = z.object({ layer: LayerSchema, organization_id: OrganizationId, expected_version: z.coerce.number().int().min(0) }).strict();
export const VersionsQuerySchema = z.object({ organization_id: OrganizationId }).strict();
export const AuditQuerySchema = z
  .object({ layer: LayerSchema.default('shared'), organization_id: OrganizationId, limit: QueryInt(100).nullish(), offset: QueryInt(1_000_000).nullish() })
  .strict();

/** The search params as an object; a repeated parameter is a 400 like any malformed value. */
export function queryOf(request: Request): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const seen = query[key];
    query[key] = seen === undefined ? value : Array.isArray(seen) ? [...seen, value] : [seen, value];
  }
  return query;
}

const WORKSPACE_UNAVAILABLE = () => fail(400, 'workspace_layer_unavailable');

/**
 * D-03: the workspace of the verified admin, from resolveAdminWorkspaceScope; its tenant key is the only tenant input of the SQL.
 * Single-tenant deployments have no workspace (null).
 */
export async function workspaceKey(
  adminUserId: string,
  organizationId: string | null | undefined,
  signal: AbortSignal,
): Promise<{ ok: true; key: string | null } | { ok: false; response: NextResponse }> {
  const workspace = await resolveAdminWorkspaceScope({ adminUserId, requestedOrganizationId: organizationId ?? null, signal });
  if (!workspace.ok) {
    return { ok: false, response: fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable') };
  }
  return { ok: true, key: workspace.scope.kind === 'single' ? null : scopeKey(workspace.scope) };
}

/** 'shared' for the shared layer; the workspace's tenant key for the workspace layer, refused in single-tenant mode (D-03). */
export async function layerKeyFor(
  adminUserId: string,
  layer: Layer,
  organizationId: string | null | undefined,
  signal: AbortSignal,
): Promise<{ ok: true; layerKey: string } | { ok: false; response: NextResponse }> {
  if (layer === 'shared') return { ok: true, layerKey: 'shared' };
  const workspace = await workspaceKey(adminUserId, organizationId, signal);
  if (!workspace.ok) return workspace;
  if (workspace.key === null) return { ok: false, response: WORKSPACE_UNAVAILABLE() };
  return { ok: true, layerKey: workspace.key };
}

/** D-35: the deployment's enabled registry codes, so the Config UI never holds a language list. */
export function enabledLanguagesBody(): { enabled_languages: string[] } {
  return { enabled_languages: terminologyEnabledLanguages() };
}

/** Fixed bodies for every service failure; no dictionary text and no database message (T-0411-26). */
export function failure(result: TerminologyAdminFailed): NextResponse {
  switch (result.reason) {
    case 'not_admin':
      return fail(403, 'Forbidden');
    case 'not_found':
      return fail(404, 'Not found');
    case 'version_conflict':
      return fail(409, 'version_conflict', result.currentVersion === undefined ? {} : { current_version: result.currentVersion });
    case 'workspace_layer_unavailable':
      return WORKSPACE_UNAVAILABLE();
    case 'limit':
      return fail(413, 'limit');
    case 'invalid':
      return fail(422, 'Validation failed', { issues: result.issues ?? [] });
    default:
      return fail(503, 'Terminology is unavailable');
  }
}
