import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { checkEvalScope } from '@/lib/rag-eval/auth';

const SECRET = 'a'.repeat(48);
const SHORT_SECRET = 'b'.repeat(31);
const ROUTE_URL = 'http://localhost/api/internal/rag/run';
const VALID_BODY = { schema_version: 1, query: 'What is the refund window?', rag_mode: 'strict' };
const INVALID_BODY = { schema_version: 1, query: '' };
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'RAG_EVAL_ALLOWED_SCOPES',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'NODE_ENV',
] as const;
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';

const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined>;

interface CaseConfig {
  secret?: string;
  nodeEnv?: string;
  endpointEnabled?: string;
  deploymentMode?: string;
  allowedScopes?: string;
}

async function post(config: CaseConfig, headers: Record<string, string>, body: unknown) {
  for (const name of ENV_NAMES) delete env[name];
  if (config.secret !== undefined) env.RAG_EVAL_SECRET = config.secret;
  env.NODE_ENV = config.nodeEnv ?? 'test';
  if (config.endpointEnabled !== undefined) env.RAG_EVAL_ENDPOINT_ENABLED = config.endpointEnabled;
  env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = config.deploymentMode ?? 'single-tenant';
  if (config.allowedScopes !== undefined) env.RAG_EVAL_ALLOWED_SCOPES = config.allowedScopes;

  vi.resetModules();
  const route = await import('@/app/api/internal/rag/run/route');
  const req = new NextRequest(ROUTE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await route.POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('eval route auth matrix', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.resetModules();
  });

  test('missing secret header returns 401', async () => {
    const res = await post({ secret: SECRET }, {}, VALID_BODY);
    expect(res.status).toBe(401);
  });

  test('wrong secret header returns 401', async () => {
    const res = await post({ secret: SECRET }, { 'x-rag-eval-secret': 'c'.repeat(48) }, VALID_BODY);
    expect(res.status).toBe(401);
  });

  test('unset RAG_EVAL_SECRET returns 503 even with a matching header', async () => {
    const res = await post({}, { 'x-rag-eval-secret': '' }, VALID_BODY);
    expect(res.status).toBe(503);
    const matching = await post({}, { 'x-rag-eval-secret': SECRET }, VALID_BODY);
    expect(matching.status).toBe(503);
  });

  test('31-character secret returns 503 even with a matching header', async () => {
    const res = await post({ secret: SHORT_SECRET }, { 'x-rag-eval-secret': SHORT_SECRET }, VALID_BODY);
    expect(res.status).toBe(503);
  });

  test('production without RAG_EVAL_ENDPOINT_ENABLED returns 404 even with the correct secret', async () => {
    const res = await post({ secret: SECRET, nodeEnv: 'production' }, { 'x-rag-eval-secret': SECRET }, VALID_BODY);
    expect(res.status).toBe(404);
  });

  test('enabled endpoint with the correct secret and an invalid body returns 400 with details', async () => {
    const res = await post(
      { secret: SECRET, nodeEnv: 'production', endpointEnabled: 'true' },
      { 'x-rag-eval-secret': SECRET },
      INVALID_BODY,
    );
    expect(res.status).toBe(400);
    expect(res.json.success).toBe(false);
    expect(Array.isArray(res.json.details)).toBe(true);
    expect((res.json.details as unknown[]).length).toBeGreaterThan(0);
  });

  test('unauthenticated request with an invalid body returns 401, never 400', async () => {
    const res = await post({ secret: SECRET }, {}, INVALID_BODY);
    expect(res.status).toBe(401);
    const garbage = await post({ secret: SECRET }, {}, '{not json');
    expect(garbage.status).toBe(401);
  });
});

describe('eval route tenant scope', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.resetModules();
  });

  const auth = { 'x-rag-eval-secret': SECRET };

  test('multi-tenant request without a scope returns 403', async () => {
    const res = await post({ secret: SECRET, deploymentMode: 'multi-tenant', allowedScopes: `org:${ORG_A}` }, auth, VALID_BODY);
    expect(res.status).toBe(403);
  });

  test('multi-tenant request for an organization outside the allow-list returns 403', async () => {
    const body = { ...VALID_BODY, options: { organization_id: ORG_B } };
    const res = await post({ secret: SECRET, deploymentMode: 'multi-tenant', allowedScopes: `org:${ORG_A}` }, auth, body);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('Scope not allowed');
  });

  test('multi-tenant with an empty allow-list denies every scope', async () => {
    const body = { ...VALID_BODY, options: { user_id: USER_A } };
    const res = await post({ secret: SECRET, deploymentMode: 'multi-tenant' }, auth, body);
    expect(res.status).toBe(403);
  });

  test('checkEvalScope allows listed scopes and ignores case and whitespace', () => {
    const allowedScopes = ` org:${ORG_A.toUpperCase()} , user:${USER_A} `;
    expect(checkEvalScope({ deploymentMode: 'multi-tenant', organizationId: ORG_A, userId: null, allowedScopes }).ok).toBe(true);
    expect(checkEvalScope({ deploymentMode: 'multi-tenant', organizationId: null, userId: USER_A, allowedScopes }).ok).toBe(true);
    expect(checkEvalScope({ deploymentMode: 'multi-tenant', organizationId: ORG_B, userId: USER_A, allowedScopes }).ok).toBe(false);
  });

  test('checkEvalScope does not restrict single-tenant deployments', () => {
    expect(checkEvalScope({ deploymentMode: 'single-tenant', organizationId: null, userId: null, allowedScopes: '' }).ok).toBe(true);
  });
});
