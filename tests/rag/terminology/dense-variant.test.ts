import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm, type FakeQueryLlmEntry } from '../../../eval/harness/fake-query-llm.mts';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { setRagDepsForTests } from '@/lib/rag/deps';
import type { QueryLlm, QueryLlmRequest } from '@/lib/rag/query/llm';
import { invalidateTerminologyCache } from '@/lib/rag/terminology/load';
import type { TermEntry } from '@/lib/rag/terminology/matcher';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { HistoryTurn, Profile, QueryVariant, StageOverrides } from '@/lib/rag/types';
import { resetV2StartupForTests } from '@/lib/rag/v2/startup';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { normalizeLexical } from '@/lib/rag/lexical/tokenize';
import { uninstallDeps } from '../helpers/pipeline-fakes';

/** D-37 placeholders; D-36: pipeline and switches set explicitly. */
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


const QUERY = 'what is termalpha';
const SUBSTITUTED = 'what is term alpha beta';
const DENSE = { RAG_TERMINOLOGY_DENSE: 'true' };
const LAYER = { RAG_QUERY_LAYER: 'true', RAG_QUERY_TRANSLATE: 'false' };

function terminologyRecord(collector: ReturnType<typeof createTraceCollector>) {
  return collector.stages().find((row) => row.name === 'terminology');
}

function queryParams(params: Record<string, number>): StageOverrides {
  return { queryLayer: { queryParams: params } } as StageOverrides;
}

describe('the dense terminology variant in the query stages (D-18, D-19, D-31)', () => {
  const dictionary = [entry('term alpha beta', ['termalpha'])];

  beforeEach(() => {
    uninstallDeps();
    invalidateTerminologyCache('all');
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rpc = termClient({ rows: () => dictionary.map((value) => dbRow(value, { shared: 2, tenant: 0 })) });
    setRagDepsForTests({ adminClient: () => rpc.client as never, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    installQueryLlm([]);
  });

  afterEach(() => {
    uninstallDeps();
    invalidateTerminologyCache('all');
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('without the layer: [original, terminology], dense-only, counts without a cut', async () => {
    const { out, collector } = await runQuery(QUERY, { env: DENSE });
    expect(out.variants.map((row) => row.kind)).toEqual(['original', 'terminology']);
    expect(out.variants[1]).toMatchObject({ text: SUBSTITUTED, legs: 'dense' });
    expect(terminologyRecord(collector)?.counts).toMatchObject({ matches: 1, search_cut: 0, variant_cut: 0 });
    expect(terminologyRecord(collector)?.detail).not.toContain('cut=cap');
    expect(out.terminology?.termSearch).toBe(true);
  });

  it('dense switch off: no terminology variant, the matches are still in the output', async () => {
    const { out, collector } = await runQuery(QUERY);
    expect(out.variants.map((row) => row.kind)).toEqual(['original']);
    expect(out.terminology?.matches).toHaveLength(1);
    expect(out.terminology?.version).toBe('s2');
    expect(terminologyRecord(collector)?.counts).toMatchObject({ search_cut: 0, variant_cut: 0 });
  });

  it('voice never gets the terminology variant and still runs the term:0 expansion', async () => {
    const { out } = await runQuery(QUERY, { env: DENSE, profile: 'voice' });
    expect(out.variants.some((row) => row.kind === 'terminology')).toBe(false);
    expect(out.terminology?.termSearch).toBe(true);
    expect(out.terminology?.expansionTokens.length).toBeGreaterThan(0);
  });

  it('no variant when nothing matched', async () => {
    const { out, collector } = await runQuery('what is the first item', { env: DENSE });
    expect(out.variants.map((row) => row.kind)).toEqual(['original']);
    expect(terminologyRecord(collector)?.counts).toMatchObject({ matches: 0, variant_cut: 0 });
  });

  it('with the layer: the protected variants alone fill max_searches, so term:0 is not searched and the variant is cut', async () => {
    const maxSearches = 1;
    const { out, collector } = await runQuery(QUERY, { env: { ...DENSE, ...LAYER }, stageOverrides: queryParams({ max_searches: maxSearches }) });
    expect(out.variants.map((row) => row.kind)).toEqual(['original']);
    expect(out.variants).toHaveLength(maxSearches);
    expect(out.terminology?.termSearch).toBe(false);
    expect(out.terminology?.matches).toHaveLength(1);
    expect(terminologyRecord(collector)?.counts).toMatchObject({ search_cut: 1, variant_cut: 1 });
    expect(terminologyRecord(collector)?.detail).toMatch(/ cut=cap$/);
  });

  it('with the layer: term:0 takes one search and the variant fits within max_searches − 1', async () => {
    const maxSearches = 3;
    const { out, collector } = await runQuery(QUERY, { env: { ...DENSE, ...LAYER }, stageOverrides: queryParams({ max_searches: maxSearches }) });
    expect(out.variants.map((row) => row.kind)).toEqual(['original', 'terminology']);
    expect(out.variants.length).toBeLessThanOrEqual(maxSearches - 1);
    expect(out.terminology?.termSearch).toBe(true);
    expect(terminologyRecord(collector)?.counts).toMatchObject({ search_cut: 0, variant_cut: 0 });
  });

  it('with the layer: term:0 searched and max_searches 2 leaves no place for the variant', async () => {
    const { out, collector } = await runQuery(QUERY, { env: { ...DENSE, ...LAYER }, stageOverrides: queryParams({ max_searches: 2 }) });
    expect(out.variants.map((row) => row.kind)).toEqual(['original']);
    expect(out.terminology?.termSearch).toBe(true);
    expect(terminologyRecord(collector)?.counts).toMatchObject({ search_cut: 0, variant_cut: 1 });
  });

  it('with the layer: the variant counts toward max_llm_variants', async () => {
    const { out, collector } = await runQuery(QUERY, { env: { ...DENSE, ...LAYER }, stageOverrides: queryParams({ max_llm_variants: 0 }) });
    expect(out.variants.some((row) => row.kind === 'terminology')).toBe(false);
    expect(terminologyRecord(collector)?.counts).toMatchObject({ variant_cut: 1 });
  });

  it('with the layer: the variant is never written into the query plan', async () => {
    const { out } = await runQuery(QUERY, { env: { ...DENSE, ...LAYER } });
    expect(out.variants.some((row) => row.kind === 'terminology')).toBe(true);
    expect(JSON.stringify(out.queryLayer?.plan ?? {})).not.toContain('terminology');
    expect(JSON.stringify(out.queryLayer?.plan ?? {})).not.toContain(SUBSTITUTED);
  });

  it('the stage detail and counts carry no query, variant or canonical text', async () => {
    const { collector } = await runQuery(QUERY, { env: { ...DENSE, ...LAYER }, stageOverrides: queryParams({ max_searches: 1 }) });
    const record = JSON.stringify(terminologyRecord(collector));
    for (const text of [QUERY, SUBSTITUTED, 'termalpha', 'term alpha beta']) expect(record).not.toContain(text);
  });
});
