import { z } from 'zod/v3';
import { MAX_REGISTER_ROWS, clearEvidence, pendingEvidence, registerEvidence } from '@/lib/rag';
import { fail, goldenGuard, invalid, jsonNoStore, readJson, tenantAccess, unavailable } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SetId = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,199}$/);
const ItemId = z.string().min(1).max(200);

const RegisterBody = z
  .object({
    action: z.literal('register').optional(),
    tenant: z.string().min(1).max(64),
    set_id: SetId,
    rows: z
      .array(
        z
          .object({
            item_id: ItemId,
            document_id: z.string().uuid(),
            quote_sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .max(MAX_REGISTER_ROWS),
  })
  .strict();

const ClearBody = z
  .object({ action: z.literal('clear'), tenant: z.string().min(1).max(64), set_id: SetId, item_ids: z.array(ItemId).min(1).max(MAX_REGISTER_ROWS) })
  .strict();

const PendingQuery = z.object({ tenant: z.string().min(1).max(64), set_id: SetId }).strict();

/** D-48: the items of a set whose registered evidence document changed since the last scan (needs_check). */
export async function GET(request: Request): Promise<Response> {
  const guard = await goldenGuard(request);
  if (!guard.ok) return guard.response;
  const parsed = PendingQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) return invalid(parsed.error);
  try {
    const access = await tenantAccess(guard.userId, parsed.data.tenant);
    if (!access.ok) return access.response;
    const itemIds = await pendingEvidence(access.admin, { tenantKey: access.tenantKey, setId: parsed.data.set_id });
    return jsonNoStore({ success: true, item_ids: itemIds, count: itemIds.length });
  } catch (error) {
    console.error('[Monitor] golden evidence pending failed', { code: error instanceof Error ? error.message : 'unknown' });
    return unavailable();
  }
}

/** D-48: register a set's evidence rows (ids and quote hashes; replaces the set's rows), or with action clear reset checked flags. */
export async function POST(request: Request): Promise<Response> {
  const guard = await goldenGuard(request);
  if (!guard.ok) return guard.response;
  const raw = await readJson(request);
  if (!raw.ok) return fail(400, 'Invalid JSON body');
  const isClear = !!raw.body && typeof raw.body === 'object' && (raw.body as { action?: unknown }).action === 'clear';
  const parsed = isClear ? ClearBody.safeParse(raw.body) : RegisterBody.safeParse(raw.body);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const access = await tenantAccess(guard.userId, parsed.data.tenant);
    if (!access.ok) return access.response;
    if ('item_ids' in parsed.data) {
      const cleared = await clearEvidence(access.admin, { tenantKey: access.tenantKey, setId: parsed.data.set_id, itemIds: parsed.data.item_ids });
      return jsonNoStore({ success: true, cleared });
    }
    const rows = parsed.data.rows.map((row) => ({ ...row, document_id: row.document_id.toLowerCase() }));
    const result = await registerEvidence(access.admin, { tenantKey: access.tenantKey, setId: parsed.data.set_id, rows });
    return jsonNoStore({ success: true, ...result });
  } catch (error) {
    console.error('[Monitor] golden evidence register failed', { code: error instanceof Error ? error.message : 'unknown' });
    return unavailable();
  }
}
