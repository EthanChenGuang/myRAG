import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { RetrievalBackendError } from '@/lib/rag/backend/supabase-rpc';
import {
  ATTRIBUTE_LEXICON_ROW_CAP,
  attributeFilterConfig,
  setAttributeFilterConfigForTests,
} from '@/lib/rag/retrieval/attribute-filter-config';
import {
  AttributeFilterError,
  attributeLexiconFor,
  attributeLexiconSizeForTests,
  invalidateAttributeLexicon,
  resetAttributeLexiconForTests,
  resolveAttributeFilter,
  type AttributeOptions,
} from '@/lib/rag/retrieval/attributes';
import { buildMatcher, type TermEntry } from '@/lib/rag/terminology/matcher';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';

const ORG_A = '00000000-0000-4000-8000-000000180001';
const ORG_B = '00000000-0000-4000-8000-000000180002';
const SCOPE_A = mintScope('org', null, ORG_A);
const SCOPE_B = mintScope('org', null, ORG_B);

interface LexRow {
  key: string;
  value: string;
  type: 'text' | 'text_list' | 'code';
  soft: boolean;
}

const LEXICON_A: LexRow[] = [
  { key: 'alpha_code', value: 'zeta-17', type: 'code', soft: false },
  { key: 'alpha_code', value: 'kappa-200', type: 'code', soft: false },
  { key: 'beta_list', value: 'lumen', type: 'text_list', soft: false },
  { key: 'beta_list', value: 'lumen grove', type: 'text_list', soft: false },
  { key: 'beta_list', value: 'nimbus', type: 'text_list', soft: false },
  { key: 'beta_list', value: 'vex', type: 'text_list', soft: false },
  { key: 'beta_list', value: 'q', type: 'text_list', soft: false },
  { key: 'beta_list', value: 'the', type: 'text_list', soft: false },
  { key: 'beta_list', value: '星', type: 'text_list', soft: false },
  { key: 'delta_text', value: 'orbit', type: 'text', soft: true },
  { key: 'epsilon_text', value: 'nimbus', type: 'text', soft: false },
];
const LEXICON_B: LexRow[] = [{ key: 'alpha_code', value: 'omega-99', type: 'code', soft: false }];

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

type Answer = RpcResponse | ((args: Record<string, unknown>) => RpcResponse);

function fakeClient(answers: Record<string, Answer>): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const answer = answers[fn];
      const response: RpcResponse = typeof answer === 'function' ? answer(args) : (answer ?? { data: [], error: null });
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (resolve, reject) => Promise.resolve(response).then(resolve, reject),
      };
      return request;
    },
  };
  return { client, calls };
}

function lexiconAnswer(byTenant: Record<string, LexRow[]>): Answer {
  return (args) => ({ data: byTenant[String(args.p_tenant_key)] ?? [], error: null });
}

const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Documents per (key, value): the fake resolves the filter with "any value of one key, every key" over this table. */
function documentsAnswer(table: Record<string, string[]>): Answer {
  return (args) => {
    const filters = args.p_filters as Record<string, string[]>;
    const limit = Number(args.p_limit);
    let ids: Set<string> | null = null;
    for (const [key, values] of Object.entries(filters)) {
      const forKey = new Set(values.flatMap((value) => table[`${key}=${value}`] ?? []));
      ids = ids === null ? forKey : new Set([...ids].filter((id) => forKey.has(id)));
    }
    return { data: [...(ids ?? [])].sort().slice(0, limit).map((document_id) => ({ document_id })), error: null };
  };
}

const TABLE: Record<string, string[]> = {
  'alpha_code=zeta-17': [idOf(1), idOf(2)],
  'alpha_code=kappa-200': [idOf(3)],
  'beta_list=lumen': [idOf(4)],
  'beta_list=lumen grove': [idOf(5)],
  'beta_list=nimbus': [idOf(6)],
  'epsilon_text=nimbus': [idOf(7)],
  'delta_text=orbit': [idOf(8)],
  'beta_list=vex': [idOf(9)],
};

let clock = 1_000_000;
const now = () => clock;

function options(client: RpcClient, extra: Partial<AttributeOptions> = {}): AttributeOptions {
  return { client, now, terminology: false, minHanChars: 2, config: { schema_version: 1, rules_version: 1, soft_weight: 0.5, id_cap: 2000 }, ...extra };
}

function standard() {
  return fakeClient({ rag_attribute_filter_values: lexiconAnswer({ [`o:${ORG_A}`]: LEXICON_A, [`o:${ORG_B}`]: LEXICON_B }), rag_attribute_documents: documentsAnswer(TABLE) });
}

function documentCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.fn === 'rag_attribute_documents');
}

function termEntry(canonical: string, variants: string[]): TermEntry {
  return {
    entryId: `t-${canonical}`,
    layer: 'workspace',
    canonical,
    variants,
    normalizedVariants: variants,
    language: 'en',
    kind: 'synonym',
    mode: 'one_way',
    sourceLanguage: null,
    targetLanguage: null,
  };
}

const SECRET_VALUES = ['zeta-17', 'kappa-200', 'lumen', 'nimbus', 'orbit', 'omega-99', 'vex'];
const SECRET_QUERY_WORD = 'quartzfinchmarker';

function loggedText(): string {
  return [console.log, console.info, console.debug, console.warn, console.error]
    .flatMap((spy) => vi.mocked(spy).mock.calls)
    .map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '))
    .join('\n');
}

beforeEach(() => {
  resetAttributeLexiconForTests();
  setAttributeFilterConfigForTests(null);
  clock = 1_000_000;
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => {
  const text = loggedText();
  for (const value of [...SECRET_VALUES, SECRET_QUERY_WORD]) expect(text).not.toContain(value);
  vi.restoreAllMocks();
});

describe('attribute filter config', () => {
  test('the committed file holds the starting numbers', () => {
    expect(attributeFilterConfig()).toEqual({ schema_version: 1, rules_version: 1, soft_weight: 0.5, id_cap: 2000 });
    expect(ATTRIBUTE_LEXICON_ROW_CAP).toBe(5000);
  });

  test('an unknown key or a non-positive number throws; the override is replaced and restored', () => {
    expect(() => setAttributeFilterConfigForTests({ schema_version: 1, rules_version: 1, soft_weight: 0.5, id_cap: 2000, extra: 1 })).toThrow();
    expect(() => setAttributeFilterConfigForTests({ schema_version: 1, rules_version: 1, soft_weight: 0, id_cap: 2000 })).toThrow();
    expect(() => setAttributeFilterConfigForTests({ schema_version: 1, rules_version: 1, soft_weight: 0.5, id_cap: 0 })).toThrow();
    setAttributeFilterConfigForTests({ schema_version: 1, rules_version: 2, soft_weight: 0.25, id_cap: 10 });
    expect(attributeFilterConfig().id_cap).toBe(10);
    setAttributeFilterConfigForTests(null);
    expect(attributeFilterConfig().id_cap).toBe(2000);
  });
});

describe('value lexicon cache', () => {
  test('a second call inside the time to live makes no rpc; after it one rpc', async () => {
    const { client, calls } = standard();
    await attributeLexiconFor(SCOPE_A, options(client));
    await attributeLexiconFor(SCOPE_A, options(client));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ fn: 'rag_attribute_filter_values', args: { p_tenant_key: scopeKey(SCOPE_A), p_limit: ATTRIBUTE_LEXICON_ROW_CAP + 1 } });
    clock += 60_000;
    await attributeLexiconFor(SCOPE_A, options(client));
    expect(calls).toHaveLength(2);
  });

  test('a failed load is kept only for the shorter time to live', async () => {
    let fail = true;
    const { client, calls } = fakeClient({
      rag_attribute_filter_values: () => (fail ? { data: null, error: { message: 'boom', code: 'XX000' } } : { data: LEXICON_A, error: null }),
    });
    await expect(attributeLexiconFor(SCOPE_A, options(client))).rejects.toBeInstanceOf(RetrievalBackendError);
    fail = false;
    await expect(attributeLexiconFor(SCOPE_A, options(client))).rejects.toBeInstanceOf(RetrievalBackendError);
    expect(calls).toHaveLength(1);
    clock += 10_000;
    const lexicon = await attributeLexiconFor(SCOPE_A, options(client));
    expect(lexicon.values).toHaveLength(LEXICON_A.length);
    expect(calls).toHaveLength(2);
  });

  test("tenant A's entry is never returned for tenant B", async () => {
    const { client, calls } = standard();
    const a = await attributeLexiconFor(SCOPE_A, options(client));
    const b = await attributeLexiconFor(SCOPE_B, options(client));
    expect(calls.map((call) => call.args.p_tenant_key)).toEqual([`o:${ORG_A}`, `o:${ORG_B}`]);
    expect(b.tenantKey).toBe(`o:${ORG_B}`);
    expect(b.values.map((item) => item.value)).toEqual(['omega-99']);
    expect(a.values.some((item) => item.value === 'omega-99')).toBe(false);
    const resolved = await resolveAttributeFilter(SCOPE_B, 'about zeta-17', null, options(client));
    expect(resolved.hardIds).toBeNull();
    expect(resolved.counts.matchedKeys).toBe(0);
  });

  test('invalidation of one key, of all, and the test reset clear the cache; at most 256 tenants', async () => {
    const { client, calls } = standard();
    await attributeLexiconFor(SCOPE_A, options(client));
    await attributeLexiconFor(SCOPE_B, options(client));
    invalidateAttributeLexicon(scopeKey(SCOPE_A));
    await attributeLexiconFor(SCOPE_A, options(client));
    await attributeLexiconFor(SCOPE_B, options(client));
    expect(calls).toHaveLength(3);
    invalidateAttributeLexicon('all');
    expect(attributeLexiconSizeForTests()).toBe(0);
    await attributeLexiconFor(SCOPE_B, options(client));
    resetAttributeLexiconForTests();
    expect(attributeLexiconSizeForTests()).toBe(0);
    for (let i = 0; i < 300; i += 1) await attributeLexiconFor(mintScope('org', null, idOf(500 + i)), options(client));
    expect(attributeLexiconSizeForTests()).toBe(256);
  });

  test('a null scope throws before any rpc', async () => {
    const { client, calls } = standard();
    await expect(attributeLexiconFor(null as unknown as TenantScope, options(client))).rejects.toThrow();
    await expect(resolveAttributeFilter(null as unknown as TenantScope, 'zeta-17', null, options(client))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('automatic matching', () => {
  test('a query naming a stored value resolves that key and value', async () => {
    const { client, calls } = standard();
    const resolved = await resolveAttributeFilter(SCOPE_A, `what does kappa-200 say ${SECRET_QUERY_WORD}`, null, options(client));
    expect(documentCalls(calls).map((call) => call.args)).toEqual([{ p_tenant_key: `o:${ORG_A}`, p_filters: { alpha_code: ['kappa-200'] }, p_limit: 2001 }]);
    expect(resolved.hardIds).toEqual([idOf(3)]);
    expect(resolved.explicitIds).toBeNull();
    expect(resolved.counts).toEqual({ explicitKeys: 0, matchedKeys: 1, aliasMatches: 0, ambiguous: 0, softKeys: 0 });
  });

  test('the longest value wins over a value it contains', async () => {
    const { client, calls } = standard();
    await resolveAttributeFilter(SCOPE_A, 'notes on lumen grove please', null, options(client));
    expect(documentCalls(calls)[0]?.args.p_filters).toEqual({ beta_list: ['lumen grove'] });
  });

  test('a value inside an identifier-shaped token is not matched', async () => {
    const { client, calls } = standard();
    const resolved = await resolveAttributeFilter(SCOPE_A, 'check vex-9 now', null, options(client));
    expect(documentCalls(calls)).toHaveLength(0);
    expect(resolved.stateDigest).toBeNull();
  });

  test('a code value matches in its whole, spaced and joined spellings', async () => {
    for (const query of ['about zeta-17 today', 'about zeta 17 today', 'about zeta17 today', 'about ZETA-17 today']) {
      resetAttributeLexiconForTests();
      const { client, calls } = standard();
      await resolveAttributeFilter(SCOPE_A, query, null, options(client));
      expect(documentCalls(calls)[0]?.args.p_filters, query).toEqual({ alpha_code: ['zeta-17'] });
    }
  });

  test('a short value, a short Han value and a stop word are never matched automatically', async () => {
    const { client, calls } = standard();
    const resolved = await resolveAttributeFilter(SCOPE_A, 'q the 星', null, options(client));
    expect(documentCalls(calls)).toHaveLength(0);
    expect(resolved).toMatchObject({ explicitIds: null, hardIds: null, softIds: [], stateDigest: null });
  });

  test('soft attributes go to softIds', async () => {
    const { client } = standard();
    const resolved = await resolveAttributeFilter(SCOPE_A, 'an orbit question', null, options(client));
    expect(resolved.hardIds).toBeNull();
    expect(resolved.softIds).toEqual([idOf(8)]);
    expect(resolved.counts.softKeys).toBe(1);
    expect(resolved.counts.matchedKeys).toBe(1);
  });

  test('a value stored under two filterable keys is ambiguous: one rpc per key, ids united in softIds', async () => {
    const { client, calls } = standard();
    const resolved = await resolveAttributeFilter(SCOPE_A, 'about nimbus', null, options(client));
    expect(documentCalls(calls).map((call) => call.args.p_filters)).toEqual([{ beta_list: ['nimbus'] }, { epsilon_text: ['nimbus'] }]);
    expect(resolved.hardIds).toBeNull();
    expect(resolved.softIds).toEqual([idOf(6), idOf(7)]);
    expect(resolved.counts.ambiguous).toBe(1);
  });

  test('nothing named and nothing explicit: no document call, empty lists, null digest', async () => {
    const { client, calls } = standard();
    const resolved = await resolveAttributeFilter(SCOPE_A, `nothing relevant ${SECRET_QUERY_WORD}`, null, options(client));
    expect(documentCalls(calls)).toHaveLength(0);
    expect(resolved).toEqual({
      explicitIds: null,
      hardIds: null,
      softIds: [],
      counts: { explicitKeys: 0, matchedKeys: 0, aliasMatches: 0, ambiguous: 0, softKeys: 0 },
      tooBroad: false,
      lexiconTruncated: false,
      lexiconUnavailable: false,
      aliasUnavailable: false,
      stateDigest: null,
    });
  });
});

describe('aliases through the terminology matcher', () => {
  const aliasLoader = () =>
    vi.fn(async () => ({
      dictionary: { tenantKey: `o:${ORG_A}`, entries: [], sharedVersion: 0, workspaceVersion: 0, version: 's0' },
      matcher: buildMatcher([termEntry('Orbit', ['circuit path']), termEntry('Kappa-200', ['old part'])], { minHanChars: 2 }),
    }));

  test('with RAG_TERMINOLOGY on, a TERM variant whose canonical equals a stored value resolves it', async () => {
    const { client, calls } = standard();
    const loader = aliasLoader();
    const resolved = await resolveAttributeFilter(SCOPE_A, 'the circuit path and the old part', null, options(client, { terminology: true, terminologyLoader: loader }));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]?.[0]).toBe(SCOPE_A);
    expect(resolved.counts.aliasMatches).toBe(2);
    expect(resolved.hardIds).toEqual([idOf(3)]);
    expect(resolved.softIds).toEqual([idOf(8)]);
    expect(documentCalls(calls).map((call) => call.args.p_filters)).toEqual([{ alpha_code: ['kappa-200'] }, { delta_text: ['orbit'] }]);
  });

  test('with it off the terminology loader is not called', async () => {
    const { client } = standard();
    const loader = aliasLoader();
    const resolved = await resolveAttributeFilter(SCOPE_A, 'the circuit path', null, options(client, { terminology: false, terminologyLoader: loader }));
    expect(loader).not.toHaveBeenCalled();
    expect(resolved.counts.aliasMatches).toBe(0);
    expect(resolved.stateDigest).toBeNull();
  });

  test('a loader failure keeps the direct matches and sets aliasUnavailable', async () => {
    const { client } = standard();
    const loader = vi.fn(async () => {
      throw new Error('terminology down');
    });
    const resolved = await resolveAttributeFilter(SCOPE_A, 'kappa-200 and the circuit path', null, options(client, { terminology: true, terminologyLoader: loader }));
    expect(resolved.aliasUnavailable).toBe(true);
    expect(resolved.hardIds).toEqual([idOf(3)]);
    expect(resolved.counts.aliasMatches).toBe(0);
  });
});

describe('explicit filter, merge and caps', () => {
  test('a key present in the explicit filter is not resolved automatically; other matched keys are added', async () => {
    const { client, calls } = standard();
    const resolved = await resolveAttributeFilter(SCOPE_A, 'zeta-17 and lumen grove', { alpha_code: ['kappa-200'] }, options(client));
    expect(documentCalls(calls).map((call) => call.args.p_filters)).toEqual([{ alpha_code: ['kappa-200'] }, { beta_list: ['lumen grove'] }]);
    expect(resolved.explicitIds).toEqual([idOf(3)]);
    expect(resolved.hardIds).toEqual([idOf(5)]);
    expect(resolved.counts).toMatchObject({ explicitKeys: 1, matchedKeys: 1 });
  });

  test('explicit values are sorted and de-duplicated before the call', async () => {
    const { client, calls } = standard();
    await resolveAttributeFilter(SCOPE_A, '', { beta_list: ['nimbus', 'lumen', 'nimbus'] }, options(client));
    expect(documentCalls(calls)[0]?.args.p_filters).toEqual({ beta_list: ['lumen', 'nimbus'] });
  });

  test('the explicit filter is resolved when the lexicon cannot be loaded', async () => {
    const { client, calls } = fakeClient({
      rag_attribute_filter_values: { data: null, error: { message: 'down', code: 'XX000' } },
      rag_attribute_documents: documentsAnswer(TABLE),
    });
    const resolved = await resolveAttributeFilter(SCOPE_A, 'zeta-17', { beta_list: ['vex'] }, options(client));
    expect(resolved.lexiconUnavailable).toBe(true);
    expect(resolved.explicitIds).toEqual([idOf(9)]);
    expect(resolved.hardIds).toBeNull();
    expect(documentCalls(calls)).toHaveLength(1);
  });

  test('a lexicon over the row cap turns automatic resolution off; the explicit filter still resolves', async () => {
    const big = Array.from({ length: ATTRIBUTE_LEXICON_ROW_CAP + 1 }, (_, index) => ({ key: 'beta_list', value: `v${String(index).padStart(5, '0')}`, type: 'text_list', soft: false }));
    big.push({ key: 'alpha_code', value: 'zeta-17', type: 'code', soft: false });
    const { client, calls } = fakeClient({ rag_attribute_filter_values: { data: big, error: null }, rag_attribute_documents: documentsAnswer(TABLE) });
    const resolved = await resolveAttributeFilter(SCOPE_A, 'zeta-17 v00001', { beta_list: ['vex'] }, options(client));
    expect(resolved.lexiconTruncated).toBe(true);
    expect(resolved.hardIds).toBeNull();
    expect(resolved.explicitIds).toEqual([idOf(9)]);
    expect(documentCalls(calls)).toHaveLength(1);
  });

  test('too broad: one row above the id cap is never an explicit or hard list; the first cap ids go to softIds', async () => {
    const many = Array.from({ length: 6 }, (_, index) => idOf(100 + index));
    const { client } = fakeClient({
      rag_attribute_filter_values: lexiconAnswer({ [`o:${ORG_A}`]: LEXICON_A }),
      rag_attribute_documents: documentsAnswer({ ...TABLE, 'alpha_code=zeta-17': many, 'beta_list=vex': many }),
    });
    const cap = { schema_version: 1 as const, rules_version: 1, soft_weight: 0.5, id_cap: 5 };
    const hard = await resolveAttributeFilter(SCOPE_A, 'zeta-17', null, options(client, { config: cap }));
    expect(hard.hardIds).toBeNull();
    expect(hard.tooBroad).toBe(true);
    expect(hard.softIds).toEqual(many.slice(0, 5));
    const explicit = await resolveAttributeFilter(SCOPE_A, '', { beta_list: ['vex'] }, options(client, { config: cap }));
    expect(explicit.explicitIds).toBeNull();
    expect(explicit.tooBroad).toBe(true);
    expect(explicit.softIds).toEqual(many.slice(0, 5));
    const atCap = await resolveAttributeFilter(SCOPE_A, 'kappa-200', null, options(client, { config: cap }));
    expect(atCap.tooBroad).toBe(false);
  });

  test('the digest is stable across order and changes with the state', async () => {
    const { client } = standard();
    const one = await resolveAttributeFilter(SCOPE_A, 'lumen grove and zeta-17', { epsilon_text: ['b', 'a'] }, options(client));
    const two = await resolveAttributeFilter(SCOPE_A, 'zeta-17 and lumen grove', { epsilon_text: ['a', 'b'] }, options(client));
    const three = await resolveAttributeFilter(SCOPE_A, 'zeta-17 and lumen grove', { epsilon_text: ['a', 'c'] }, options(client));
    expect(one.stateDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(two.stateDigest).toBe(one.stateDigest);
    expect(three.stateDigest).not.toBe(one.stateDigest);
  });
});

describe('errors', () => {
  test('an rpc message starting unknown_attribute becomes AttributeFilterError 400 with a key path', async () => {
    const { client } = fakeClient({
      rag_attribute_filter_values: lexiconAnswer({ [`o:${ORG_A}`]: LEXICON_A }),
      rag_attribute_documents: { data: null, error: { message: 'unknown_attribute', code: '22023' } },
    });
    const error = await resolveAttributeFilter(SCOPE_A, '', { gamma_text: ['zeta-17'] }, options(client)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AttributeFilterError);
    expect(error).toMatchObject({ code: 'unknown_attribute', status: 400, details: [{ path: 'attributes.gamma_text', message: 'unknown_attribute' }] });
    expect(String((error as Error).message)).not.toContain('zeta-17');
  });

  test('any other rpc failure is a RetrievalBackendError with the code only', async () => {
    const { client } = fakeClient({
      rag_attribute_filter_values: lexiconAnswer({ [`o:${ORG_A}`]: LEXICON_A }),
      rag_attribute_documents: { data: null, error: { message: 'value zeta-17 broke', code: '57014' } },
    });
    const error = await resolveAttributeFilter(SCOPE_A, 'zeta-17', null, options(client)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RetrievalBackendError);
    expect((error as RetrievalBackendError).code).toBe('57014');
    expect((error as Error).message).not.toContain('zeta-17');
  });

  test('the only tenant argument sent is scopeKey(scope)', async () => {
    const { client, calls } = standard();
    await resolveAttributeFilter(SCOPE_A, 'zeta-17 and orbit and nimbus', { beta_list: ['vex'] }, options(client));
    for (const call of calls) {
      expect(Object.keys(call.args).filter((name) => /tenant|user|org/i.test(name))).toEqual(['p_tenant_key']);
      expect(call.args.p_tenant_key).toBe(scopeKey(SCOPE_A));
    }
  });
});
