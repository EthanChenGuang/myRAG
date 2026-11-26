import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { z } from 'zod/v3';
import { deleteTerminologyEntry, updateTerminologyEntry } from '@/lib/rag';
import { DeleteQuerySchema, PatchBodySchema, TAG, fail, failure, invalid, layerKeyFor, ok, queryOf, readJson } from '../_lib';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const IdSchema = z.string().uuid();

async function entryId(context: Context): Promise<string | null> {
  const parsed = IdSchema.safeParse((await context.params).id);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

/** Changes fields of one entry; the stored entry is merged with the patch, validated and replaced under expected_version (D-05, D-24). */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const id = await entryId(context);
  if (id === null) return fail(404, 'Not found');
  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = PatchBodySchema.safeParse(json.body);
  if (!parsed.success) return invalid(parsed.error);
  const { layer: layerName, organization_id, expected_version, ...patch } = parsed.data;

  const layer = await layerKeyFor(admin.userId, layerName, organization_id, request.signal);
  if (!layer.ok) return layer.response;

  const result = await updateTerminologyEntry({
    actorUserId: admin.userId,
    layerKey: layer.layerKey,
    entryId: id,
    expectedVersion: expected_version,
    patch,
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  console.log(`${TAG} terminology entry updated`, { action: 'update', layer: layerName, layerVersion: result.layerVersion });
  return ok({ entry_id: result.entryId, layer_version: result.layerVersion, entries_sha256: result.entriesSha256, warnings: result.warnings });
}

/** Deletes one entry of a layer under expected_version (query parameters: layer, organization_id, expected_version). */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const id = await entryId(context);
  if (id === null) return fail(404, 'Not found');
  const parsed = DeleteQuerySchema.safeParse(queryOf(request));
  if (!parsed.success) return invalid(parsed.error);

  const layer = await layerKeyFor(admin.userId, parsed.data.layer, parsed.data.organization_id, request.signal);
  if (!layer.ok) return layer.response;

  const result = await deleteTerminologyEntry({
    actorUserId: admin.userId,
    layerKey: layer.layerKey,
    entryId: id,
    expectedVersion: parsed.data.expected_version,
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  console.log(`${TAG} terminology entry deleted`, { action: 'delete', layer: parsed.data.layer, layerVersion: result.layerVersion });
  return ok({ layer_version: result.layerVersion, entries_sha256: result.entriesSha256 });
}
