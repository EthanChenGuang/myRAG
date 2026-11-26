import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { importTerminology, scopeKey } from '@/lib/rag';
import { IMPORT_BODY_MAX_BYTES, ImportBodySchema, TAG, fail, failure, invalid, layerKeyFor, ok, readLimitedJson, workspaceScope } from '../_lib';

export const runtime = 'nodejs';

/**
 * D-23, D-25a: CSV or DictionaryCandidate JSONL import into one layer. dry_run (the default) reports the diff and the issues and
 * writes nothing; dry_run false with the version the dry run saw re-validates and applies every row or none.
 */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const json = await readLimitedJson(request, IMPORT_BODY_MAX_BYTES);
  if (!json.ok) return json.response;
  const parsed = ImportBodySchema.safeParse(json.body);
  if (!parsed.success) return invalid(parsed.error);
  const body = parsed.data;

  const layer = await layerKeyFor(admin.userId, body.layer, body.organization_id, request.signal);
  if (!layer.ok) return layer.response;
  let workspaceTenantKey: string | null = null;
  if (body.format === 'dictionary_candidates_jsonl') {
    const workspace = await workspaceScope(admin.userId, body.organization_id, request.signal);
    if (!workspace.ok) return workspace.response;
    workspaceTenantKey = scopeKey(workspace.scope);
  }

  const result = await importTerminology({
    actorUserId: admin.userId,
    layerKey: layer.layerKey,
    mode: body.mode,
    format: body.format,
    content: (body.format === 'csv' ? body.csv : body.jsonl) ?? '',
    dryRun: body.dry_run,
    expectedVersion: body.expected_version ?? null,
    workspaceTenantKey,
    signal: request.signal,
  });
  if (!result.ok) {
    if (result.reason === 'invalid_file') return fail(400, 'invalid_file', { errors: result.errors });
    if (result.reason === 'invalid' && result.report) return fail(422, 'Validation failed', { issues: result.issues ?? [], report: result.report });
    return failure(result);
  }
  const { report } = result;
  if (report.applied) {
    console.log(`${TAG} terminology import applied`, {
      layer: body.layer,
      mode: body.mode,
      format: body.format,
      created: report.create,
      updated: report.update,
      deleted: report.delete,
      layerVersion: result.layerVersion,
    });
    return ok({ report, layer_version: result.layerVersion, entries_sha256: result.entriesSha256 });
  }
  return ok({ report });
}
