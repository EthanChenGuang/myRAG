import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin, requireAdminOrDeny } from '@/lib/admin-route-auth';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
  grantDomainExpert,
  listDomainExperts,
  revokeDomainExpert,
  validateGrantTenantKey,
} from '@/lib/rag/feedback-loop/review-access';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

const GrantBodySchema = z.object({ tenantKey: z.string().min(1).max(80), userId: z.string().uuid() }).strict();
const ListQuerySchema = z.object({ tenantKey: z.string().min(1).max(80) });

type Issue = { path: string; message: string };

function invalid(details: Issue[]): NextResponse {
  return NextResponse.json({ success: false, error: 'Invalid request data', details }, { status: 400, headers: NO_STORE });
}

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: 'Domain expert grants are unavailable' }, { status: 503, headers: NO_STORE });
}

function zodIssues(error: z.ZodError): Issue[] {
  return error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

function tenantIssue(reason: 'invalid_tenant_key' | 'tenant_key_mode'): Issue[] {
  return [
    {
      path: 'tenantKey',
      message: reason === 'tenant_key_mode' ? 'Tenant key does not match the deployment mode' : 'Invalid tenant key',
    },
  ];
}

async function readGrantBody(request: Request): Promise<{ ok: true; tenantKey: string; userId: string } | { ok: false; response: NextResponse }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: invalid([{ path: '', message: 'Body must be JSON' }]) };
  }
  const parsed = GrantBodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, response: invalid(zodIssues(parsed.error)) };
  const tenant = validateGrantTenantKey(parsed.data.tenantKey, getDeploymentMode());
  if (!tenant.ok) return { ok: false, response: invalid(tenantIssue(tenant.reason)) };
  return { ok: true, tenantKey: tenant.tenantKey, userId: parsed.data.userId.toLowerCase() };
}

/** D-16: grants of one tenant, user ids with e-mails masked to the domain. Operator admins only (requireAdminOrDeny first). */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const parsed = ListQuerySchema.safeParse({ tenantKey: url.searchParams.get('tenantKey') ?? undefined });
  if (!parsed.success) return invalid(zodIssues(parsed.error));
  const tenant = validateGrantTenantKey(parsed.data.tenantKey, getDeploymentMode());
  if (!tenant.ok) return invalid(tenantIssue(tenant.reason));

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const grants = await listDomainExperts(admin, tenant.tenantKey);
    return NextResponse.json({ grants }, { headers: NO_STORE });
  } catch {
    console.error('[Review] grant list failed');
    return unavailable();
  }
}

/**
 * D-16: grant a user expert access to one tenant's review queue. checkAdmin and adminDenied are the two halves of
 * requireAdminOrDeny; the verified admin id is needed for granted_by. 201 on a new grant, 200 when it already existed.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const input = await readGrantBody(request);
  if (!input.ok) return input.response;

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const result = await grantDomainExpert(admin, { tenantKey: input.tenantKey, userId: input.userId, grantedBy: guard.userId });
    if (!result.ok) return invalid([{ path: 'userId', message: 'Unknown user' }]);
    return NextResponse.json(
      { tenantKey: input.tenantKey, userId: input.userId, created: result.created },
      { status: result.created ? 201 : 200, headers: NO_STORE },
    );
  } catch {
    console.error('[Review] grant failed');
    return unavailable();
  }
}

/** D-16: revoke a grant; 204 whether or not it existed. Same guard as POST. */
export async function DELETE(request: Request): Promise<NextResponse> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const input = await readGrantBody(request);
  if (!input.ok) return input.response;

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    await revokeDomainExpert(admin, { tenantKey: input.tenantKey, userId: input.userId, revokedBy: guard.userId });
    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch {
    console.error('[Review] revoke failed');
    return unavailable();
  }
}
