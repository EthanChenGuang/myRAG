import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { resetIdentifierPatternCacheForTests } from '@/lib/rag/identifiers/patterns';
import { lexicalOptionsOn, resetLexicalOptionsForTests, resolveLexicalOptions, type LexicalSwitches } from '@/lib/rag/lexical/resolve-options';
import { QUANTITY_TOKEN_PREFIX } from '@/lib/rag/lexical/options';
import { lexicalTokens } from '@/lib/rag/lexical/tokenize';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import { mintScope } from '@/lib/rag/tenant/scope';

// Invented words only; canonicals are general unit symbols of the registry.
const USER_A = '33333333-3333-4333-8333-333333333333';
const USER_B = '44444444-4444-4444-8444-444444444444';
const scopeA = mintScope('personal', USER_A, null);
const scopeB = mintScope('personal', USER_B, null);
const KEY_A = `u:${USER_A}`;
const KEY_B = `u:${USER_B}`;

type Row = Record<string, unknown>;

function entry(id: string, canonical: string, variants: string[], kind = 'synonym'): Row {
  return {
    entry_id: id,
    layer: 'workspace',
    canonical,
    variants,
    normalized_variants: variants,
    language: 'en',
    kind,
    mode: 'one_way',
    source_language: null,
    target_language: null,
    shared_version: 3,
    tenant_version: 5,
  };
}

const DICT_A: Row[] = [
  entry('a1', 'kg', ['zorkilo', 'Plemba']),
  entry('a2', 'ml', ['vintaro'], 'abbreviation'),
  entry('a3', 'kg', ['zorki lo', 'zork9']),
  entry('a4', 'kg', ['traskel'], 'translation'),
  entry('a5', 'kg', ['zorkilio'], 'misspelling'),
  entry('a6', 'kg', ['qelmu'], 'identifier'),
  entry('a7', 'zento prisma', ['brelto']),
];
const DICT_B: Row[] = [entry('b1', 'ml', ['dumbaro'])];

interface Fake {
  client: RpcClient;
  calls: Array<{ fn: string; args: Row }>;
  fail: Set<string>;
}

function fakeClient(): Fake {
  const calls: Fake['calls'] = [];
  const fail = new Set<string>();
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      let response: RpcResponse;
      if (fail.has(fn)) response = { data: null, error: { message: 'boom', code: 'XX000' } };
      else if (fn === 'rag_term_effective') response = { data: args.p_tenant_key === KEY_A ? DICT_A : args.p_tenant_key === KEY_B ? DICT_B : [], error: null };
      else if (fn === 'rag_identifier_patterns_list') response = { data: [], error: null };
      else response = { data: null, error: { message: 'unknown', code: 'PGRST202' } };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls, fail };
}

function switches(quantity: boolean, dictionary = false, stemIt = false, identifierIndex = false): LexicalSwitches {
  return { v2: { lexicalDictionary: dictionary, lexicalStemIt: stemIt, identifierIndex, lexicalQuantity: quantity } };
}

let fake: Fake;

beforeEach(() => {
  fake = fakeClient();
  setRagDepsForTests({ adminClient: () => fake.client as never, now: () => 1_000_000 });
  setIngestDepsForTests({ db: () => fake.client, now: () => 1_000_000 });
  invalidateTerminologyCache('all');
  resetIdentifierPatternCacheForTests();
});

afterEach(() => {
  resetLexicalOptionsForTests();
  resetRagDepsForTests();
  resetIngestDepsForTests();
  invalidateTerminologyCache('all');
  resetIdentifierPatternCacheForTests();
  vi.restoreAllMocks();
});

const quantityTokens = (tokens: string[]) => tokens.filter((token) => token.startsWith(QUANTITY_TOKEN_PREFIX));

describe('lexicalOptionsOn: the one off rule (D-33)', () => {
  it('is false only while all four switches are off', () => {
    expect(lexicalOptionsOn(switches(false))).toBe(false);
    expect(lexicalOptionsOn(switches(true))).toBe(true);
    expect(lexicalOptionsOn(switches(false, true))).toBe(true);
    expect(lexicalOptionsOn(switches(false, false, true))).toBe(true);
    expect(lexicalOptionsOn(switches(false, false, false, true))).toBe(true);
    expect(lexicalOptionsOn(undefined)).toBe(false);
  });
});

describe('resolveLexicalOptions: quantity (D-31, D-32)', () => {
  it('every switch off: no options and no database call', async () => {
    const result = await resolveLexicalOptions(scopeA, switches(false), { language: 'en' });
    expect(result).toEqual({ options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it('quantity alone: quantity true, nothing loaded, the stamp unchanged', async () => {
    const result = await resolveLexicalOptions(scopeA, switches(true), { language: 'en' });
    expect(result.options).toEqual({ quantity: true });
    expect(result.stamp).toEqual({ dictVersion: null, patterns: null });
    expect(result.warnings).toEqual([]);
    expect(fake.calls).toHaveLength(0);
    expect(quantityTokens(lexicalTokens('pesa 2,5 kg', result.options))).toEqual([`${QUANTITY_TOKEN_PREFIX}2.5kg`]);
  });

  it('with the dictionary: single-word variants of unit canonicals become aliases; other kinds and forms are left out', async () => {
    const { options, stamp } = await resolveLexicalOptions(scopeA, switches(true, true), { language: 'en' });
    expect(stamp.dictVersion).toBe('s3.w5');
    expect(options?.quantity).toEqual({ unitAliases: { zorkilo: 'kg', plemba: 'kg', vintaro: 'ml' } });
    expect(quantityTokens(lexicalTokens('totale 3 zorkilo', options))).toEqual([`${QUANTITY_TOKEN_PREFIX}3kg`]);
    expect(quantityTokens(lexicalTokens('totale 3 traskel 4 qelmu 5 brelto', options))).toEqual([]);
  });

  it('never returns tenant A aliases for tenant B (two keys, T-03.3-2101)', async () => {
    const a = await resolveLexicalOptions(scopeA, switches(true, true), { language: 'en' });
    const b = await resolveLexicalOptions(scopeB, switches(true, true), { language: 'en' });
    const bAliases = typeof b.options?.quantity === 'object' && b.options.quantity ? (b.options.quantity.unitAliases ?? {}) : {};
    const leaked = Object.keys(bAliases).filter((word) => word !== 'dumbaro');
    expect(leaked.length, `leaked alias count ${leaked.length}`).toBe(0);
    expect(bAliases).toEqual({ dumbaro: 'ml' });
    expect(quantityTokens(lexicalTokens('totale 3 zorkilo', b.options))).toEqual([]);
    expect(quantityTokens(lexicalTokens('totale 3 dumbaro', a.options))).toEqual([]);
    const keys = fake.calls.filter((call) => call.fn === 'rag_term_effective').map((call) => call.args.p_tenant_key);
    expect(keys).toEqual([KEY_A, KEY_B]);
  });

  it('a dictionary load failure gives quantity true and the existing warning code', async () => {
    fake.fail.add('rag_term_effective');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveLexicalOptions(scopeA, switches(true, true), { language: 'en' });
    expect(result.options?.quantity).toBe(true);
    expect(result.warnings).toEqual(['lexical_dictionary_unavailable']);
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toMatch(/zorkilo|plemba|vintaro/);
  });
});
