import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const SECRET = 'a'.repeat(48);
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'RAG_EVAL_ALLOWED_SCOPES',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'NODE_ENV',
] as const;
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined>;

describe('entry point: eval route calls the pipeline', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    for (const name of ENV_NAMES) delete env[name];
    env.NODE_ENV = 'test';
    env.RAG_EVAL_SECRET = SECRET;
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.doUnmock('@/lib/rag');
    vi.resetModules();
  });

  async function callEvalRoute(deploymentMode: string, body: Record<string, unknown>) {
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = deploymentMode;
    vi.resetModules();
    const retrievalSpy = vi.fn();
    vi.doMock('@/lib/rag', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/rag')>();
      return {
        ...actual,
        runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
          retrievalSpy(input);
          return actual.runRetrieval(input);
        },
      };
    });
    const deps = await import('@/lib/rag/deps');
    deps.setRagDepsForTests({
      embedder: async () => [0.1, 0.2, 0.3],
      anonClient: () => {
        const request = {
          abortSignal: () => request,
          then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
        };
        return { rpc: () => request } as never;
      },
      adminClient: () => null,
    });
    const route = await import('@/app/api/internal/rag/run/route');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await route.POST(
        new NextRequest('http://localhost/api/internal/rag/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
          body: JSON.stringify({ schema_version: 1, query: 'What is the refund window?', rag_mode: 'strict', ...body }),
        }),
      );
      return { status: res.status, retrievalSpy, deps };
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      deps.resetRagDepsForTests();
    }
  }

  test('single-tenant: runRetrieval is called with profile eval and a minted single scope', async () => {
    const { status, retrievalSpy } = await callEvalRoute('single-tenant', {});
    expect(status).toBe(200);
    expect(retrievalSpy).toHaveBeenCalledTimes(1);
    const input = retrievalSpy.mock.calls[0][0];
    expect(input.profile).toBe('eval');
    expect(input.options).toMatchObject({ webSearchEnabled: false, ragMode: 'strict' });
    const scope = await import('@/lib/rag/tenant/scope');
    expect(scope.isTenantScope(input.scope)).toBe(true);
    expect(scope.scopeKey(input.scope)).toBe('s:default');
  });

  test('multi-tenant: the scope is the allow-listed workspace minted through evalScope', async () => {
    env.RAG_EVAL_ALLOWED_SCOPES = `org:${ORG}`;
    const { status, retrievalSpy } = await callEvalRoute('multi-tenant', { options: { organization_id: ORG, user_id: USER } });
    expect(status).toBe(200);
    expect(retrievalSpy).toHaveBeenCalledTimes(1);
    const input = retrievalSpy.mock.calls[0][0];
    expect(input.profile).toBe('eval');
    const scope = await import('@/lib/rag/tenant/scope');
    expect(scope.isTenantScope(input.scope)).toBe(true);
    expect(scope.scopeKey(input.scope)).toBe(`o:${ORG}`);
  });

  test('a scope outside the allow-list never reaches runRetrieval', async () => {
    env.RAG_EVAL_ALLOWED_SCOPES = `org:${ORG}`;
    const { status, retrievalSpy } = await callEvalRoute('multi-tenant', {
      options: { organization_id: '22222222-2222-4222-8222-222222222222', user_id: USER },
    });
    expect(status).toBe(403);
    expect(retrievalSpy).not.toHaveBeenCalled();
  });
});
