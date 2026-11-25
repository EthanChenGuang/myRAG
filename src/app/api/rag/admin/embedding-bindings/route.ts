import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import {
  BINDING_DOC_TYPES,
  createBinding,
  getBindingCompleteness,
  isDomainEmbeddingsEnabled,
  isEmbeddingProfilesEnabled,
  listBindings,
  listEmbeddingProfiles,
  listProfileScopes,
  setBindingStatus,
} from '@/lib/rag';
import type { BindingCompleteness } from '@/lib/rag';
import {
  DocTypeSchema,
  PROFILE_ID_PATTERN,
  TenantKeySchema,
  adminActor,
  bindingsUnavailable,
  invalidRequest,
  issues,
  jsonNoStore,
  readJsonBody,
  refusalResponse,
} from './_responses';

export const runtime = 'nodejs';

const QuerySchema = z.object({ completeness: z.enum(['true', 'false']).default('true') });

const PostSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), doc_type: DocTypeSchema, profile_id: z.string().regex(PROFILE_ID_PATTERN), tenant_key: TenantKeySchema }).strict(),
  /** active is set only by the activation gate; the SQL refuses it too. */
  z.object({ action: z.literal('set_status'), binding_id: z.string().uuid(), status: z.enum(['available', 'backfilling', 'retired']) }).strict(),
]);

function completenessBody(entry: BindingCompleteness | undefined): Record<string, unknown> | null {
  if (!entry) return null;
  if (entry.state === 'unavailable') return { state: 'unavailable' };
  return { state: 'measured', chunks: entry.chunks, missing: entry.missing, percent: entry.percent };
}

/**
 * Every binding with its profile, status, stale flag, whether evidence exists (never its body) and, for backfilling and active bindings, how
 * complete its profile's vectors are in its scope; also the switches, the global active profile and the profiles a binding may name.
 * `?completeness=false` skips the counts.
 */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const parsed = QuerySchema.safeParse({ completeness: new URL(request.url).searchParams.get('completeness') ?? undefined });
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  try {
    const [entries, profiles, scopes] = await Promise.all([listBindings(), listEmbeddingProfiles(), listProfileScopes()]);
    const completeness = parsed.data.completeness === 'true' ? await getBindingCompleteness(entries, request.signal) : {};
    const models = new Map(profiles.map((profile) => [profile.id, profile.model]));
    console.log('[Embedding Binding] admin action', { action: 'list', count: entries.length });
    return jsonNoStore({
      success: true,
      switch: isDomainEmbeddingsEnabled() ? 'on' : 'off',
      profiles_switch: isEmbeddingProfilesEnabled() ? 'on' : 'off',
      global_active: profiles.find((profile) => profile.status === 'active')?.id ?? null,
      doc_types: [...BINDING_DOC_TYPES],
      profiles: profiles.map((profile) => ({
        id: profile.id,
        provider: profile.provider,
        model: profile.model,
        dims: profile.dims,
        status: profile.status,
        doc_types: scopes[profile.id] ?? null,
      })),
      bindings: entries.map((entry) => ({
        id: entry.id,
        doc_type: entry.docType,
        tenant_key: entry.tenantKey,
        profile_id: entry.profileId,
        model: models.get(entry.profileId) ?? null,
        status: entry.status,
        stale: entry.stale,
        has_evidence: entry.hasEvidence,
        baseline_global_profile: entry.baselineGlobalProfile,
        previous_binding_id: entry.previousBindingId,
        activated_at: entry.activatedAt,
        activated_by: entry.activatedBy,
        created_at: entry.createdAt,
        completeness: completenessBody(completeness[entry.id]),
      })),
    });
  } catch (error) {
    return bindingsUnavailable('list', null, error);
  }
}

/** `create` adds an available binding (or returns the existing one for the same key and profile); `set_status` stages, frees or retires one. */
export async function POST(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const parsed = PostSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));
  const input = parsed.data;
  const actor = adminActor(admin.userId);

  if (input.action === 'create') {
    try {
      const result = await createBinding(input.doc_type, input.tenant_key, input.profile_id, actor);
      if (!result.ok) return refusalResponse('create', null, result);
      console.log('[Embedding Binding] admin action', { action: 'create', bindingId: result.bindingId, created: result.created });
      return jsonNoStore({ success: true, binding_id: result.bindingId, status: result.status, created: result.created }, result.created ? 201 : 200);
    } catch (error) {
      return bindingsUnavailable('create', null, error);
    }
  }

  try {
    const result = await setBindingStatus(input.binding_id, input.status, actor);
    if (!result.ok) return refusalResponse('set_status', input.binding_id, result);
    console.log('[Embedding Binding] admin action', { action: 'set_status', bindingId: result.bindingId, status: result.status });
    return jsonNoStore({ success: true, binding_id: result.bindingId, status: result.status });
  } catch (error) {
    return bindingsUnavailable('set_status', input.binding_id, error);
  }
}
