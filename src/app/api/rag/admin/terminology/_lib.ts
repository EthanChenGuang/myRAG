import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { TerminologyEntrySchema, TerminologyPreviewRequestSchema } from '@/lib/rag-eval/contracts.generated';
import { resolveAdminWorkspaceScope, scopeKey, terminologyEnabledLanguages, type TenantScope, type TerminologyAdminFailed } from '@/lib/rag';

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

export const IMPORT_BODY_MAX_BYTES = 1.5 * 1024 * 1024;

/** The JSON body of an import, refused with 413 before any parse when it is over 1.5 MB (T-0411-32). */
export async function readLimitedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: fail(413, 'payload_too_large') };
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: fail(400, 'Invalid request data', { details: [{ path: '', message: 'Body could not be read' }] }) };
  }
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return { ok: false, response: fail(413, 'payload_too_large') };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, response: fail(400, 'Invalid request data', { details: [{ path: '', message: 'Body is not valid JSON' }] }) };
  }
}

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
export const ImportBodySchema = z
  .object({
    layer: LayerSchema,
    organization_id: OrganizationId,
    mode: z.enum(['merge', 'replace']).default('merge'),
    format: z.enum(['csv', 'dictionary_candidates_jsonl']).default('csv'),
    csv: z.string().optional(),
    jsonl: z.string().optional(),
    dry_run: z.boolean().default(true),
    expected_version: ExpectedVersion.optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const field = body.format === 'csv' ? 'csv' : 'jsonl';
    const other = field === 'csv' ? 'jsonl' : 'csv';
    if (typeof body[field] !== 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for format ${body.format}` });
    if (body[other] !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [other], message: `${other} is not allowed for format ${body.format}` });
    if (!body.dry_run && body.expected_version === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expected_version'], message: 'expected_version is required to apply' });
    }
  });
/** D-22: the preview body of the contract; the route caps the query at 1,000 characters. */
export const PREVIEW_QUERY_MAX_CHARS = 1000;
export const PreviewBodySchema = TerminologyPreviewRequestSchema.extend({ query: z.string().min(1).max(PREVIEW_QUERY_MAX_CHARS) }).strict();
export const ExportQuerySchema = z.object({ layer: LayerSchema, organization_id: OrganizationId }).strict();
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

/** The minted workspace scope of the verified admin (s:default in single-tenant mode); 403 for an organization the admin is not in. */
export async function workspaceScope(
  adminUserId: string,
  organizationId: string | null | undefined,
  signal: AbortSignal,
): Promise<{ ok: true; scope: TenantScope } | { ok: false; response: NextResponse }> {
  const workspace = await resolveAdminWorkspaceScope({ adminUserId, requestedOrganizationId: organizationId ?? null, signal });
  if (!workspace.ok) {
    return { ok: false, response: fail(workspace.status, workspace.status === 403 ? 'Forbidden' : 'Workspace verification unavailable') };
  }
  return { ok: true, scope: workspace.scope };
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
