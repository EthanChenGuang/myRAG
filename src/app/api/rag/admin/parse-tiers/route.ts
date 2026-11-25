import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { DOC_TYPE_IDS, PARSE_TIERS, ParseAdminError, listTierBounds, setTierOverride } from '@/lib/rag';
import type { TierBoundsItem } from '@/lib/rag';
import { fail, invalid, jsonNoStore } from '../ingest-jobs/_lib';

export const runtime = 'nodejs';

const TierSchema = z.enum(PARSE_TIERS);
const RANK: Record<(typeof PARSE_TIERS)[number], number> = { native: 0, fast: 1, structured: 2, premium: 3 };

const BodySchema = z
  .object({ docType: z.enum(DOC_TYPE_IDS), minTier: TierSchema.nullable(), maxTier: TierSchema.nullable() })
  .strict()
  .superRefine((body, ctx) => {
    if ((body.minTier === null) !== (body.maxTier === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minTier'], message: 'Set both tiers, or send both as null to clear the override' });
    } else if (body.minTier !== null && body.maxTier !== null && RANK[body.minTier] > RANK[body.maxTier]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minTier'], message: 'minTier must not rank above maxTier' });
    }
  });

function itemOf(item: TierBoundsItem) {
  return {
    doc_type: item.docType,
    profile: item.profile,
    override: item.override,
    effective: item.effective,
  };
}

function unavailable(action: string, error: unknown): Response {
  console.error('[RAG Admin] parse tier call failed', {
    action,
    error: error instanceof Error ? error.name : 'unknown',
    ...(error instanceof ParseAdminError ? { rpc: error.rpc, code: error.code } : {}),
  });
  return fail(503, 'Parse tier overrides are unavailable');
}

/** Every document type with its profile bounds, the admin override when one is set, and the bounds in effect (D-13). */
export async function GET(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  try {
    const items = await listTierBounds(request.signal);
    return jsonNoStore({ success: true, items: items.map(itemOf) });
  } catch (error) {
    return unavailable('list', error);
  }
}

/**
 * Sets the override of one document type, or clears it when both tiers are null. The override is deployment-wide, like the profiles it
 * bounds. The actor is the id the guard verified; the body cannot name one.
 */
export async function PUT(request: Request): Promise<Response> {
  const admin = await checkAdmin(request);
  if (!admin.ok) return adminDenied(admin.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Invalid request data', [{ path: '', message: 'Body is not valid JSON' }]);
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  try {
    const item = await setTierOverride({
      docType: parsed.data.docType,
      minTier: parsed.data.minTier,
      maxTier: parsed.data.maxTier,
      actorUserId: admin.userId,
      signal: request.signal,
    });
    console.log('[RAG Admin] parse tier override set', {
      action: 'set_parse_tier_override',
      docType: item.docType,
      cleared: item.override === null,
    });
    return jsonNoStore({ success: true, ...itemOf(item) });
  } catch (error) {
    return unavailable('set', error);
  }
}
