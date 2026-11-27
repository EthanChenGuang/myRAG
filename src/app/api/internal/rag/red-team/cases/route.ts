import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { env } from '@/lib/env';
import { evalScope, readFeedbackLoopConfig, scopeKey } from '@/lib/rag';
import { checkEvalAccess } from '@/lib/rag-eval/auth';
import { scalarOf } from '@/lib/rag/cache/wire';
import { getRagDeps } from '@/lib/rag/deps';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_CASES_PER_REQUEST = 500;

const RedTeamCase = z
  .object({
    item_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
    technique: z.string().regex(/^[a-z][a-z_]{0,28}$/),
    language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
    trace_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    question: z.string().trim().min(1).max(2000),
  })
  .strict();

const RedTeamCasesBody = z
  .object({
    run_id: z.string().uuid(),
    run_started_at: z.string().datetime({ offset: true }),
    organization_id: z.string().uuid().optional(),
    user_id: z.string().uuid().optional(),
    cases: z.array(RedTeamCase).max(MAX_CASES_PER_REQUEST),
  })
  .strict();

/**
 * SEC-11: the red-team runner opens one review case per attack success. Same access as the eval route (the eval secret,
 * compared in constant time, and the production enable rule); 404 while RAG_DOMAIN_EXPERT_REVIEW is off. The tenant is the eval
 * route's own resolution (single-tenant default, or an allowed eval scope); the cases carry no tenant.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const access = checkEvalAccess(req.headers, {
    nodeEnv: process.env.NODE_ENV,
    endpointEnabled: env.RAG_EVAL_ENDPOINT_ENABLED,
    secret: env.RAG_EVAL_SECRET,
  });
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status, headers: NO_STORE });

  if (!readFeedbackLoopConfig().domainExpertReview) {
    return NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'The body must be JSON' }, { status: 400, headers: NO_STORE });
  }
  const parsed = RedTeamCasesBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: 'Invalid request data',
        details: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
      { status: 400, headers: NO_STORE },
    );
  }
  const body = parsed.data;

  const deploymentMode = env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  const scoped = evalScope({
    deploymentMode,
    organizationId: deploymentMode === 'multi-tenant' ? (body.organization_id ?? null) : null,
    userId: body.user_id ?? null,
    allowedScopes: env.RAG_EVAL_ALLOWED_SCOPES,
  });
  if (!scoped.ok) return NextResponse.json({ error: scoped.error }, { status: scoped.status, headers: NO_STORE });
  const tenantKey = scopeKey(scoped.scope);

  if (body.cases.length === 0) return NextResponse.json({ success: true, opened: 0 }, { headers: NO_STORE });

  const admin = getRagDeps().adminClient();
  if (!admin) return NextResponse.json({ success: false, error: 'Review queue unavailable' }, { status: 503, headers: NO_STORE });
  const { data, error } = await admin.rpc('rag_red_team_open_cases', {
    p_tenant_key: tenantKey,
    p_run_id: body.run_id,
    p_run_started_at: body.run_started_at,
    p_cases: body.cases,
  });
  if (error) {
    console.error('[Red Team] opening review cases failed', { code: error.code ?? 'unknown', cases: body.cases.length });
    return NextResponse.json({ success: false, error: 'Review queue unavailable' }, { status: 503, headers: NO_STORE });
  }
  const value = scalarOf(data, 'rag_red_team_open_cases');
  const opened = typeof value === 'number' ? value : 0;
  console.log('[Red Team] review cases opened', { runId: body.run_id, cases: body.cases.length, opened });
  return NextResponse.json({ success: true, opened }, { headers: NO_STORE });
}
