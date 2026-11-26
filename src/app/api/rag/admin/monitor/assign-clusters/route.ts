import { z } from 'zod/v3';
import { assignTestItems, MAX_ASSIGN_ITEMS, MAX_ASSIGN_QUESTION_CHARS, monitorSettings } from '@/lib/rag';
import { invalidRequest, issues, jsonBody, jsonNoStore, notFoundUnless } from '../../_tenant-data/lib';
import { admitTenant, guardAdmin, monitorUnavailable } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const BodySchema = z
  .object({
    tenant: z.string().min(1).max(64),
    items: z
      .array(
        z
          .object({
            item_id: z.string().regex(ITEM_ID_RE, 'item_id must be an id token'),
            question: z.string().trim().min(1).max(MAX_ASSIGN_QUESTION_CHARS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ASSIGN_ITEMS),
  })
  .strict()
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.items.forEach((item, index) => {
      if (seen.has(item.item_id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items', index, 'item_id'], message: 'item ids must be distinct' });
      seen.add(item.item_id);
    });
  });

/**
 * D-42: places up to 500 test items (id and question) in the tenant's current production clusters for python -m
 * rag_eval.representativeness. 404 while RAG_REPRESENTATIVE_SAMPLE is off, checked before the admin Bearer guard; the tenant must be
 * one the admin administers. Questions are masked again and embedded in memory; the answer holds item ids and cluster ids only, and
 * nothing is stored or logged but counts.
 */
export async function POST(request: Request): Promise<Response> {
  const off = notFoundUnless(monitorSettings().representativeSample);
  if (off) return off;
  const guard = await guardAdmin(request);
  if (!guard.ok) return guard.response;
  const body = await jsonBody(request);
  if (!body.ok) return body.response;
  const parsed = BodySchema.safeParse(body.body);
  if (!parsed.success) return invalidRequest(issues(parsed.error));
  try {
    const admitted = await admitTenant(guard.userId, parsed.data.tenant);
    if (!admitted.ok) return admitted.response;
    const result = await assignTestItems(admitted.admin, { tenantKey: admitted.tenantKey, items: parsed.data.items, signal: request.signal });
    if (!result.ok) return jsonNoStore({ success: false, error: result.reason }, 409);
    return jsonNoStore({ success: true, set_id: result.setId, embedder: result.embedder, assignments: result.assignments });
  } catch {
    console.error('[Monitor] assign-clusters route failed');
    return monitorUnavailable();
  }
}
