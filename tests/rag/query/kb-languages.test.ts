import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import {
  getKbLanguageShares,
  resetKbLanguageCacheForTests,
  translationTargets,
  type KbLanguageDeps,
} from '@/lib/rag/query/kb-languages';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const TTL_MS = 10 * 60 * 1000;

type Row = { language: string; share: number; docs: number };

function fakeClient(responses: Record<string, RpcResponse>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const response = responses[String(args.p_tenant_key)] ?? { data: [], error: null };
      const request = {
        abortSignal: () => request,
        then: (resolve: (value: RpcResponse) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(response).then(resolve, reject),
      };
      return request as ReturnType<RpcClient['rpc']>;
    },
  };
  return { client, calls };
}

function rows(shares: Record<string, number>): RpcResponse {
  const data: Row[] = Object.entries(shares).map(([language, share]) => ({ language, share, docs: Math.round(share * 100) }));
  return { data, error: null };
}

let clock = 1_000_000;
let scopeA: TenantScope;
let scopeB: TenantScope;

function depsWith(client: RpcClient | null): KbLanguageDeps {
  return { adminClient: () => client, now: () => clock };
}

beforeEach(() => {
  clock = 1_000_000;
  resetKbLanguageCacheForTests();
  scopeA = mintScope('org', null, ORG_A);
  scopeB = mintScope('org', null, ORG_B);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getKbLanguageShares', () => {
  test('sends exactly the scope tenant key to rag_tenant_language_shares', async () => {
    const { client, calls } = fakeClient({ [scopeKey(scopeA)]: rows({ zh: 0.85, en: 0.15 }) });
    const shares = await getKbLanguageShares(scopeA, { deps: depsWith(client) });
    expect(shares).toEqual({ zh: 0.85, en: 0.15 });
    expect(calls).toEqual([{ fn: 'rag_tenant_language_shares', args: { p_tenant_key: scopeKey(scopeA) } }]);
  });

  test('two calls within 10 minutes make one RPC call; after 10 minutes a new call is made', async () => {
    const { client, calls } = fakeClient({ [scopeKey(scopeA)]: rows({ zh: 0.85, en: 0.15 }) });
    const deps = depsWith(client);
    await getKbLanguageShares(scopeA, { deps });
    clock += TTL_MS - 1;
    await getKbLanguageShares(scopeA, { deps });
    expect(calls).toHaveLength(1);
    clock += 1;
    await getKbLanguageShares(scopeA, { deps });
    expect(calls).toHaveLength(2);
  });

  test("two tenants have separate entries; A's shares never answer B and dropping A leaves B", async () => {
    const { client, calls } = fakeClient({
      [scopeKey(scopeA)]: rows({ zh: 0.85, en: 0.15 }),
      [scopeKey(scopeB)]: rows({ en: 1.0 }),
    });
    const deps = depsWith(client);
    expect(await getKbLanguageShares(scopeA, { deps })).toEqual({ zh: 0.85, en: 0.15 });
    expect(await getKbLanguageShares(scopeB, { deps })).toEqual({ en: 1.0 });
    expect(calls.map((call) => call.args.p_tenant_key)).toEqual([scopeKey(scopeA), scopeKey(scopeB)]);

    resetKbLanguageCacheForTests(scopeKey(scopeA));
    expect(await getKbLanguageShares(scopeB, { deps })).toEqual({ en: 1.0 });
    expect(calls).toHaveLength(2);
    expect(await getKbLanguageShares(scopeA, { deps })).toEqual({ zh: 0.85, en: 0.15 });
    expect(calls).toHaveLength(3);

    clock += TTL_MS;
    const refreshed = fakeClient({ [scopeKey(scopeB)]: rows({ en: 1.0 }) });
    expect(await getKbLanguageShares(scopeB, { deps: depsWith(refreshed.client) })).toEqual({ en: 1.0 });
    expect(refreshed.calls.map((call) => call.args.p_tenant_key)).toEqual([scopeKey(scopeB)]);
  });

  test('an RPC error returns null and logs one [Query Layer] line with a hashed tenant key only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = fakeClient({ [scopeKey(scopeA)]: { data: null, error: { message: 'boom', code: 'P0001' } } });
    expect(await getKbLanguageShares(scopeA, { deps: depsWith(client) })).toBeNull();
    const lines = [...warn.mock.calls, ...error.mock.calls];
    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]);
    expect(text).toContain('[Query Layer]');
    expect(text).not.toContain(scopeKey(scopeA));
    expect(text).not.toContain(ORG_A);
    expect(text).toMatch(/[0-9a-f]{12}/);
  });

  test('an error is not cached; the next call asks again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = fakeClient({ [scopeKey(scopeA)]: { data: null, error: { message: 'boom' } } });
    expect(await getKbLanguageShares(scopeA, { deps: depsWith(failing.client) })).toBeNull();
    const ok = fakeClient({ [scopeKey(scopeA)]: rows({ zh: 1 }) });
    expect(await getKbLanguageShares(scopeA, { deps: depsWith(ok.client) })).toEqual({ zh: 1 });
  });

  test('no admin client returns null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getKbLanguageShares(scopeA, { deps: depsWith(null) })).toBeNull();
  });

  test('an unminted scope is refused before any RPC', async () => {
    const { client, calls } = fakeClient({});
    const forged = { kind: 'org', userId: null, organizationId: ORG_A } as unknown as TenantScope;
    await expect(getKbLanguageShares(forged, { deps: depsWith(client) })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('rows of languages outside zh, en and it are left out without renormalising', async () => {
    const { client } = fakeClient({ [scopeKey(scopeA)]: rows({ zh: 0.5, fr: 0.3, en: 0.2 }) });
    expect(await getKbLanguageShares(scopeA, { deps: depsWith(client) })).toEqual({ zh: 0.5, en: 0.2 });
  });
});

describe('translationTargets', () => {
  test('a rare query language translates into the KB language above 20%', () => {
    expect(translationTargets('en', { zh: 0.85, en: 0.15 })).toEqual(['zh']);
  });

  test('two KB languages above 20% are both targets, largest first', () => {
    expect(translationTargets('en', { zh: 0.5, it: 0.35, en: 0.15 })).toEqual(['zh', 'it']);
    expect(translationTargets('en', { it: 0.35, zh: 0.5, en: 0.15 })).toEqual(['zh', 'it']);
  });

  test('a common query language does not translate', () => {
    expect(translationTargets('en', { en: 0.4, zh: 0.6 })).toEqual([]);
  });

  test('a query language at exactly 20% counts as rare; a KB language at exactly 20% is not a target', () => {
    expect(translationTargets('en', { zh: 0.8, en: 0.2 })).toEqual(['zh']);
    expect(translationTargets('en', { zh: 0.6, it: 0.2, en: 0.2 })).toEqual(['zh']);
  });

  test('null or empty shares give no targets', () => {
    expect(translationTargets('en', null)).toEqual([]);
    expect(translationTargets('en', {})).toEqual([]);
  });
});
