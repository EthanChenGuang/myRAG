import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const SECRET = 'a'.repeat(48);
const SHORT_SECRET = 'b'.repeat(31);
const ROUTE_URL = 'http://localhost/api/internal/rag/run';
const VALID_BODY = { schema_version: 1, query: 'What is the refund window?', rag_mode: 'strict' };
const INVALID_BODY = { schema_version: 1, query: '' };
const ENV_NAMES = ['RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED', 'NODE_ENV'] as const;

const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined>;

interface CaseConfig {
  secret?: string;
  nodeEnv?: string;
  endpointEnabled?: string;
}

async function post(config: CaseConfig, headers: Record<string, string>, body: unknown) {
  for (const name of ENV_NAMES) delete env[name];
  if (config.secret !== undefined) env.RAG_EVAL_SECRET = config.secret;
  env.NODE_ENV = config.nodeEnv ?? 'test';
  if (config.endpointEnabled !== undefined) env.RAG_EVAL_ENDPOINT_ENABLED = config.endpointEnabled;

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
