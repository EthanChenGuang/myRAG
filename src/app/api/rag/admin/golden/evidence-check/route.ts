import { z } from 'zod/v3';
import { MAX_DOCUMENT_NAME_CHARS, MAX_EVIDENCE_SPANS, MAX_QUOTE_CHARS, checkEvidence } from '@/lib/rag/monitor/golden-evidence';
import { fail, goldenGuard, invalid, jsonNoStore, readJson, tenantAccess, unavailable } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z
  .object({
    tenant: z.string().min(1).max(64),
    spans: z
      .array(
        z
          .object({
            item_id: z.string().min(1).max(200),
            document: z.string().min(1).max(MAX_DOCUMENT_NAME_CHARS),
            quote: z.string().min(1).max(MAX_QUOTE_CHARS),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_EVIDENCE_SPANS),
  })
  .strict();

/**
 * D-48: one status per gold span (ok, document_missing, document_superseded, quote_not_found) with the resolved document id, checked
 * under the requested tenant only. The response never carries a quote, chunk text or document name.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await goldenGuard(request);
  if (!guard.ok) return guard.response;
  const raw = await readJson(request);
  if (!raw.ok) return fail(400, 'Invalid JSON body');
  const parsed = Body.safeParse(raw.body);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const access = await tenantAccess(guard.userId, parsed.data.tenant);
    if (!access.ok) return access.response;
    const result = await checkEvidence(access.admin, { tenantKey: access.tenantKey, spans: parsed.data.spans });
    return jsonNoStore({ success: true, results: result.results, counts: result.counts });
  } catch (error) {
    console.error('[Monitor] golden evidence check failed', { code: error instanceof Error ? error.message : 'unknown' });
    return unavailable();
  }
}
