import crypto from 'node:crypto';

export const EVAL_SECRET_HEADER = 'x-rag-eval-secret';
const MIN_SECRET_LENGTH = 32;

export type EvalAccessResult = { ok: true } | { ok: false; status: 401 | 404 | 503; error: string };

export interface EvalAccessConfig {
  nodeEnv: string | undefined;
  endpointEnabled: string | undefined;
  secret: string | undefined;
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export function checkEvalAccess(headers: Headers, config: EvalAccessConfig): EvalAccessResult {
  if (config.nodeEnv === 'production' && config.endpointEnabled !== 'true') {
    return { ok: false, status: 404, error: 'Not found' };
  }

  const secret = config.secret ?? '';
  if (secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, status: 503, error: 'Eval endpoint is not configured' };
  }

  const provided = headers.get(EVAL_SECRET_HEADER);
  if (!provided) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  if (!crypto.timingSafeEqual(sha256(provided), sha256(secret))) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  return { ok: true };
}

export type EvalScopeResult = { ok: true } | { ok: false; status: 403; error: string };

export interface EvalScopeConfig {
  deploymentMode: string | undefined;
  organizationId: string | null;
  userId: string | null;
  allowedScopes: string | undefined;
}

export function parseAllowedScopes(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ''),
  );
}

export function evalScopeKey(organizationId: string | null, userId: string | null): string | null {
  if (organizationId) return `org:${organizationId.trim().toLowerCase()}`;
  if (userId) return `user:${userId.trim().toLowerCase()}`;
  return null;
}

export function checkEvalScope(config: EvalScopeConfig): EvalScopeResult {
  if (config.deploymentMode !== 'multi-tenant') return { ok: true };
  const scope = evalScopeKey(config.organizationId, config.userId);
  if (scope === null) {
    return { ok: false, status: 403, error: 'Scope required: set options.organization_id or options.user_id' };
  }
  if (!parseAllowedScopes(config.allowedScopes).has(scope)) {
    return { ok: false, status: 403, error: 'Scope not allowed' };
  }
  return { ok: true };
}
