import { z } from 'zod/v3';
import { deleteBoilerplateRule, listBoilerplateRules, pageBoilerplateEnabled, saveBoilerplateRule, type StoredBoilerplateRule } from '@/lib/rag';
import { BoilerplateRuleSchema } from '@/lib/rag-eval/contracts.generated';
import { admit, invalidRequest, issues, jsonBody, jsonNoStore, notFoundUnless, tenantDataFailure } from '../_tenant-data/lib';

export const runtime = 'nodejs';

const IdSchema = z.string().uuid();

/** The contract plus its kind split: a line rule has a pattern and flags only, a fragment rule a length and a page share only. */
const RuleSchema = BoilerplateRuleSchema.superRefine((rule, ctx) => {
  const line = rule.kind === 'line';
  const fields = { pattern: line, flags: line, max_length: !line, min_page_share: !line } as const;
  for (const [field, required] of Object.entries(fields)) {
    const present = rule[field as keyof typeof fields] !== undefined;
    if (present !== required) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: required ? `Required for kind ${rule.kind}` : `Not allowed for kind ${rule.kind}` });
    }
  }
});
const CreateSchema = z.object({ rule: RuleSchema }).strict();
const ReplaceSchema = z.object({ id: IdSchema, rule: RuleSchema }).strict();

const patternPath = () => 'rule.pattern';

/** An explicit allow-list of the contract fields plus id, version and updated_at; the tenant key and the actor never leave. */
function projectRule(item: StoredBoilerplateRule) {
  const rule = item.rule;
  return {
    id: item.id,
    name: rule.name,
    kind: rule.kind,
    pattern: rule.pattern ?? null,
    flags: rule.flags ?? null,
    max_length: rule.max_length ?? null,
    min_page_share: rule.min_page_share ?? null,
    doc_type: rule.doc_type ?? null,
    source: rule.source ?? null,
    enabled: rule.enabled,
    version: item.version,
    updated_at: item.updatedAt,
  };
}

/** The workspace's boilerplate rules in creation order. */
export async function GET(request: Request): Promise<Response> {
  const off = notFoundUnless(pageBoilerplateEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;

  const result = await listBoilerplateRules({ actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal });
  if (!result.ok) return tenantDataFailure(result);
  console.log('[RAG Admin] boilerplate rules listed', { count: result.items.length });
  return jsonNoStore({ success: true, items: result.items.map(projectRule) });
}

/** Creates one rule; a line rule's pattern passes the save-time check before the write. */
export async function POST(request: Request): Promise<Response> {
  const off = notFoundUnless(pageBoilerplateEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = CreateSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await saveBoilerplateRule({ actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal }, parsed.data.rule);
  if (!result.ok) return tenantDataFailure(result, patternPath);
  console.log('[RAG Admin] boilerplate rule created', { id: result.item.id, version: result.item.version });
  return jsonNoStore({ success: true, item: projectRule(result.item) }, 201);
}

/** Replaces every field of one rule; its version rises by one. */
export async function PUT(request: Request): Promise<Response> {
  const off = notFoundUnless(pageBoilerplateEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = ReplaceSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await saveBoilerplateRule(
    { actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal },
    parsed.data.rule,
    parsed.data.id,
  );
  if (!result.ok) return tenantDataFailure(result, patternPath);
  console.log('[RAG Admin] boilerplate rule replaced', { id: result.item.id, version: result.item.version });
  return jsonNoStore({ success: true, item: projectRule(result.item) });
}

/** Deletes one rule by `?id=`; an unknown and another workspace's id get the same 404. */
export async function DELETE(request: Request): Promise<Response> {
  const off = notFoundUnless(pageBoilerplateEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const id = IdSchema.safeParse(new URL(request.url).searchParams.get('id'));
  if (!id.success) return invalidRequest([{ path: 'id', message: 'Expected a uuid' }]);

  const result = await deleteBoilerplateRule({ actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal }, id.data);
  if (!result.ok) return tenantDataFailure(result);
  console.log('[RAG Admin] boilerplate rule deleted', { id: result.id });
  return jsonNoStore({ success: true, id: result.id });
}
