import type { TenantScope } from '../tenant/scope';
import type { ScopeRebuildResult } from './build';

export type AddScopeExampleResult = { ok: true; example: { id: string; createdAt: string } } | { ok: false; code: string };

export async function scopeGateStatus(_scope: TenantScope): Promise<{ ok: true; status: { examples: number; unsupported: boolean; rebuildRunning: boolean } } | { ok: false; code: string }> {
  return { ok: false, code: 'not_implemented' };
}

export async function addScopeExample(_scope: TenantScope, _input: { text: string; actorId: string }): Promise<AddScopeExampleResult> {
  return { ok: false, code: 'not_implemented' };
}

export async function deleteScopeExample(_scope: TenantScope, _id: string): Promise<{ ok: true } | { ok: false; code: string }> {
  return { ok: false, code: 'not_implemented' };
}

export async function startScopeRebuild(_scope: TenantScope, _options: { waitMs?: number } = {}): Promise<{ status: string; result?: ScopeRebuildResult; code?: string }> {
  return { status: 'not_implemented' };
}
