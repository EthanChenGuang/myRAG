import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { createTerminologyEntry, listTerminologyEntries } from '@/lib/rag';
import { CreateBodySchema, ListQuerySchema, TAG, failure, invalid, layerKeyFor, ok, queryOf, readJson } from './_lib';

export const runtime = 'nodejs';

/** One page of a dictionary layer with its version and the deployment's enabled languages (D-05, D-35). */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = ListQuerySchema.safeParse(queryOf(request));
  if (!parsed.success) return invalid(parsed.error);
  const query = parsed.data;

  const layer = await layerKeyFor(admin.userId, query.layer, query.organization_id, request.signal);
  if (!layer.ok) return layer.response;

  const result = await listTerminologyEntries({
    actorUserId: admin.userId,
    layerKey: layer.layerKey,
    limit: query.limit ?? undefined,
    offset: query.offset ?? undefined,
    search: query.search ?? null,
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  return ok({
    layer: query.layer,
    layer_version: result.layerVersion,
    entries_sha256: result.entriesSha256,
    enabled_languages: result.enabledLanguages,
    items: result.items,
    total: result.total,
    limit: result.limit,
    offset: result.offset,
  });
}

/** Creates an entry of any kind, translation pairs included; the actor is the verified admin, the tenant the resolved scope (D-03, D-24). */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = CreateBodySchema.safeParse(json.body);
  if (!parsed.success) return invalid(parsed.error);
  const { layer: layerName, organization_id, expected_version, ...entry } = parsed.data;

  const layer = await layerKeyFor(admin.userId, layerName, organization_id, request.signal);
  if (!layer.ok) return layer.response;

  const result = await createTerminologyEntry({
    actorUserId: admin.userId,
    layerKey: layer.layerKey,
    expectedVersion: expected_version,
    entry: { ...entry, variants: entry.variants ?? [] },
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  console.log(`${TAG} terminology entry created`, { action: 'create', layer: layerName, kind: entry.kind, layerVersion: result.layerVersion });
  return ok(
    { entry_id: result.entryId, layer_version: result.layerVersion, entries_sha256: result.entriesSha256, warnings: result.warnings },
    201,
  );
}
