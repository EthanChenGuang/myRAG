import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { setTerminologySuppression } from '@/lib/rag';
import { SuppressionBodySchema, TAG, failure, invalid, layerKeyFor, ok, readJson } from '../_lib';

export const runtime = 'nodejs';

/** Suppresses (suppressed: true) or releases one shared entry for the admin's workspace; refused in single-tenant mode (D-02, D-03). */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = SuppressionBodySchema.safeParse(json.body);
  if (!parsed.success) return invalid(parsed.error);

  const layer = await layerKeyFor(admin.userId, 'workspace', parsed.data.organization_id, request.signal);
  if (!layer.ok) return layer.response;

  const result = await setTerminologySuppression({
    actorUserId: admin.userId,
    layerKey: layer.layerKey,
    sharedEntryId: parsed.data.shared_entry_id.toLowerCase(),
    suppressed: parsed.data.suppressed,
    expectedVersion: parsed.data.expected_version,
    signal: request.signal,
  });
  if (!result.ok) return failure(result);
  console.log(`${TAG} terminology suppression set`, { action: result.suppressed ? 'suppress' : 'unsuppress', layerVersion: result.layerVersion });
  return ok({ layer_version: result.layerVersion, entries_sha256: result.entriesSha256, suppressed: result.suppressed });
}
