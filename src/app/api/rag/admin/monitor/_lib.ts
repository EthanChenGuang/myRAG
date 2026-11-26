import type { NextResponse } from 'next/server';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { adminTenantKeys, validateGrantTenantKey } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { invalidRequest, jsonNoStore } from '../_tenant-data/lib';

export type PythonAdmission = { ok: true; admin: SupabaseClient; tenantKey: string } | { ok: false; response: NextResponse };

export type GuardResult = { ok: true; userId: string } | { ok: false; response: NextResponse };

/** The admin Bearer guard of the routes the Python tools call (D-42, D-43). */
export async function guardAdmin(request: Request): Promise<GuardResult> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return { ok: false, response: adminDenied(guard.status) };
  return { ok: true, userId: guard.userId };
}

export function monitorUnavailable(): NextResponse {
  return jsonNoStore({ success: false, error: 'Drift monitoring is unavailable' }, 503);
}

/**
 * The tenant a Python tool names: a tenant key of this deployment mode (400 otherwise) that the verified admin administers, resolved
 * in SQL through rag_admin_tenant_keys (403 otherwise). Nothing of the tenant is read before both checks pass.
 */
export async function admitTenant(userId: string, tenant: unknown, path = 'tenant'): Promise<PythonAdmission> {
  const valid = validateGrantTenantKey(tenant, getDeploymentMode());
  if (!valid.ok) return { ok: false, response: invalidRequest([{ path, message: 'tenant must be a tenant key of this deployment mode' }]) };
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, response: monitorUnavailable() };
  const keys = await adminTenantKeys(admin, userId);
  if (keys === null) return { ok: false, response: monitorUnavailable() };
  if (!keys.includes(valid.tenantKey)) return { ok: false, response: jsonNoStore({ success: false, error: 'Tenant not administered by this admin' }, 403) };
  return { ok: true, admin, tenantKey: valid.tenantKey };
}
