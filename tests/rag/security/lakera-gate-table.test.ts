import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RetrievalResult } from '@/lib/rag/types';

/**
 * Plan-check B4: no Lakera request unless the check is on, RAG_INJECTION_LAKERA is on, a key is present and the
 * deployment is single-tenant or the multi-tenant acknowledgement is set. The deployment mode comes from the real
 * isMultiTenant() resolver, so every case reloads the modules after setting the deployment-mode env.
 */

const CLEAN = 'A neutral synthetic sentence about the quarterly widget inventory report.';
const PLACEHOLDER_KEY = 'lakera-placeholder-key';
const MODE_VARS = ['NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'MYRAG_DEPLOYMENT_MODE'] as const;
const USER_ID = '00000000-0000-4000-8000-0000000000a1';

type DeploymentMode = 'single-tenant' | 'multi-tenant';

interface Case {
  name: string;
  mode: DeploymentMode;
  security: Record<string, string>;
  expectedCalls: 'none' | 'some';
  disabledReason?: string;
}

const CASES: Case[] = [
  {
    name: '(a) check off with Lakera, acknowledgement, key and multi-tenant all on',
    mode: 'multi-tenant',
    security: {
      RAG_INJECTION_CHECK: 'off',
      RAG_INJECTION_LAKERA: 'true',
      RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true',
      LAKERA_GUARD_API_KEY: PLACEHOLDER_KEY,
    },
    expectedCalls: 'none',
  },
  {
    name: '(b) Lakera off with the acknowledgement on, check drop and a key',
    mode: 'single-tenant',
    security: {
      RAG_INJECTION_CHECK: 'drop',
      RAG_INJECTION_LAKERA: 'false',
      RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true',
      LAKERA_GUARD_API_KEY: PLACEHOLDER_KEY,
    },
    expectedCalls: 'none',
    disabledReason: 'lakera_off',
  },
  {
    name: '(c) multi-tenant from the deployment-mode env, check drop, Lakera on, key set, acknowledgement off',
    mode: 'multi-tenant',
    security: { RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_LAKERA: 'true', LAKERA_GUARD_API_KEY: PLACEHOLDER_KEY },
    expectedCalls: 'none',
    disabledReason: 'multi_tenant_ack_missing',
  },
  {
    name: '(d) single-tenant, check drop, Lakera on, key empty',
    mode: 'single-tenant',
    security: { RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_LAKERA: 'true', LAKERA_GUARD_API_KEY: '' },
    expectedCalls: 'none',
    disabledReason: 'not_configured',
  },
  {
    name: 'positive control: single-tenant, check drop, Lakera on and a key',
    mode: 'single-tenant',
    security: { RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_LAKERA: 'true', LAKERA_GUARD_API_KEY: PLACEHOLDER_KEY },
    expectedCalls: 'some',
  },
  {
    name: 'positive control: multi-tenant with the acknowledgement on',
    mode: 'multi-tenant',
    security: {
      RAG_INJECTION_CHECK: 'drop',
      RAG_INJECTION_LAKERA: 'true',
      RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true',
      LAKERA_GUARD_API_KEY: PLACEHOLDER_KEY,
    },
    expectedCalls: 'some',
  },
];

const savedMode: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of MODE_VARS) savedMode[name] = process.env[name];
  for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation(() => undefined);
});

afterEach(async () => {
  const deps = await import('@/lib/rag/deps');
  deps.resetRagDepsForTests();
  for (const name of MODE_VARS) {
    if (savedMode[name] === undefined) delete process.env[name];
    else process.env[name] = savedMode[name];
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

function countingLakeraFetch() {
  const urls: string[] = [];
  const fetchFake = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    return new Response(JSON.stringify({ breakdown: [{ detector_type: 'prompt_attack', detected: false }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchFake, lakeraCalls: () => urls.filter((url) => url.endsWith('/v2/guard')).length };
}

async function runCase(entry: Case): Promise<{ result: RetrievalResult; lakeraCalls: number }> {
  for (const name of MODE_VARS) process.env[name] = entry.mode;
  vi.resetModules();
  const rag = await import('@/lib/rag');
  const { readSecurityConfig } = await import('@/lib/rag/security/config');
  const { mintScope } = await import('@/lib/rag/tenant/scope');
  const { isMultiTenant } = await import('@/lib/deployment-mode');
  const fakes = await import('../helpers/pipeline-fakes');
  expect(isMultiTenant()).toBe(entry.mode === 'multi-tenant');

  const { fetchFake, lakeraCalls } = countingLakeraFetch();
  fakes.installDeps({
    searchRpc: fakes.fakeRpcClient({ rows: [{ chunk_id: 'c1', document_id: 'doc-1', content: CLEAN, similarity: 0.9, metadata: null }] }).client,
    embedder: fakes.fakeEmbedder().embedder,
    ragEnv: () => ({}),
    securityConfig: () => readSecurityConfig(entry.security),
    fetch: fetchFake as unknown as typeof fetch,
  });
  const scope = entry.mode === 'multi-tenant' ? mintScope('personal', USER_ID, null) : mintScope('single', null, null);
  const result = await rag.runRetrieval({
    scope,
    query: 'quarterly widget inventory',
    profile: 'chat',
    signal: new AbortController().signal,
    options: { ragMode: 'strict', webSearchEnabled: false },
  });
  return { result, lakeraCalls: lakeraCalls() };
}

describe('Lakera gate table at the injection_check stage (B4)', () => {
  for (const entry of CASES) {
    test(entry.name, async () => {
      const { result, lakeraCalls } = await runCase(entry);
      const stage = result.stages.find((record) => record.name === 'injection_check');

      if (entry.expectedCalls === 'none') expect(lakeraCalls).toBe(0);
      else expect(lakeraCalls).toBeGreaterThanOrEqual(1);

      expect(result.status).toBe('ok');
      expect(result.kept).toHaveLength(1);

      if (entry.security.RAG_INJECTION_CHECK === 'off') {
        expect(stage).toBeUndefined();
        expect(result.injection).toBeUndefined();
        return;
      }
      expect(stage?.status).toBe('ok');
      if (entry.disabledReason) {
        expect(stage?.counts).toMatchObject({ lakera_disabled: 1, lakera_checked: 0 });
        expect(result.injection?.detectorsDisabled).toEqual({ lakera: entry.disabledReason });
        expect(result.injection?.detectorsUnavailable).toEqual([]);
      } else {
        expect(stage?.counts).toMatchObject({ lakera_checked: 1, lakera_flagged: 0, lakera_disabled: 0, lakera_cache_miss: 1 });
        expect(result.injection?.detectorsDisabled).toBeUndefined();
      }
    });
  }
});
