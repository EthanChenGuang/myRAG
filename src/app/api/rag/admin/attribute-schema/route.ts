import { z } from 'zod/v3';
import {
  deleteAttributeDefinition,
  docAttributesEnabled,
  listAttributeDefinitions,
  upsertAttributeDefinition,
  type AttributeDefinitionEntry,
} from '@/lib/rag';
import { AttributeDefinitionSchema } from '@/lib/rag-eval/contracts.generated';
import { admit, invalidRequest, issues, jsonBody, jsonNoStore, notFoundUnless, tenantDataFailure } from '../_tenant-data/lib';

export const runtime = 'nodejs';

const KeySchema = AttributeDefinitionSchema.shape.key;

/** The contract plus D-22: only a code key can feed the identifier index. */
const DefinitionSchema = AttributeDefinitionSchema.superRefine((definition, ctx) => {
  if (definition.in_identifier_index && definition.type !== 'code') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['in_identifier_index'], message: 'Only a code key can be in the identifier index' });
  }
});
const UpsertSchema = z.object({ definition: DefinitionSchema }).strict();

/** An explicit allow-list; the tenant key and the actor never leave. */
function projectDefinition(item: AttributeDefinitionEntry) {
  return {
    key: item.key,
    type: item.type,
    filterable: item.filterable,
    in_header: item.in_header,
    in_identifier_index: item.in_identifier_index,
    soft: item.soft,
    updated_at: item.updatedAt,
  };
}

/** The workspace's attribute definitions in key order. */
export async function GET(request: Request): Promise<Response> {
  const off = notFoundUnless(docAttributesEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;

  const result = await listAttributeDefinitions({ actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal });
  if (!result.ok) return tenantDataFailure(result);
  console.log('[RAG Admin] attribute definitions listed', { count: result.items.length });
  return jsonNoStore({ success: true, items: result.items.map(projectDefinition) });
}

/** Creates one key or changes its flags; the type of a stored key never changes. */
export async function PUT(request: Request): Promise<Response> {
  const off = notFoundUnless(docAttributesEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = UpsertSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await upsertAttributeDefinition(
    { actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal },
    parsed.data.definition,
  );
  if (!result.ok) return tenantDataFailure(result);
  console.log('[RAG Admin] attribute definition saved', { type: result.item.type });
  return jsonNoStore({ success: true, item: projectDefinition(result.item) });
}

/** Deletes one key by `?key=`; values stored on documents stay until an import replaces them. */
export async function DELETE(request: Request): Promise<Response> {
  const off = notFoundUnless(docAttributesEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const key = KeySchema.safeParse(new URL(request.url).searchParams.get('key'));
  if (!key.success) return invalidRequest([{ path: 'key', message: 'Expected an attribute key' }]);

  const result = await deleteAttributeDefinition({ actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal }, key.data);
  if (!result.ok) return tenantDataFailure(result);
  console.log('[RAG Admin] attribute definition deleted');
  return jsonNoStore({ success: true, key: result.key });
}
