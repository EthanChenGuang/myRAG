import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { rrf } from '@/lib/rag/fusion/rrf';
import { createLangChainSearchDelegate } from '@/lib/rag/query/langchain/ensemble';
import type { RetrievalPort, RetrievalPortVariant, SearchDelegateContext } from '@/lib/rag/query/port-types';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryVariant } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

type Lists = { dense: string[]; lexical: string[] };

const PORT_VARIANTS: RetrievalPortVariant[] = [
  { index: 0, text: 'Synthetic original question about the sample widget', kind: 'original', legs: 'both' },
  { index: 1, text: 'Synthetic condensed question about the sample widget', kind: 'condensed', legs: 'both' },
  { index: 2, text: 'A synthetic passage describing the sample widget.', kind: 'hyde', legs: 'dense' },
];

/** Tie-free under k=60 with equal weights (asserted); the hyde variant's lexical id must never surface. */
const LISTS: Record<number, Lists> = {
  0: { dense: ['ca', 'cb', 'cc', 'cd'], lexical: ['ce', 'ca'] },
  1: { dense: ['cb'], lexical: ['ca', 'cc'] },
  2: { dense: ['cc', 'ch', 'ci'], lexical: ['only-hyde-lexical'] },
};

function stubPort(lists: Record<number, Lists>, options: { delayMs?: number } = {}) {
  const calls = new Map<number, number>();
  const known = new Set(Object.values(lists).flatMap((legs) => [...legs.dense, ...legs.lexical]));
  const port: RetrievalPort = {
    variants: PORT_VARIANTS,
    async searchVariant(index) {
      calls.set(index, (calls.get(index) ?? 0) + 1);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      return lists[index]!;
    },
    finishRetrieval(ids) {
      const seen = new Set<string>();
      return ids.filter((id) => known.has(id) && !seen.has(id) && seen.add(id)).map((chunkId) => ({ chunkId, legs: {} }));
    },
  };
  return { port, calls };
}

function context(over: Partial<SearchDelegateContext> = {}): SearchDelegateContext {
  return { signal: new AbortController().signal, rrfK: 60, legWeights: { dense: 1, lexical: 1 }, ...over };
}

/** The native fusion over the same lists the delegate sees: one RRF over every (variant, leg) list. */
function nativeOrder(lists: Record<number, Lists>, ctx: SearchDelegateContext): { ids: string[]; scores: number[] } {
  const ranked = PORT_VARIANTS.flatMap((variant) => {
    const legs = lists[variant.index]!;
    const toHits = (ids: string[]) => ids.map((id, index) => hit(id, { rank: index + 1 }));
    return [
      { id: `dense:${variant.index}`, weight: ctx.legWeights.dense, hits: toHits(legs.dense) },
      ...(variant.legs === 'dense' ? [] : [{ id: `lexical:${variant.index}`, weight: ctx.legWeights.lexical, hits: toHits(legs.lexical) }]),
    ];
  });
  const fused = rrf(ranked, ctx.rrfK);
  return { ids: fused.map((row) => row.hit.chunkId), scores: fused.map((row) => row.score) };
}

describe('createLangChainSearchDelegate (D-17, D-18, F-2, A-4)', () => {
  it('on a tie-free fixture the EnsembleRetriever order equals the native RRF order', async () => {
    const ctx = context();
    const native = nativeOrder(LISTS, ctx);
    expect(new Set(native.scores).size).toBe(native.scores.length);
    const { port } = stubPort(LISTS);
    expect(await createLangChainSearchDelegate()(port, ctx)).toEqual(native.ids);
  });

  it('uses the leg weights and c from the context', async () => {
    const ctx = context({ rrfK: 5, legWeights: { dense: 1, lexical: 0 } });
    const { port } = stubPort(LISTS);
    const order = await createLangChainSearchDelegate()(port, ctx);
    expect(order).toEqual(nativeOrder(LISTS, ctx).ids);
    expect(order).not.toContain('ce');

    const lexicalHeavy = context({ rrfK: 1, legWeights: { dense: 0.2, lexical: 3 } });
    expect(await createLangChainSearchDelegate()(stubPort(LISTS).port, lexicalHeavy)).toEqual(nativeOrder(LISTS, lexicalHeavy).ids);
  });

  it('keeps two different chunks with identical text: documents are keyed by chunk id', async () => {
    const lists: Record<number, Lists> = {
      0: { dense: ['dup-1', 'other'], lexical: ['dup-2'] },
      1: { dense: ['dup-2'], lexical: [] },
      2: { dense: [], lexical: [] },
    };
    const order = await createLangChainSearchDelegate()(stubPort(lists).port, context());
    expect(order).toEqual(expect.arrayContaining(['dup-1', 'dup-2', 'other']));
    expect(order).toHaveLength(3);
  });

  it('costs one port search per variant and gives a hyde variant only a dense retriever', async () => {
    const { port, calls } = stubPort(LISTS);
    const order = await createLangChainSearchDelegate()(port, context());
    expect([...calls.entries()].sort()).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
    ]);
    expect(order).not.toContain('only-hyde-lexical');
  });

  it('maps the fused order through port.finishRetrieval', async () => {
    const { port } = stubPort(LISTS);
    const finish = vi.spyOn(port, 'finishRetrieval');
    const order = await createLangChainSearchDelegate()(port, context());
    expect(finish).toHaveBeenCalledTimes(1);
    expect(order).toEqual(finish.mock.results[0]!.value.map((h: { chunkId: string }) => h.chunkId));
  });

  it('passes the request signal through the leg retrievers: an abort rejects the delegate', async () => {
    const controller = new AbortController();
    const { port } = stubPort(LISTS, { delayMs: 30 });
    const pending = createLangChainSearchDelegate()(port, context({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const aborted = new AbortController();
    aborted.abort();
    const idle = stubPort(LISTS);
    await expect(createLangChainSearchDelegate()(idle.port, context({ signal: aborted.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(idle.calls.size).toBe(0);
  });
});

describe('the delegate inside the search stage', () => {
  const TENANT = mintScope('personal', '00000000-0000-4000-8000-00000000000a', null);
  const VARIANTS: QueryVariant[] = PORT_VARIANTS.map((variant) => ({
    text: variant.text,
    language: 'en',
    kind: variant.kind as QueryVariant['kind'],
    ...(variant.index === 0 ? {} : { legs: variant.legs }),
  }));
  const vectorFor = (index: number) => Array.from({ length: 4 }, (_unused, position) => (position === index ? 1 : 0));

  function backend(calls: { count: number }): RetrievalBackend {
    return {
      id: 'pgvector',
      async search(req) {
        calls.count += 1;
        const lists = LISTS[req.denseVector?.indexOf(1) ?? -1]!;
        const ranked = (ids: string[]) => ids.map((id, index) => hit(id, { rank: index + 1, similarity: 0.9 - index / 10 }));
        return { dense: ranked(lists.dense), lexical: req.lexicalTokens.length > 0 ? ranked(lists.lexical) : [] } satisfies BackendLegs;
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    };
  }

  async function search(withDelegate: boolean) {
    const calls = { count: 0 };
    setRetrievalBackendForTests(backend(calls));
    installDeps({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    await verifyV2Startup();
    resetRagConfigForTests();
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' });
    const signal = new AbortController().signal;
    const out = await runSearchStages({
      input: { scope: TENANT, query: VARIANTS[0]!.text, profile: 'eval', signal },
      scope: TENANT,
      config,
      profile: 'eval',
      params: effectiveRetrievalParams('eval', config, null),
      embedding: { vector: vectorFor(0), profile: null },
      variantEmbeddings: VARIANTS.map((_variant, index) => ({ vector: vectorFor(index), profile: null })),
      variants: VARIANTS,
      signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: scopeKey(TENANT) }),
      trackStandalone: true,
      ...(withDelegate ? { searchDelegate: createLangChainSearchDelegate() } : {}),
    });
    return { out, calls };
  }

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

  it('fuses the same lists as native RRF and makes one backend search per variant', async () => {
    const native = await search(false);
    const langchain = await search(true);
    expect(langchain.calls.count).toBe(VARIANTS.length);
    expect(langchain.out.fusedHits.map((row) => row.hit.chunkId)).toEqual(native.out.fusedHits.map((row) => row.hit.chunkId));
  });
});

describe('framework selection and the dynamic import (D-17, D-22, P-7)', () => {
  const COMPARISON_ZH = 'A 和 B 有什么区别？';
  const SUB_QUESTIONS = ['A 是什么？', 'B 是什么？'];
  const loads = { count: 0 };

  beforeEach(() => {
    loads.count = 0;
    vi.resetModules();
    vi.doMock('@/lib/rag/query/langchain', async (importOriginal) => {
      loads.count += 1;
      return importOriginal();
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.doUnmock('@/lib/rag/query/langchain');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function runLayer(profile: 'chat' | 'voice', framework: string) {
    const { loadRagConfig: load, resetRagConfigForTests: reset } = await import('@/lib/rag/config');
    const { setRagDepsForTests } = await import('@/lib/rag/deps');
    const { runQueryLayer } = await import('@/lib/rag/query/run-layer');
    const { setLangChainChatModelFactoryForTests } = await import('@/lib/rag/query/transformer');
    const { createFakeLangChainChatModel } = await import('@/lib/rag/query/langchain/fake');
    const { createFakeQueryLlm } = await import('../../../eval/harness/fake-query-llm.mts');
    const { createTraceCollector: collectorFor } = await import('@/lib/rag/trace/collector');
    const entries = [{ transform: 'decompose' as const, query: COMPARISON_ZH, output: { questions: SUB_QUESTIONS } }];
    const nativeFake = createFakeQueryLlm({ table: { version: 1, entries } });
    setRagDepsForTests({ queryLlm: () => nativeFake, now: () => Date.parse('2026-06-15T12:00:00Z') });
    setLangChainChatModelFactoryForTests(() => createFakeLangChainChatModel({ table: { version: 1, entries } }));
    reset();
    const env = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', RAG_QUERY_FRAMEWORK: framework };
    const collector = collectorFor({ profile, tenantKey: 's:default' });
    const signal = new AbortController().signal;
    const scope = mintScope('single', null, null);
    const out = await runQueryLayer({ input: { scope, query: COMPARISON_ZH, profile, signal }, config: load(env), profile, signal, collector });
    setLangChainChatModelFactoryForTests(null);
    return { out, stages: collector.stages() };
  }

  it('with the default framework, importing transformer.ts and resolving the framework never loads ./langchain', async () => {
    const transformer = await import('@/lib/rag/query/transformer');
    const runtime = await transformer.loadQueryFramework('llamaindex', { model: 'openai/gpt-4.1-nano' });
    expect(runtime).toMatchObject({ searchDelegate: null, importMs: null });
    expect(runtime.transformer.framework).toBe('llamaindex');
    expect(loads.count).toBe(0);
  });

  it('the langchain framework loads the adapter once and returns its transformer and the ensemble delegate', async () => {
    const transformer = await import('@/lib/rag/query/transformer');
    const first = await transformer.loadQueryFramework('langchain', { model: 'openai/gpt-4.1-nano' });
    const second = await transformer.loadQueryFramework('langchain', { model: 'openai/gpt-4.1-nano' });
    expect(first.transformer.framework).toBe('langchain');
    expect(typeof first.searchDelegate).toBe('function');
    expect(first.importMs).toBeGreaterThanOrEqual(0);
    expect(second.importMs).toBe(first.importMs);
    expect(loads.count).toBe(1);
  });

  it('chat with RAG_QUERY_FRAMEWORK=langchain runs the LangChain transforms and hands the search delegate on', async () => {
    const { out, stages } = await runLayer('chat', 'langchain');
    expect(out.plan?.framework).toBe('langchain');
    expect(out.plan?.sub_questions).toEqual(SUB_QUESTIONS);
    expect(typeof out.searchDelegate).toBe('function');
    expect(stages.find((row) => row.name === 'framework_import')).toMatchObject({ status: 'ok', detail: 'langchain' });
    expect(loads.count).toBe(1);
  });

  it('voice stays native under RAG_QUERY_FRAMEWORK=langchain and never imports the adapter', async () => {
    const { out, stages } = await runLayer('voice', 'langchain');
    expect(out.plan?.framework ?? 'llamaindex').toBe('llamaindex');
    expect(out.searchDelegate).toBeUndefined();
    expect(stages.some((row) => row.name === 'framework_import')).toBe(false);
    expect(loads.count).toBe(0);
  });

  it('the default framework hands no delegate on and never imports the adapter', async () => {
    const { out } = await runLayer('chat', 'llamaindex');
    expect(out.plan?.framework).toBe('llamaindex');
    expect(out.searchDelegate).toBeUndefined();
    expect(loads.count).toBe(0);
  });
});
