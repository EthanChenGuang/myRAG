import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { resetRagDepsForTests, setRagDepsForTests } from '@/lib/rag/deps';
import { resetIngestDepsForTests, setIngestDepsForTests } from '@/lib/rag/ingest/deps';
import { resetIdentifierPatternCacheForTests } from '@/lib/rag/identifiers/patterns';
import {
  resetLexicalOptionsForTests,
  resolveLexicalOptions,
  setLexicalOptionsResolverForTests,
  type LexicalSwitches,
} from '@/lib/rag/lexical/resolve-options';
import { DICT_TOKEN_PREFIX, STEM_TOKEN_PREFIX } from '@/lib/rag/lexical/options';
import { lexicalTokens } from '@/lib/rag/lexical/tokenize';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import { mintScope } from '@/lib/rag/tenant/scope';

// Synthetic, neutral vocabulary only: invented Han and Latin terms, one invented Italian pair.
const HAN_TERM = '星蓝矩';
const LATIN_TERM = 'zento prisma';
const SINGLE_LATIN = 'zorblat';
const ONE_HAN = '矩';
const MISSPELLING = 'zento prizma';
const IDENTIFIER_TERM = 'qx 4471';
const TRANSLATION_TERM = 'vorla tenki';
const DISABLED_TERM = 'mirto lunge';
const TERM_B = 'falto rimbo';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const scopeA = mintScope('personal', USER_A, null);
const scopeB = mintScope('personal', USER_B, null);
const KEY_A = `u:${USER_A}`;
const KEY_B = `u:${USER_B}`;

type Row = Record<string, unknown>;

function entry(id: string, canonical: string, variants: string[], kind = 'synonym', extra: Row = {}): Row {
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
    shared_version: 4,
    tenant_version: 7,
    ...extra,
  };
}

const DICT_A: Row[] = [
  entry('a1', HAN_TERM, [HAN_TERM]),
  entry('a2', LATIN_TERM, [LATIN_TERM]),
  entry('a3', SINGLE_LATIN, [SINGLE_LATIN]),
  entry('a4', ONE_HAN, [ONE_HAN]),
  entry('a5', LATIN_TERM, [MISSPELLING], 'misspelling'),
  entry('a6', IDENTIFIER_TERM, [IDENTIFIER_TERM], 'identifier'),
  entry('a7', TRANSLATION_TERM, [TRANSLATION_TERM], 'translation', { source_language: 'en', target_language: 'it' }),
];
const DICT_B: Row[] = [entry('b1', TERM_B, [TERM_B], 'synonym', { shared_version: 4, tenant_version: 2 })];

interface Fake {
  client: RpcClient;
  calls: Array<{ fn: string; args: Row }>;
  fail: Set<string>;
  patterns: Map<string, Row[]>;
}

function fakeClient(): Fake {
  const calls: Fake['calls'] = [];
  const fail = new Set<string>();
  const patterns = new Map<string, Row[]>();
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      let response: RpcResponse;
      if (fail.has(fn)) response = { data: null, error: { message: 'boom', code: 'XX000' } };
      else if (fn === 'rag_term_effective') response = { data: args.p_tenant_key === KEY_A ? DICT_A : args.p_tenant_key === KEY_B ? DICT_B : [], error: null };
      else if (fn === 'rag_identifier_patterns_list') response = { data: patterns.get(String(args.p_tenant_key)) ?? [], error: null };
      else response = { data: null, error: { message: 'unknown', code: 'PGRST202' } };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve(response).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls, fail, patterns };
}

function switches(dictionary: boolean, stemIt: boolean, identifierIndex: boolean): LexicalSwitches {
  return { v2: { lexicalDictionary: dictionary, lexicalStemIt: stemIt, identifierIndex } };
}

function patternRow(id: string, pattern: string, flags = 'u', enabled = true): Row {
  return { id, name: `p-${id}`, pattern, flags, enabled, created_at: null, updated_at: null };
}

function fingerprint(lines: string[]): string {
  return `p${crypto.createHash('sha256').update([...lines].sort().join('\n')).digest('hex').slice(0, 12)}`;
}

let fake: Fake;
let clock = 1_000_000;

beforeEach(() => {
  fake = fakeClient();
  clock = 1_000_000;
  setRagDepsForTests({ adminClient: () => fake.client as never, now: () => clock });
  setIngestDepsForTests({ db: () => fake.client, now: () => clock });
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

const dictTokens = (tokens: string[]) => tokens.filter((token) => token.startsWith(DICT_TOKEN_PREFIX));

describe('resolveLexicalOptions: all switches off', () => {
  it('returns no options, empty stamps and no warning, without a database call', async () => {
    const result = await resolveLexicalOptions(scopeA, switches(false, false, false), { language: 'it' });
    expect(result).toEqual({ options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: [] });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('resolveLexicalOptions: dictionary (D-08)', () => {
  it('exposes the loader version and matches only qualifying terms', async () => {
    const { options, stamp, warnings } = await resolveLexicalOptions(scopeA, switches(true, false, false), { language: 'en' });
    expect(warnings).toEqual([]);
    expect(options?.dictionary?.version).toBe('s4.w7');
    expect(stamp).toEqual({ dictVersion: 's4.w7', patterns: null });
    const terms = (text: string) => (options?.dictionary?.match(text) ?? []).map((item) => item.term);
    expect(terms(`规则${HAN_TERM}说明`)).toEqual([HAN_TERM]);
    expect(terms(`before ${LATIN_TERM} after`)).toEqual([LATIN_TERM]);
    expect(terms(`a ${SINGLE_LATIN} b`)).toEqual([]);
    expect(terms(`甲${ONE_HAN}乙`)).toEqual([]);
    expect(terms(`a ${MISSPELLING} b`)).toEqual([]);
    expect(terms(`a ${IDENTIFIER_TERM} b`)).toEqual([]);
    expect(terms(`a ${TRANSLATION_TERM} b`)).toEqual([TRANSLATION_TERM]);
    expect(dictTokens(lexicalTokens(`规则${HAN_TERM}说明 ${LATIN_TERM}`, options))).toEqual([`${DICT_TOKEN_PREFIX}${HAN_TERM}`, `${DICT_TOKEN_PREFIX}zento_prisma`]);
  });

  it('emits the canonical for a qualifying variant', async () => {
    DICT_A.push(entry('a8', LATIN_TERM, ['zento prismata']));
    try {
      const { options } = await resolveLexicalOptions(scopeA, switches(true, false, false), { language: 'en' });
      expect((options?.dictionary?.match('the zento prismata here') ?? []).map((item) => item.term)).toEqual([LATIN_TERM]);
    } finally {
      DICT_A.pop();
    }
  });

  it('does not match an entry the effective dictionary leaves out (disabled)', async () => {
    const { options } = await resolveLexicalOptions(scopeA, switches(true, false, false), { language: 'en' });
    expect(options?.dictionary?.match(`a ${DISABLED_TERM} b`) ?? []).toEqual([]);
  });

  it('never uses tenant A terms for tenant B (two keys, T-04.2-70)', async () => {
    const a = await resolveLexicalOptions(scopeA, switches(true, false, false), { language: 'en' });
    const b = await resolveLexicalOptions(scopeB, switches(true, false, false), { language: 'en' });
    const text = `${HAN_TERM} ${LATIN_TERM} ${TRANSLATION_TERM} ${TERM_B}`;
    const leaked = (b.options?.dictionary?.match(text) ?? []).filter((item) => item.term !== TERM_B);
    expect(leaked.length, `leaked term count ${leaked.length}`).toBe(0);
    expect((a.options?.dictionary?.match(text) ?? []).map((item) => item.term)).not.toContain(TERM_B);
    expect(b.options?.dictionary?.version).toBe('s4.w2');
    const keys = fake.calls.filter((call) => call.fn === 'rag_term_effective').map((call) => call.args.p_tenant_key);
    expect(keys).toEqual([KEY_A, KEY_B]);
  });

  it('a second call within the loader TTL makes no new load', async () => {
    await resolveLexicalOptions(scopeA, switches(true, false, false), { language: 'en' });
    clock += 1_000;
    await resolveLexicalOptions(scopeA, switches(true, false, false), { language: 'en' });
    expect(fake.calls.filter((call) => call.fn === 'rag_term_effective')).toHaveLength(1);
  });

  it('a loader failure answers no dictionary and lexical_dictionary_unavailable, without throwing', async () => {
    fake.fail.add('rag_term_effective');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveLexicalOptions(scopeA, switches(true, false, false), { language: 'en' });
    expect(result.options?.dictionary ?? undefined).toBeUndefined();
    expect(result.stamp.dictVersion).toBeNull();
    expect(result.warnings).toEqual(['lexical_dictionary_unavailable']);
  });
});

describe('resolveLexicalOptions: Italian stemming (D-10)', () => {
  it('sets stemIt and the document language; the dictionary stays off', async () => {
    const { options, stamp } = await resolveLexicalOptions(scopeA, switches(false, true, false), { language: 'it' });
    expect(options?.stemIt).toBe(true);
    expect(options?.language).toBe('it');
    expect(options?.dictionary ?? undefined).toBeUndefined();
    expect(stamp).toEqual({ dictVersion: null, patterns: null });
    expect(lexicalTokens('le sfolte grandi', options).some((token) => token.startsWith(STEM_TOKEN_PREFIX))).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('resolveLexicalOptions: identifier patterns (D-30)', () => {
  it('passes the tenant compiled list and a fingerprint of the enabled patterns', async () => {
    fake.patterns.set(KEY_A, [patternRow('00000000-0000-4000-8000-00000000000a', 'QV-[0-9]{3}'), patternRow('00000000-0000-4000-8000-00000000000b', 'ZZ[0-9]{2}', 'iu', false)]);
    const { options, stamp } = await resolveLexicalOptions(scopeA, switches(false, false, true), { language: 'en' });
    expect(options?.identifierPatterns?.map((re) => re.source)).toEqual(['QV-[0-9]{3}']);
    expect(stamp.patterns).toMatch(/^p[0-9a-f]{12}$/u);
    expect(stamp.patterns).toBe(fingerprint(['00000000-0000-4000-8000-00000000000a|QV-[0-9]{3}|u']));
  });

  it('the empty list has a fixed fingerprint', async () => {
    const { options, stamp } = await resolveLexicalOptions(scopeB, switches(false, false, true), { language: 'en' });
    expect(options?.identifierPatterns).toEqual([]);
    expect(stamp.patterns).toBe(fingerprint([]));
  });

  it('changing, adding, disabling or deleting a pattern changes the fingerprint', async () => {
    const id1 = '00000000-0000-4000-8000-000000000001';
    const id2 = '00000000-0000-4000-8000-000000000002';
    const variants: Row[][] = [
      [patternRow(id1, 'QV-[0-9]{3}')],
      [patternRow(id1, 'QV-[0-9]{4}')],
      [patternRow(id1, 'QV-[0-9]{4}'), patternRow(id2, 'ZZ[0-9]{2}')],
      [patternRow(id1, 'QV-[0-9]{4}'), patternRow(id2, 'ZZ[0-9]{2}', 'u', false)],
      [],
    ];
    const seen: Array<string | null> = [];
    for (const rows of variants) {
      resetIdentifierPatternCacheForTests();
      fake.patterns.set(KEY_A, rows);
      seen.push((await resolveLexicalOptions(scopeA, switches(false, false, true), { language: 'en' })).stamp.patterns);
    }
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1]).not.toBe(seen[2]);
    expect(seen[2]).not.toBe(seen[3]);
    expect(seen[3]).toBe(seen[1]);
    expect(seen[4]).not.toBe(seen[1]);
  });

  it('a pattern load failure answers no patterns, no stamp and identifier_patterns_unavailable', async () => {
    fake.fail.add('rag_identifier_patterns_list');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await resolveLexicalOptions(scopeA, switches(false, false, true), { language: 'en' });
    expect(result.options?.identifierPatterns ?? undefined).toBeUndefined();
    expect(result.stamp.patterns).toBeNull();
    expect(result.warnings).toEqual(['identifier_patterns_unavailable']);
  });

  it('logs no term or pattern text', async () => {
    const lines: string[] = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(JSON.stringify(args));
      });
    }
    fake.patterns.set(KEY_A, [patternRow('00000000-0000-4000-8000-00000000000a', 'QV-[0-9]{3}')]);
    await resolveLexicalOptions(scopeA, switches(true, true, true), { language: 'it' });
    fake.fail.add('rag_term_effective');
    fake.fail.add('rag_identifier_patterns_list');
    invalidateTerminologyCache('all');
    resetIdentifierPatternCacheForTests();
    await resolveLexicalOptions(scopeA, switches(true, true, true), { language: 'it' });
    const joined = lines.join('\n');
    for (const secret of [HAN_TERM, 'zento', 'QV-']) expect(joined).not.toContain(secret);
  });
});

describe('test setters', () => {
  it('setLexicalOptionsResolverForTests replaces the resolver and reset restores it', async () => {
    setLexicalOptionsResolverForTests(async () => ({ options: { stemIt: true }, stamp: { dictVersion: 's9', patterns: null }, warnings: [] }));
    expect((await resolveLexicalOptions(scopeA, switches(false, false, false), { language: null })).stamp.dictVersion).toBe('s9');
    resetLexicalOptionsForTests();
    expect((await resolveLexicalOptions(scopeA, switches(false, false, false), { language: null })).stamp.dictVersion).toBeNull();
  });

  it('rejects an unminted scope', async () => {
    await expect(resolveLexicalOptions({ kind: 'single' } as never, switches(true, false, false), { language: null })).rejects.toThrow(/unminted/u);
  });
});
