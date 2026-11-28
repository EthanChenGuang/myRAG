import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import * as rag from '@/lib/rag';
import * as attributes from '@/lib/rag/retrieval/attributes';
import { mintScope } from '@/lib/rag/tenant/scope';

/**
 * 03.3 verification G4: the route pre-check of an explicit attributes filter. A key the tenant's SQL resolver refuses throws
 * AttributeFilterError (400, unknown_attribute, key path); a known key, no filter or a backend failure does not throw (the attribute
 * stage then decides, failing closed). Both are exported from the @/lib/rag barrel.
 */
const ORG_A = '00000000-0000-4000-8000-000000330401';
const SCOPE_A = mintScope('org', null, ORG_A);

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function fakeClient(answers: Record<string, RpcResponse>): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const response = answers[fn] ?? { data: [], error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (resolve, reject) => Promise.resolve(response).then(resolve, reject),
      };
      return request;
    },
  };
  return { client, calls };
}

const LEXICON = { data: [{ key: 'alpha_code', value: 'zeta-17', type: 'code', soft: false }], error: null };
let clock = 2_000_000;

function options(client: RpcClient): attributes.AttributeOptions {
  clock += 120_000;
  return { client, now: () => clock, terminology: false, config: { schema_version: 1, rules_version: 1, soft_weight: 0.5, id_cap: 2000 } };
}

type Check = (scope: unknown, explicit: unknown, options?: unknown) => Promise<void>;

function check(): Check {
  const fn = (attributes as unknown as { checkExplicitAttributeFilter?: Check }).checkExplicitAttributeFilter;
  expect(typeof fn).toBe('function');
  return fn as Check;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  attributes.resetAttributeLexiconForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('checkExplicitAttributeFilter', () => {
  test('the barrel exports AttributeFilterError and the check', () => {
    const barrel = rag as unknown as Record<string, unknown>;
    expect(barrel.AttributeFilterError).toBe(attributes.AttributeFilterError);
    expect(typeof barrel.checkExplicitAttributeFilter).toBe('function');
  });

  test('an unknown key throws AttributeFilterError 400 with the key path, and the value never reaches the message', async () => {
    const { client, calls } = fakeClient({
      rag_attribute_filter_values: LEXICON,
      rag_attribute_documents: { data: null, error: { message: 'unknown_attribute', code: '22023' } },
    });
    const error = await check()(SCOPE_A, { gamma_text: ['zeta-17'] }, options(client)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(attributes.AttributeFilterError);
    expect(error).toMatchObject({ code: 'unknown_attribute', status: 400, details: [{ path: 'attributes.gamma_text', message: 'unknown_attribute' }] });
    expect(String((error as Error).message)).not.toContain('zeta-17');
    const documents = calls.filter((call) => call.fn === 'rag_attribute_documents');
    expect(documents).toHaveLength(1);
    expect(documents[0].args.p_tenant_key).toBe(`o:${ORG_A}`);
    expect(documents[0].args.p_filters).toEqual({ gamma_text: ['zeta-17'] });
  });

  test('a known key does not throw', async () => {
    const { client } = fakeClient({ rag_attribute_filter_values: LEXICON, rag_attribute_documents: { data: [], error: null } });
    await expect(check()(SCOPE_A, { alpha_code: ['zeta-17'] }, options(client))).resolves.toBeUndefined();
  });

  test('no filter or only empty value lists makes no rpc call', async () => {
    const { client, calls } = fakeClient({});
    await check()(SCOPE_A, undefined, options(client));
    await check()(SCOPE_A, {}, options(client));
    await check()(SCOPE_A, { alpha_code: [] }, options(client));
    expect(calls).toHaveLength(0);
  });

  test('a backend failure is left to the attribute stage (no throw)', async () => {
    const { client } = fakeClient({
      rag_attribute_filter_values: { data: null, error: { message: 'boom', code: '57014' } },
      rag_attribute_documents: { data: null, error: { message: 'boom', code: '57014' } },
    });
    await expect(check()(SCOPE_A, { alpha_code: ['zeta-17'] }, options(client))).resolves.toBeUndefined();
  });
});
