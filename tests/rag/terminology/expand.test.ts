import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import { queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { deriveStatus } from '@/lib/rag/pipeline';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { expandMatches, terminologyParams } from '@/lib/rag/terminology/expand';
import {
  invalidateTerminologyCache,
  loadEffectiveDictionary,
  terminologyCacheSizeForTests,
  TERMINOLOGY_CACHE_MAX,
  TERMINOLOGY_CACHE_TTL_MS,
} from '@/lib/rag/terminology/load';
import { buildMatcher, type TermEntry } from '@/lib/rag/terminology/matcher';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, Profile, QueryVariant, StageOverrides } from '@/lib/rag/types';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { normalizeLexical } from '@/lib/rag/lexical/tokenize';
import { uninstallDeps } from '../helpers/pipeline-fakes';

const QUERY_TRANSFORMS = ['translate', 'condense', 'normalize_dates', 'expand', 'hyde', 'decompose'];
const AFTER_TERMINOLOGY = ['semantic_cache', 'embed'];

let nextId = 0;
function entry(canonical: string, variants: string[], extra: Partial<TermEntry> = {}): TermEntry {
  nextId += 1;
  return {
    entryId: `00000000-0000-4000-8000-${nextId.toString(16).padStart(12, '0')}`,
    layer: 'shared',
    canonical,
    variants,
    normalizedVariants: variants.map((variant) => normalizeLexical(variant)),
    language: 'any',
    kind: 'synonym',
    mode: 'one_way',
    sourceLanguage: null,
    targetLanguage: null,
    ...extra,
  };
}

function expand(query: string, entries: TermEntry[]) {
  const params = terminologyParams();
  const matcher = buildMatcher(entries, { minHanChars: params.min_han_chars });
  return expandMatches(query, matcher.match(query), params);
}

function dbRow(value: TermEntry, versions = { shared: 1, tenant: 0 }) {
  return {
    entry_id: value.entryId,
    layer: value.layer,
    canonical: value.canonical,
    variants: value.variants,
    normalized_variants: value.normalizedVariants,
    language: value.language,
    kind: value.kind,
    mode: value.mode,
    source_language: value.sourceLanguage,
    target_language: value.targetLanguage,
    shared_version: versions.shared,
    tenant_version: versions.tenant,
  };
}

interface TermClientOptions {
  rows?: (tenantKey: string) => unknown[];
  fail?: boolean;
  delayMs?: number;
}

function termClient(options: TermClientOptions = {}) {
  const calls: Array<{ fn: string; tenantKey: string }> = [];
  const client: RpcClient = {
    rpc(fn, args): RpcRequest {
      const tenantKey = String(args.p_tenant_key);
      calls.push({ fn, tenantKey });
      let signal: AbortSignal | undefined;
      const response = (): RpcResponse =>
        options.fail ? { data: null, error: { code: 'P0001', message: 'synthetic failure' } } : { data: options.rows?.(tenantKey) ?? [], error: null };
      const request: RpcRequest = {
        abortSignal(next) {
          signal = next;
          return request;
        },
        then(onFulfilled, onRejected) {
          const settled = new Promise<RpcResponse>((resolve) => {
            const timer = setTimeout(() => resolve(response()), options.delayMs ?? 0);
            signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
          });
          return settled.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function orgScope(index: number): TenantScope {
  return mintScope('org', null, `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`);
}

function installQueryLlm(entries: FakeQueryLlmEntry[]) {
  const fake = createFakeQueryLlm({ table: { version: 1, entries } });
  const llm: QueryLlm = {
    model: fake.model,
    generate<T>(request: QueryLlmRequest<T>) {
      return fake.generate(request);
    },
  };
  setRagDepsForTests({ queryLlm: () => llm });
}

async function runQuery(
  query: string,
  options: {
    env?: Record<string, string>;
    profile?: Profile;
    history?: HistoryTurn[];
    queryVariants?: QueryVariant[];
    stageOverrides?: StageOverrides;
    scope?: TenantScope;
  } = {},
) {
  const profile = options.profile ?? 'eval';
  const scope = options.scope ?? mintScope('single', null, null);
  const collector = createTraceCollector({ profile, tenantKey: scopeKey(scope) });
  const signal = new AbortController().signal;
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', RAG_TERMINOLOGY: 'true', ...options.env });
  const out = await runQueryStages({
    input: {
      scope,
      query,
      profile,
      signal,
      ...(options.history ? { history: options.history } : {}),
      ...(options.queryVariants ? { queryVariants: options.queryVariants } : {}),
    },
    scope,
    config,
    profile,
    signal,
    collector,
    ...(options.stageOverrides ? { stageOverrides: options.stageOverrides } : {}),
  });
  return { out, collector };
}

/** A transform recorded disabled never ran, so it has no place in the order (with the layer on and its translate off, the Phase 4
 * translate slot records after the layer: Phase 6's own order, which terminology cannot precede without following semantic_cache). */
function ranStageNames(records: ReturnType<ReturnType<typeof createTraceCollector>['stages']>): string[] {
  return records.filter((row) => row.name === 'terminology' || row.status !== 'disabled').map((row) => row.name);
}

function expectStageOrder(names: string[]) {
  const at = names.indexOf('terminology');
  expect(at).toBeGreaterThanOrEqual(0);
  for (const name of QUERY_TRANSFORMS) {
    const index = names.indexOf(name);
    if (index >= 0) expect(index, `${name} before terminology`).toBeLessThan(at);
  }
  for (const name of AFTER_TERMINOLOGY) {
    const index = names.indexOf(name);
    if (index >= 0) expect(index, `${name} after terminology`).toBeGreaterThan(at);
  }
}

function expectNoText(records: ReturnType<ReturnType<typeof createTraceCollector>['stages']>, texts: string[]) {
  const record = records.find((row) => row.name === 'terminology');
  const serialized = JSON.stringify({ detail: record?.detail ?? null, counts: record?.counts ?? null });
  for (const text of texts) expect(serialized).not.toContain(text);
}

describe('expansion (D-13, D-17, D-32)', () => {
  it('a Han variant adds the canonical bigrams that the query does not already hold', () => {
    const query = '关于术语甲的问题';
    const result = expand(query, [entry('术语甲乙丙', ['术语甲'], { language: 'zh' })]);
    expect(result.matches.map((match) => ({ surface: match.surface, canonical: match.canonical }))).toEqual([
      { surface: '术语甲', canonical: '术语甲乙丙' },
    ]);
    expect(result.tokens).toEqual(expect.arrayContaining(['甲乙', '乙丙']));
    const original = new Set(queryLexicalTokens(query));
    for (const token of result.tokens) expect(original.has(token)).toBe(false);
    expect(result.capped).toBe(false);
  });

  it('the longer variant wins over a shorter one at the same place', () => {
    const result = expand('新版术语甲', [entry('术语甲乙丙', ['术语甲'], { language: 'zh' }), entry('术语丁戊己', ['新版术语甲'], { language: 'zh' })]);
    expect(result.matches.map((match) => match.canonical)).toEqual(['术语丁戊己']);
  });

  it('a Latin variant matches on token boundaries only', () => {
    const entries = [entry('term alpha beta', ['termalpha'])];
    expect(expand('xtermalpha', entries).matches).toHaveLength(0);
    expect(expand('the termalpha item', entries).matches).toHaveLength(1);
  });

  it('equivalent: a member adds the canonical and the other members; one_way: the canonical adds nothing', () => {
    const equivalent = entry('term alpha beta', ['termalpha', 'term gamma delta'], { mode: 'equivalent' });
    const fromB = expand('termalpha', [equivalent]);
    expect(fromB.tokens).toEqual(['term', 'alpha', 'beta', 'gamma', 'delta']);

    const oneWay = entry('term alpha beta', ['termalpha']);
    const fromA = expand('term alpha beta', [oneWay]);
    expect(fromA.matches).toHaveLength(0);
    expect(fromA.tokens).toEqual([]);
  });

  it('chained entries expand one hop only', () => {
    const result = expand('termalpha', [entry('termbeta', ['termalpha']), entry('termgamma', ['termbeta'])]);
    expect(result.tokens).toEqual(['termbeta']);
  });

  it('a translation pair whose source term is in the query adds nothing and is not a match', () => {
    const pair = entry('term alpha beta', ['术语甲乙丙'], { kind: 'translation', language: 'zh', sourceLanguage: 'zh', targetLanguage: 'en' });
    const result = expand('关于术语甲乙丙的问题', [pair]);
    expect(result.matches).toHaveLength(0);
    expect(result.tokens).toEqual([]);
  });

  it('caps matches and expansion tokens and records capped', () => {
    const params = terminologyParams();
    const entries = Array.from({ length: 10 }, (_, index) => {
      const tag = String.fromCharCode(97 + index);
      return entry(`canon${tag}one canon${tag}two canon${tag}three canon${tag}four`, [`variant${tag}`]);
    });
    const query = entries.map((value) => value.variants[0]).join(' ');
    const result = expand(query, entries);
    expect(result.matches).toHaveLength(params.max_matches);
    expect(result.tokens.length).toBeLessThanOrEqual(params.max_expansion_tokens);
    expect(result.capped).toBe(true);
  });

  it('caps the terms of one equivalent match', () => {
    const params = terminologyParams();
    const members = Array.from({ length: params.max_terms_per_match + 2 }, (_, index) => `membervariant${String.fromCharCode(97 + index)}`);
    const result = expand(members[0]!, [entry('membercanonical', members, { mode: 'equivalent' })]);
    expect(result.tokens).toHaveLength(params.max_terms_per_match);
    expect(result.capped).toBe(true);
  });
});

describe('the terminology stage in the query group (D-15, D-21)', () => {
  beforeEach(() => {
    uninstallDeps();
    invalidateTerminologyCache('all');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    invalidateTerminologyCache('all');
    vi.restoreAllMocks();
  });

  const dictionary = [entry('term alpha beta', ['termalpha'])];

  function installDictionary(options: TermClientOptions = {}) {
    const rpc = termClient({ rows: () => dictionary.map((value) => dbRow(value, { shared: 3, tenant: 0 })), ...options });
    setRagDepsForTests({ adminClient: () => rpc.client as never });
    return rpc;
  }

  it('without the query layer it runs after translate, records counts and version only, and expands', async () => {
    installDictionary();
    const { out, collector } = await runQuery('what is termalpha');
    const names = collector.stages().map((row) => row.name);
    expectStageOrder(names);
    expect(names.slice(0, names.indexOf('terminology') + 1).filter((name) => name !== 'refs')).toEqual(['analyze', 'translate', 'terminology']);
    const record = collector.stages().find((row) => row.name === 'terminology');
    expect(record?.status).toBe('ok');
    expect(record?.detail).toBe('matches=1 tokens=3 capped=false version=s3');
    expect(record?.counts).toEqual({ matches: 1, tokens: 3, capped: 0, shared_version: 3, workspace_version: 0 });
    expect(out.terminology?.expansionTokens).toEqual(['term', 'alpha', 'beta']);
    expect(out.terminology?.version).toBe('s3');
    expectNoText(collector.stages(), ['termalpha', 'term alpha beta', 'what is']);
  });

  it('without the query layer it follows a translate stage that ran', async () => {
    installDictionary();
    const { collector } = await runQuery('what is termalpha', { env: { RAG_LEXICAL_TRANSLATION: 'true' } });
    expect(collector.stages().find((row) => row.name === 'translate')?.status).toBe('ok');
    const names = ranStageNames(collector.stages());
    expectStageOrder(names);
    expect(names.indexOf('translate')).toBeLessThan(names.indexOf('terminology'));
  });

  it('with the query layer on it runs after the transforms and before semantic_cache', async () => {
    installDictionary();
    installQueryLlm([]);
    const { collector } = await runQuery('what is termalpha', { env: { RAG_QUERY_LAYER: 'true', RAG_QUERY_TRANSLATE: 'false' }, profile: 'chat' });
    const names = ranStageNames(collector.stages());
    expectStageOrder(names);
    const recorded = collector.stages().map((row) => row.name);
    expect(recorded).toContain('semantic_cache');
    expect(recorded.indexOf('terminology')).toBeLessThan(recorded.indexOf('semantic_cache'));
    expect(collector.stages().find((row) => row.name === 'terminology')?.status).toBe('ok');
  });

  it('matches the standalone query only, never a caller-supplied variant', async () => {
    installDictionary();
    const { out, collector } = await runQuery('what is the first item', {
      queryVariants: [{ text: 'what is termalpha', language: 'en', kind: 'translated' }],
    });
    expect(collector.stages().find((row) => row.name === 'terminology')?.counts).toMatchObject({ matches: 0, tokens: 0 });
    expect(out.terminology?.expansionTokens).toEqual([]);
  });

  it('with the query layer, a condensed standalone that holds the variant matches while the original turn does not', async () => {
    installDictionary();
    const history: HistoryTurn[] = [
      { role: 'user', content: 'Describe the first placeholder item.' },
      { role: 'assistant', content: 'The first placeholder item is described in section one.' },
    ];
    const followUp = 'What about it?';
    installQueryLlm([{ transform: 'condense', query: followUp, output: { standalone: 'What about the termalpha item?', unchanged: false } }]);
    const { out, collector } = await runQuery(followUp, { env: { RAG_QUERY_LAYER: 'true', RAG_QUERY_TRANSLATE: 'false' }, history });
    expect(out.queryLayer?.plan?.standalone).toBe('What about the termalpha item?');
    expect(collector.stages().find((row) => row.name === 'terminology')?.counts).toMatchObject({ matches: 1 });
    expect(collector.stages().find((row) => row.name === 'condense')?.status).toBe('ok');
    expectStageOrder(ranStageNames(collector.stages()));
  });

  it('is disabled and loads nothing with the switch off', async () => {
    const rpc = installDictionary();
    const { out, collector } = await runQuery('what is termalpha', { env: { RAG_TERMINOLOGY: 'false' } });
    expect(collector.stages().find((row) => row.name === 'terminology')?.status).toBe('disabled');
    expect(rpc.calls).toHaveLength(0);
    expect(out.terminology).toBeNull();
  });

  it('a load failure records skipped, degrades the request and keeps the variants', async () => {
    installDictionary({ fail: true });
    const { out, collector } = await runQuery('what is termalpha');
    const record = collector.stages().find((row) => row.name === 'terminology');
    expect(record?.status).toBe('skipped');
    expect(record?.reason).toBe('failed');
    expect(out.terminology).toBeNull();
    expect(out.variants.length).toBeGreaterThan(0);
    expect(deriveStatus(collector.stages(), 1)).toBe('degraded');
    expectNoText(collector.stages(), ['termalpha', 'term alpha beta']);
  });

  it('the eval timeout override with a slow loader gives the same', async () => {
    installDictionary({ delayMs: 200 });
    const { out, collector } = await runQuery('what is termalpha', { stageOverrides: { timeouts: { terminology: 5 } } });
    const record = collector.stages().find((row) => row.name === 'terminology');
    expect(record?.status).toBe('skipped');
    expect(record?.reason).toBe('timeout');
    expect(out.terminology).toBeNull();
    expect(deriveStatus(collector.stages(), 1)).toBe('degraded');
  });
});

describe('the dictionary cache (D-22)', () => {
  beforeEach(() => {
    uninstallDeps();
    invalidateTerminologyCache('all');
  });

  afterEach(() => {
    invalidateTerminologyCache('all');
  });

  const rowsFor = (tenantKey: string) => [dbRow(entry(`canonical for ${tenantKey}`, ['termalpha']))];

  it('two tenant keys load twice and never share an entry', async () => {
    const rpc = termClient({ rows: rowsFor });
    const now = () => 1_000;
    const a = await loadEffectiveDictionary(orgScope(1), { client: rpc.client, now });
    const b = await loadEffectiveDictionary(orgScope(2), { client: rpc.client, now });
    expect(rpc.calls.map((call) => call.tenantKey)).toEqual([scopeKey(orgScope(1)), scopeKey(orgScope(2))]);
    expect(rpc.calls.every((call) => call.fn === 'rag_term_effective')).toBe(true);
    expect(a.tenantKey).not.toBe(b.tenantKey);
    expect(a.entries[0]?.canonical).toContain(scopeKey(orgScope(1)));
    expect(b.entries[0]?.canonical).toContain(scopeKey(orgScope(2)));
  });

  it('the same key within the TTL loads once and reloads after it', async () => {
    const rpc = termClient({ rows: rowsFor });
    let clock = 10_000;
    const now = () => clock;
    await loadEffectiveDictionary(orgScope(1), { client: rpc.client, now });
    clock += TERMINOLOGY_CACHE_TTL_MS - 1;
    await loadEffectiveDictionary(orgScope(1), { client: rpc.client, now });
    expect(rpc.calls).toHaveLength(1);
    clock += 1;
    await loadEffectiveDictionary(orgScope(1), { client: rpc.client, now });
    expect(rpc.calls).toHaveLength(2);
  });

  it('evicts the least recently used key beyond the limit', async () => {
    const rpc = termClient({ rows: rowsFor });
    const now = () => 5_000;
    for (let index = 0; index <= TERMINOLOGY_CACHE_MAX; index += 1) await loadEffectiveDictionary(orgScope(index), { client: rpc.client, now });
    expect(terminologyCacheSizeForTests()).toBe(TERMINOLOGY_CACHE_MAX);
    const before = rpc.calls.length;
    await loadEffectiveDictionary(orgScope(TERMINOLOGY_CACHE_MAX), { client: rpc.client, now });
    expect(rpc.calls).toHaveLength(before);
    await loadEffectiveDictionary(orgScope(0), { client: rpc.client, now });
    expect(rpc.calls).toHaveLength(before + 1);
  });

  it('invalidates one key or all keys', async () => {
    const rpc = termClient({ rows: rowsFor });
    const now = () => 7_000;
    await loadEffectiveDictionary(orgScope(1), { client: rpc.client, now });
    await loadEffectiveDictionary(orgScope(2), { client: rpc.client, now });
    invalidateTerminologyCache(scopeKey(orgScope(1)));
    expect(terminologyCacheSizeForTests()).toBe(1);
    await loadEffectiveDictionary(orgScope(2), { client: rpc.client, now });
    expect(rpc.calls).toHaveLength(2);
    invalidateTerminologyCache('all');
    expect(terminologyCacheSizeForTests()).toBe(0);
  });

  it('returns translation pairs and both versions; the version string names the workspace layer only when it has one', async () => {
    const pair = entry('term alpha beta', ['术语甲乙丙'], { kind: 'translation', language: 'zh', sourceLanguage: 'zh', targetLanguage: 'en' });
    const rpc = termClient({ rows: () => [dbRow(pair, { shared: 4, tenant: 2 })] });
    const loaded = await loadEffectiveDictionary(orgScope(9), { client: rpc.client, now: () => 1 });
    expect(loaded.entries.map((value) => value.kind)).toEqual(['translation']);
    expect(loaded.version).toBe('s4.w2');
    expect(loaded.sharedVersion).toBe(4);
    expect(loaded.workspaceVersion).toBe(2);
  });
});
