import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { EvalRunResultSummarySchema, ReasonCodeSchema, adminTenantKeys, closeEvalRunRequest } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';
import { fail, invalid, jsonNoStore, projectRequest, unavailable } from '../_lib';

export const runtime = 'nodejs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const IdSchema = z.string().uuid();

const CloseBodySchema = z
  .object({
    status: z.enum(['done', 'skipped', 'failed']),
    skip_reason: ReasonCodeSchema.nullish(),
    result_summary: EvalRunResultSummarySchema.nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'skipped' && !value.skip_reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skip_reason'], message: 'a skipped close needs a reason code' });
    }
    if (value.status !== 'skipped' && value.skip_reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skip_reason'], message: 'only a skipped close takes a reason code' });
    }
  });

/** D-19: the drain closes one running request as done, skipped (with a reason code such as no_real_set) or failed. */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const { id } = await context.params;
  const parsedId = IdSchema.safeParse(id);
  if (!parsedId.success) return invalid(parsedId.error);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Invalid JSON body');
  }
  const parsed = CloseBodySchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const keys = await adminTenantKeys(admin, guard.userId);
    if (keys === null) return unavailable();
    const result = await closeEvalRunRequest(admin, {
      id: parsedId.data,
      tenantKeys: keys,
      status: parsed.data.status,
      skipReason: parsed.data.skip_reason ?? null,
      resultSummary: parsed.data.result_summary ?? null,
    });
    if (!result.ok) {
      if (result.reason === 'not_found') return fail(404, 'Request not found');
      if (result.reason === 'not_running') return fail(409, 'not_running');
      if (result.reason === 'invalid') return fail(400, 'Invalid request data');
      return unavailable();
    }
    console.log('[Config Gate] eval run request closed', { id: result.request.id, status: result.request.status });
    return jsonNoStore({ request: projectRequest(result.request) });
  } catch {
    console.error('[Config Gate] eval run request close failed');
    return unavailable();
  }
}
