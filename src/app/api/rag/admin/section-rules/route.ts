import { z } from 'zod/v3';
import { deleteSectionRuleSet, listSectionRuleSets, saveSectionRuleSet, sectionRulesEnabled, type StoredSectionRuleSet } from '@/lib/rag';
import { SectionRuleSetSchema } from '@/lib/rag-eval/contracts.generated';
import { admit, invalidRequest, issues, jsonBody, jsonNoStore, notFoundUnless, tenantDataFailure } from '../_tenant-data/lib';

export const runtime = 'nodejs';

const IdSchema = z.string().uuid();
const CreateSchema = z.object({ rule_set: SectionRuleSetSchema }).strict();
const ReplaceSchema = z.object({ id: IdSchema, rule_set: SectionRuleSetSchema }).strict();

const headingPath = (index: number) => `rule_set.headings.${index}.pattern`;

/** An explicit allow-list: the tenant key, the actor and any later column stay out of the answer until added here on purpose. */
function projectRuleSet(item: StoredSectionRuleSet) {
  const ruleSet = item.ruleSet;
  return {
    id: item.id,
    name: ruleSet.name,
    doc_type: ruleSet.doc_type ?? null,
    source: ruleSet.source ?? null,
    enabled: ruleSet.enabled,
    version: item.version,
    headings: ruleSet.headings,
    require_increasing_numbers: ruleSet.require_increasing_numbers,
    skip_toc: ruleSet.skip_toc,
    toc_min_run: ruleSet.toc_min_run,
    updated_at: item.updatedAt,
  };
}

/** The workspace's section rule sets in creation order. */
export async function GET(request: Request): Promise<Response> {
  const off = notFoundUnless(sectionRulesEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;

  const result = await listSectionRuleSets({ actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal });
  if (!result.ok) return tenantDataFailure(result);
  console.log('[RAG Admin] section rule sets listed', { count: result.items.length });
  return jsonNoStore({ success: true, items: result.items.map(projectRuleSet) });
}

/** Creates one rule set; every heading pattern passes the save-time check before the write. */
export async function POST(request: Request): Promise<Response> {
  const off = notFoundUnless(sectionRulesEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = CreateSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await saveSectionRuleSet(
    { actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal },
    parsed.data.rule_set,
  );
  if (!result.ok) return tenantDataFailure(result, headingPath);
  console.log('[RAG Admin] section rule set created', { id: result.item.id, version: result.item.version });
  return jsonNoStore({ success: true, item: projectRuleSet(result.item) }, 201);
}

/** Replaces every field of one rule set; its version rises by one. */
export async function PUT(request: Request): Promise<Response> {
  const off = notFoundUnless(sectionRulesEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const read = await jsonBody(request);
  if (!read.ok) return read.response;
  const parsed = ReplaceSchema.safeParse(read.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));

  const result = await saveSectionRuleSet(
    { actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal },
    parsed.data.rule_set,
    parsed.data.id,
  );
  if (!result.ok) return tenantDataFailure(result, headingPath);
  console.log('[RAG Admin] section rule set replaced', { id: result.item.id, version: result.item.version });
  return jsonNoStore({ success: true, item: projectRuleSet(result.item) });
}

/** Deletes one rule set by `?id=`; an unknown and another workspace's id get the same 404. */
export async function DELETE(request: Request): Promise<Response> {
  const off = notFoundUnless(sectionRulesEnabled());
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const id = IdSchema.safeParse(new URL(request.url).searchParams.get('id'));
  if (!id.success) return invalidRequest([{ path: 'id', message: 'Expected a uuid' }]);

  const result = await deleteSectionRuleSet({ actorUserId: admitted.actorUserId, tenantKey: admitted.tenantKey, signal: request.signal }, id.data);
  if (!result.ok) return tenantDataFailure(result);
  console.log('[RAG Admin] section rule set deleted', { id: result.id });
  return jsonNoStore({ success: true, id: result.id });
}
