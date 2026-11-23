import { checkEvalScope } from '@/lib/rag-eval/auth';
import { mintScope, type TenantScope } from './scope';

export interface EvalScopeInput {
  deploymentMode: string | undefined;
  organizationId: string | null;
  userId: string | null;
  allowedScopes: string | undefined;
}

export type EvalScopeOutcome = { ok: true; scope: TenantScope } | { ok: false; status: 403; error: string };

export function evalScope(input: EvalScopeInput): EvalScopeOutcome {
  const access = checkEvalScope(input);
  if (!access.ok) return access;
  try {
    if (input.deploymentMode !== 'multi-tenant') return { ok: true, scope: mintScope('single', null, null) };
    if (input.organizationId) return { ok: true, scope: mintScope('org', input.userId || null, input.organizationId) };
    return { ok: true, scope: mintScope('personal', input.userId, null) };
  } catch {
    return { ok: false, status: 403, error: 'Scope not allowed' };
  }
}
