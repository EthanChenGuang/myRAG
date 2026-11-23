import type { TenantScope } from './scope';

export interface EvalScopeInput {
  deploymentMode: string | undefined;
  organizationId: string | null;
  userId: string | null;
  allowedScopes: string | undefined;
}

export type EvalScopeOutcome = { ok: true; scope: TenantScope } | { ok: false; status: 403; error: string };

export function evalScope(_input: EvalScopeInput): EvalScopeOutcome {
  return { ok: false, status: 403, error: 'Scope not allowed' };
}
