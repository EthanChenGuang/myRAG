import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import type { QueryEmbedding } from '@/lib/rag/embeddings/query-embedding';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import type { QueryVariant } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { createRetrievalPort, type RetrievalPortContext } from '@/lib/rag/v2/port';
import { hit } from '../fusion/helpers';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { deriveStatus, StageError } from '@/lib/rag/pipeline';
import type { RetrievalPort, SearchDelegate } from '@/lib/rag/query/port-types';
import { createTraceCollector, type TraceCollector } from '@/lib/rag/trace/collector';
import { delegatedFusion, runSearchStages } from '@/lib/rag/v2/stages/search';
import { rankedList } from '../fusion/helpers';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const TENANT_A = mintScope('personal', '00000000-0000-4000-8000-00000000000a', null);
const TENANT_B = mintScope('personal', '00000000-0000-4000-8000-00000000000b', null);

const VARIANTS: QueryVariant[] = [
  { text: 'Synthetic original question about the sample widget', language: 'en', kind: 'original' },
  { text: 'Synthetic condensed question about the sample widget', language: 'en', kind: 'condensed', legs: 'both' },
  {
    text: 'A synthetic passage describing the sample widget.',
    language: 'en',
    kind: 'hyde',
    legs: 'dense',
    denseText: 'A synthetic passage describing the sample widget, dense form.',
  },
];

function params() {
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' });
  return effectiveRetrievalParams('eval', config, null);
}

function vectorFor(index: number): number[] {
  return Array.from({ length: 4 }, (_unused, position) => (position === index ? 1 : 0));
}

function variantIndexOf(req: BackendSearchRequest): number {
  return req.denseVector?.indexOf(1) ?? -1;
}

interface Recorder {
  calls: BackendSearchRequest[];
  scopes: string[];
  events: string[];
}

function recorder(): Recorder {
  return { calls: [], scopes: [], events: [] };
}

function fakeBackend(rec: Recorder, prefix = ''): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req) {
      rec.calls.push(req);
      rec.scopes.push(scopeKey(req.scope));
      rec.events.push('search');
      await new Promise((resolve) => setTimeout(resolve, 1));
      const index = variantIndexOf(req);
      return {
        dense: [hit(`${prefix}d${index}-a`, { rank: 1 }), hit(`${prefix}shared`, { rank: 2 })],
        lexical: req.lexicalTokens.length > 0 ? [hit(`${prefix}shared`, { rank: 1 }), hit(`${prefix}l${index}-a`, { rank: 2 })] : [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function fakeEmbedder(rec: Recorder) {
  return vi.fn(async (texts: string[]): Promise<QueryEmbedding[]> => {
    rec.events.push(`embed:${texts.length}`);
    return texts.map((_text, index) => ({ vector: vectorFor(index), profile: null }));
  });
}

function makePort(rec: Recorder, overrides: Partial<RetrievalPortContext> = {}) {
  const embed = fakeEmbedder(rec);
  const handle = createRetrievalPort({
    scope: TENANT_A,
    backend: fakeBackend(rec),
    variants: VARIANTS,
    filters: { currentOnly: true },
    params: params(),
    signal: new AbortController().signal,
    embed,
    lexicalEnabled: true,
    ...overrides,
  });
  return { handle, embed };
}

describe('createRetrievalPort (D-18, A-4)', () => {
  beforeEach(() => resetRagConfigForTests());
  afterEach(() => {
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('exposes the variant texts, kinds and legs in order', () => {
    const { handle } = makePort(recorder());
    expect(handle.port.variants).toEqual([
      { index: 0, text: VARIANTS[0]!.text, kind: 'original', legs: 'both' },
      { index: 1, text: VARIANTS[1]!.text, kind: 'condensed', legs: 'both' },
      { index: 2, text: VARIANTS[2]!.text, kind: 'hyde', legs: 'dense' },
    ]);
  });

  it('makes one backend call for a variant that the dense and lexical retrievers both ask for', async () => {
    const rec = recorder();
    const { handle } = makePort(rec);
    const [first, second] = await Promise.all([handle.port.searchVariant(0), handle.port.searchVariant(0)]);
    const third = await handle.port.searchVariant(0);
    expect(rec.calls).toHaveLength(1);
    expect(first).toEqual({ dense: ['d0-a', 'shared'], lexical: ['shared', 'l0-a'] });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('makes one call per variant, all under the request signal, and sends no lexical tokens for a dense-only variant', async () => {
    const rec = recorder();
    const controller = new AbortController();
    const { handle } = makePort(rec, { signal: controller.signal });
    const lists = await Promise.all([0, 1, 2, 0, 1, 2].map((index) => handle.port.searchVariant(index)));
    expect(rec.calls).toHaveLength(3);
    expect(rec.calls.every((call) => call.signal === controller.signal)).toBe(true);
    expect(lists[2]).toEqual({ dense: ['d2-a', 'shared'], lexical: [] });
    const hyde = rec.calls.find((call) => variantIndexOf(call) === 2)!;
    expect(hyde.lexicalTokens).toEqual([]);
  });

  it('embeds every variant dense text in one batch before the first search', async () => {
    const rec = recorder();
    const { handle, embed } = makePort(rec);
    await handle.port.searchVariant(1);
    await handle.port.searchVariant(0);
    await handle.port.searchVariant(2);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]?.[0]).toEqual([VARIANTS[0]!.text, VARIANTS[1]!.text, VARIANTS[2]!.denseText]);
    expect(rec.events[0]).toBe('embed:3');
    expect(rec.events.filter((event) => event === 'search')).toHaveLength(3);
  });

  it('exposes no scope, tenant key, filters or backend', () => {
    const rec = recorder();
    const { handle } = makePort(rec, { filters: { currentOnly: true, sources: ['synthetic-source'] } });
    const port = handle.port;
    expect(Object.keys(port).sort()).toEqual(['finishRetrieval', 'searchVariant', 'variants']);
    const json = JSON.stringify(port);
    expect(json).not.toContain(scopeKey(TENANT_A).slice(2));
    expect(json).not.toContain('synthetic-source');
    expect(json).not.toContain('pgvector');
    expect(json).not.toMatch(/scope|tenant|filter|backend|signal/i);
    for (const value of Object.values(port)) {
      expect(value).not.toBe(TENANT_A);
    }
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.isFrozen(port.variants)).toBe(true);
  });

  it('rejects with an abort error and makes no call after the request signal aborts', async () => {
    const rec = recorder();
    const controller = new AbortController();
    const { handle, embed } = makePort(rec, { signal: controller.signal });
    controller.abort();
    await expect(handle.port.searchVariant(0)).rejects.toMatchObject({ name: 'AbortError' });
    expect(rec.calls).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('rejects an abort after a variant was searched instead of returning the memo', async () => {
    const rec = recorder();
    const controller = new AbortController();
    const { handle } = makePort(rec, { signal: controller.signal });
    await handle.port.searchVariant(0);
    controller.abort();
    await expect(handle.port.searchVariant(0)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(handle.port.searchVariant(1)).rejects.toMatchObject({ name: 'AbortError' });
    expect(rec.calls).toHaveLength(1);
  });

  it('rejects an index that names no variant without calling the backend', async () => {
    const rec = recorder();
    const { handle } = makePort(rec);
    await expect(handle.port.searchVariant(3)).rejects.toThrow(RangeError);
    await expect(handle.port.searchVariant(-1)).rejects.toThrow(RangeError);
    await expect(handle.port.searchVariant(0.5)).rejects.toThrow(RangeError);
    expect(rec.calls).toHaveLength(0);
  });

  it('keeps two tenants apart: each port reaches the backend only with its own scope, interleaved calls included', async () => {
    const rec = recorder();
    const backend = fakeBackend(rec);
    const make = (scope: TenantScope) =>
      createRetrievalPort({
        scope,
        backend,
        variants: VARIANTS,
        filters: { currentOnly: true },
        params: params(),
        signal: new AbortController().signal,
        embed: fakeEmbedder(recorder()),
        lexicalEnabled: true,
      });
    const a = make(TENANT_A);
    const b = make(TENANT_B);
    const order: Array<['a' | 'b', number]> = [
      ['a', 0],
      ['b', 0],
      ['b', 1],
      ['a', 1],
      ['a', 2],
      ['b', 2],
    ];
    await Promise.all(order.map(([who, index]) => (who === 'a' ? a : b).port.searchVariant(index)));
    expect(rec.calls).toHaveLength(6);
    const keyA = scopeKey(TENANT_A);
    const keyB = scopeKey(TENANT_B);
    expect(rec.scopes.filter((key) => key === keyA)).toHaveLength(3);
    expect(rec.scopes.filter((key) => key === keyB)).toHaveLength(3);
    expect(rec.calls.filter((call) => call.scope === TENANT_A)).toHaveLength(3);
    expect(rec.calls.filter((call) => call.scope === TENANT_B)).toHaveLength(3);
    expect(rec.calls.every((call) => call.scope === TENANT_A || call.scope === TENANT_B)).toBe(true);
  });

  it('finishRetrieval maps a fused order back to the collected hits with their legs and drops unknown ids', async () => {
    const rec = recorder();
    const backend: RetrievalBackend = {
      ...fakeBackend(rec),
      async search(req) {
        rec.calls.push(req);
        return {
          dense: [hit('c1', { rank: 1 }), hit('c2', { rank: 2 })],
          lexical: [hit('c3', { rank: 1 }), hit('c1', { rank: 2 })],
        };
      },
    };
    const { handle } = makePort(rec, { backend });
    await handle.port.searchVariant(0);
    expect(handle.port.finishRetrieval(['c3', 'unknown', 'c1', 'c3'])).toEqual([
      { chunkId: 'c3', legs: { 'lexical:0': 1 } },
      { chunkId: 'c1', legs: { 'dense:0': 1, 'lexical:0': 2 } },
    ]);
    const fused = handle.fusedHits(['c3', 'c1']);
    expect(fused.map((row) => row.hit.chunkId)).toEqual(['c3', 'c1']);
    expect(fused[1]!.ranks).toEqual({ 'dense:0': 1, 'lexical:0': 2 });
  });
});

/** Tie-free under RRF k=60 with equal weights: every chunk's score is distinct (asserted below). */
const TIE_FREE: Record<number, { dense: string[]; lexical: string[] }> = {
  0: { dense: ['ca', 'cb', 'cc', 'cd'], lexical: ['ce', 'ca'] },
  1: { dense: ['cb'], lexical: ['ca', 'cc'] },
  2: { dense: ['cc', 'ch', 'ci'], lexical: [] },
};

function tieFreeBackend(rec: Recorder): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req) {
      rec.calls.push(req);
      rec.scopes.push(scopeKey(req.scope));
      await new Promise((resolve) => setTimeout(resolve, 1));
      const lists = TIE_FREE[variantIndexOf(req)]!;
      const ranked = (ids: string[]) => ids.map((id, index) => hit(id, { rank: index + 1, similarity: 0.9 - index / 10 }));
      return {
        dense: ranked(lists.dense),
        lexical: req.lexicalTokens.length > 0 ? ranked(lists.lexical) : [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

/** A pure TypeScript stand-in for a framework ensemble: one retriever per variant and leg, RRF with equal weights. */
function rrfDelegate(k: number, calls: { count: number }): SearchDelegate {
  return async (port: RetrievalPort) => {
    calls.count += 1;
    const retrievers = port.variants.flatMap((variant) => [
      async () => (await port.searchVariant(variant.index)).dense,
      async () => (await port.searchVariant(variant.index)).lexical,
    ]);
    const lists = await Promise.all(retrievers.map((retriever) => retriever()));
    const scores = new Map<string, number>();
    for (const ids of lists) {
      ids.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
    }
    return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };
}

async function runSearch(rec: Recorder, options: { searchDelegate?: SearchDelegate; collector?: TraceCollector; icu?: boolean } = {}) {
  setRetrievalBackendForTests(tieFreeBackend(rec));
  installDeps({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
  await verifyV2Startup(options.icu === false ? { icuSegmentsChinese: () => false } : undefined);
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' });
  const signal = new AbortController().signal;
  return runSearchStages({
    input: { scope: TENANT_A, query: VARIANTS[0]!.text, profile: 'eval', signal },
    scope: TENANT_A,
    config,
    profile: 'eval',
    params: effectiveRetrievalParams('eval', config, null),
    embedding: { vector: vectorFor(0), profile: null },
    variantEmbeddings: VARIANTS.map((_variant, index) => ({ vector: vectorFor(index), profile: null })),
    variants: VARIANTS,
    signal,
    collector: options.collector ?? createTraceCollector({ profile: 'eval', tenantKey: scopeKey(TENANT_A) }),
    trackStandalone: true,
    ...(options.searchDelegate ? { searchDelegate: options.searchDelegate } : {}),
  });
}

describe('runSearchStages with a search delegate (D-02, D-18, A-4)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('a delegate applying RRF over the port lists gives the native order and the same capped candidates', async () => {
    const native = await runSearch(recorder());
    const scores = native.fusedHits.map((row) => row.score);
    expect(new Set(scores).size).toBe(scores.length);

    const rec = recorder();
    const calls = { count: 0 };
    const delegated = await runSearch(rec, { searchDelegate: rrfDelegate(params().rrf_k, calls) });
    expect(calls.count).toBe(1);
    expect(rec.calls).toHaveLength(3);
    expect(rec.scopes.every((key) => key === scopeKey(TENANT_A))).toBe(true);
    expect(delegated.fusedHits.map((row) => row.hit.chunkId)).toEqual(native.fusedHits.map((row) => row.hit.chunkId));
    expect(delegated).toEqual(native);
  });

  it('follows the delegate order and drops ids the port never collected', async () => {
    const delegate: SearchDelegate = async (port) => {
      await port.searchVariant(0);
      return ['cd', 'unknown', 'ca', 'ce'];
    };
    const rec = recorder();
    const out = await runSearch(rec, { searchDelegate: delegate });
    expect(out.fusedHits.map((row) => row.hit.chunkId)).toEqual(['cd', 'ca', 'ce']);
    expect(out.fusedHits[1]!.ranks).toEqual({ 'dense:0': 1, 'lexical:0': 2 });
    expect(rec.calls).toHaveLength(1);
  });

  it('a delegate that throws fails the search stage with search_delegate_error and an error status, never empty', async () => {
    const collector = createTraceCollector({ profile: 'eval', tenantKey: scopeKey(TENANT_A) });
    const delegate: SearchDelegate = async () => {
      throw new Error('synthetic delegate failure');
    };
    await expect(runSearch(recorder(), { searchDelegate: delegate, collector })).rejects.toBeInstanceOf(StageError);
    const search = collector.stages().find((record) => record.name === 'search');
    expect(search).toMatchObject({ status: 'error', reason: 'failed', detail: 'search_delegate_error' });
    expect(deriveStatus(collector.stages(), 0)).toBe('error');
  });

  it('a delegate that returns something other than a list of ids fails the same way', async () => {
    const collector = createTraceCollector({ profile: 'eval', tenantKey: scopeKey(TENANT_A) });
    const delegate = (async () => ({ ids: ['ca'] })) as unknown as SearchDelegate;
    await expect(runSearch(recorder(), { searchDelegate: delegate, collector })).rejects.toMatchObject({ stage: 'search', reason: 'failed' });
    expect(collector.stages().find((record) => record.name === 'search')).toMatchObject({ status: 'error', detail: 'search_delegate_error' });
  });

  it('with ICU unavailable a throwing delegate still fails the search stage with search_delegate_error', async () => {
    const collector = createTraceCollector({ profile: 'eval', tenantKey: scopeKey(TENANT_A) });
    const delegate: SearchDelegate = async () => {
      throw new Error('synthetic delegate failure');
    };
    await expect(runSearch(recorder(), { searchDelegate: delegate, collector, icu: false })).rejects.toBeInstanceOf(StageError);
    expect(collector.stages().find((record) => record.name === 'search')).toMatchObject({ status: 'error', detail: 'search_delegate_error' });
    expect(deriveStatus(collector.stages(), 0)).toBe('error');
  });
});

describe('delegatedFusion with legs the delegate cannot see', () => {
  afterEach(() => {
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('returns the delegate order unchanged when there are no extra lists', async () => {
    const { handle } = makePort(recorder());
    await handle.port.searchVariant(0);
    expect(delegatedFusion({ handle, order: ['shared', 'd0-a'] }, [], 60).map((row) => row.hit.chunkId)).toEqual(['shared', 'd0-a']);
  });

  it('fuses an exact-id list with the delegate order and keeps the collected leg ranks', async () => {
    const { handle } = makePort(recorder());
    await handle.port.searchVariant(0);
    const exact = rankedList('exact_id', ['l0-a', 'only-exact']);
    const fused = delegatedFusion({ handle, order: ['d0-a', 'shared', 'l0-a'] }, [exact], 60);
    expect(fused.map((row) => row.hit.chunkId)).toEqual(['l0-a', 'd0-a', 'only-exact', 'shared']);
    const byId = new Map(fused.map((row) => [row.hit.chunkId, row]));
    expect(byId.get('l0-a')!.ranks).toEqual({ 'lexical:0': 2, exact_id: 1 });
    expect(byId.get('only-exact')!.ranks).toEqual({ exact_id: 2 });
    expect(byId.get('shared')!.ranks).toEqual({ 'dense:0': 2, 'lexical:0': 1 });
    expect(fused.every((row) => !('delegate' in row.ranks))).toBe(true);
  });
});

describe('a search delegate under abort', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('reports an abort during the delegate as aborted, not as a delegate error', async () => {
    const rec = recorder();
    setRetrievalBackendForTests(tieFreeBackend(rec));
    installDeps({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    await verifyV2Startup();
    resetRagConfigForTests();
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' });
    const controller = new AbortController();
    const collector = createTraceCollector({ profile: 'eval', tenantKey: scopeKey(TENANT_A) });
    const delegate: SearchDelegate = async (port) => {
      await port.searchVariant(0);
      controller.abort();
      return [...(await port.searchVariant(1)).dense];
    };
    await expect(
      runSearchStages({
        input: { scope: TENANT_A, query: VARIANTS[0]!.text, profile: 'eval', signal: controller.signal },
        scope: TENANT_A,
        config,
        profile: 'eval',
        params: effectiveRetrievalParams('eval', config, null),
        embedding: { vector: vectorFor(0), profile: null },
        variantEmbeddings: VARIANTS.map((_variant, index) => ({ vector: vectorFor(index), profile: null })),
        variants: VARIANTS,
        signal: controller.signal,
        collector,
        searchDelegate: delegate,
      }),
    ).rejects.toMatchObject({ reason: 'aborted' });
    const search = collector.stages().find((record) => record.name === 'search');
    expect(search?.status).toBe('aborted');
    expect(search?.detail).toBeUndefined();
    expect(rec.calls).toHaveLength(1);
  });
});
