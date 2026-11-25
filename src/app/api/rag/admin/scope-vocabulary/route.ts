import { z } from 'zod/v3';
import { checkAdminOrOrgAdmin } from '@/lib/admin-route-auth';
import { createVocabularyEntry, listVocabulary, SCOPE_DIMENSIONS, updateVocabularyEntry } from '@/lib/rag';
import { ScopeVocabularyEntrySchema } from '@/lib/rag-eval/contracts.generated';
import { OrganizationIdSchema, admission, invalidRequest, issues, jsonBody, jsonNoStore, projectEntry, scopeFailure, switchedOff } from './_lib';

export const runtime = 'nodejs';

const QuerySchema = z.object({ organizationId: OrganizationIdSchema });

const EntryFields = ScopeVocabularyEntrySchema.shape;

const CreateSchema = z
  .object({
    dimension: EntryFields.dimension,
    /** Normalized to the contract's slug by the service ('Area  A' is 'area-a'); a duplicate after normalization is tag_exists. */
    value: z.string().min(1).max(200),
    label: EntryFields.label,
    aliases: EntryFields.aliases,
  })
  .strict();

/** Label, other names and the active flag change; the dimension and value, when sent, must be the stored ones. */
const UpdateSchema = z
  .object({
    id: z.string().uuid(),
    label: EntryFields.label.optional(),
    aliases: EntryFields.aliases,
    active: z.boolean().optional(),
    dimension: EntryFields.dimension.optional(),
    value: z.string().max(200).optional(),
  })
  .strict();

async function admit(request: Request) {
  const query = QuerySchema.safeParse({ organizationId: new URL(request.url).searchParams.get('organizationId') });
  const admitted = admission(await checkAdminOrOrgAdmin(request, query.success ? query.data.organizationId : null));
  if (!admitted.ok) return admitted;
  if (!query.success) return { ok: false as const, response: invalidRequest(issues(query.error)) };
  return admitted;
}

/** The workspace's vocabulary, dimensions in their fixed order (UI-SPEC 6.7). */
export async function GET(request: Request): Promise<Response> {
  const off = switchedOff();
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;

  const result = await listVocabulary({ actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal });
  if (!result.ok) return scopeFailure(result.reason);
  console.log('[RAG Admin] scope vocabulary listed', { count: result.items.length });
  return jsonNoStore({ success: true, dimensions: SCOPE_DIMENSIONS, items: result.items.map(projectEntry) });
}

/** Creates one value of a dimension. The actor is the verified user, never the body. */
export async function POST(request: Request): Promise<Response> {
  const off = switchedOff();
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = CreateSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await createVocabularyEntry({
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    signal: request.signal,
    dimension: parsed.data.dimension,
    value: parsed.data.value,
    label: parsed.data.label,
    aliases: parsed.data.aliases ?? [],
  });
  if (!result.ok) return scopeFailure(result.reason, 'Tag not found');
  console.log('[RAG Admin] scope value created', { id: result.item.id, dimension: result.item.dimension });
  return jsonNoStore({ success: true, item: projectEntry(result.item) }, 201);
}

/** Edits the label or other names, retires (active false) or restores a value. A value is never deleted. */
export async function PATCH(request: Request): Promise<Response> {
  const off = switchedOff();
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = UpdateSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await updateVocabularyEntry({
    actorUserId: admitted.actorUserId,
    tenantKey: admitted.tenantKey,
    signal: request.signal,
    ...parsed.data,
  });
  if (!result.ok) return scopeFailure(result.reason, 'Tag not found');
  console.log('[RAG Admin] scope value updated', { id: result.item.id, active: result.item.active });
  return jsonNoStore({ success: true, item: projectEntry(result.item) });
}
