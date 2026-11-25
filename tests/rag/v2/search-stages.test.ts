import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingProfileMismatchError, RetrievalBackendError } from '@/lib/rag/backend/supabase-rpc';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { hit, rankedList } from '../fusion/helpers';
import { rrf } from '@/lib/rag/fusion/rrf';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { StageError } from '@/lib/rag/pipeline';
import { fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', ...over });
}

function chunkIds(output: Awaited<ReturnType<typeof runSearchStages>>): string[] {
  return output.fusedHits.map((row) => row.hit.chunkId);
}

function fakeBackend(handler: (req: { lexicalTokens: string[]; signal: AbortSignal }) => Promise<BackendLegs>): RetrievalBackend {
  return {
    id: 'pgvector',
    search(req) {
      return handler({ lexicalTokens: req.lexicalTokens, signal: req.signal });
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function denseLexical(dense: string[], lexical: string[]): BackendLegs {
  return {
    dense: dense.map((chunkId, index) => hit(chunkId, { rank: index + 1, similarity: 0.9 - index * 0.01 })),
    lexical: lexical.map((chunkId, index) => hit(chunkId, { rank: index + 1, lexicalScore: 1 - index * 0.1 })),
  };
}

describe('runSearchStages', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('fuses dense and lexical legs with RRF and records dedupe counts', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    setRetrievalBackendForTests(fakeBackend(async () => denseLexical(['a', 'b', 'c'], ['c', 'd'])));
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    await verifyV2Startup();

    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const output = await runSearchStages({
      input: { scope, query: 'fixture query', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1, 0.2, 0.3], profile: null },
      signal: new AbortController().signal,
      collector,
    });

    const expected = rrf(
      [
        rankedList('dense:0', ['a', 'b', 'c']),
        rankedList('lexical:0', ['c', 'd']),
      ],
      params.rrf_k,
    ).map((row) => row.hit.chunkId);
    expect(chunkIds(output)).toEqual(expected.slice(0, params.rerank_input_cap));
    const dedupe = collector.stages().find((row) => row.name === 'dedupe');
    expect(dedupe?.counts).toMatchObject({
      candidates_in: expect.any(Number),
      deduped: expect.any(Number),
      rerank_input: expect.any(Number),
      capped_from: expect.any(Number),
    });
  });

  it('with lexical search off passes empty tokens and keeps dense order', async () => {
    const cfg = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false' });
    const params = effectiveRetrievalParams('eval', cfg, null);
    let seenTokens: string[] | null = null;
    setRetrievalBackendForTests(
      fakeBackend(async ({ lexicalTokens }) => {
        seenTokens = lexicalTokens;
        return denseLexical(['a', 'b', 'c'], []);
      }),
    );
    const { embedder } = fakeEmbedder();
    installDeps({ embedder });

    const output = await runSearchStages({
      input: { scope, query: 'q', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1, 0.2, 0.3], profile: null },
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    });

    expect(seenTokens).toEqual([]);
    expect(chunkIds(output)).toEqual(['a', 'b', 'c']);
  });

  it('sends the eval chunking override to the backend for the eval profile only', async () => {
    const cfg = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false' });
    const seen: Array<Record<string, string> | undefined> = [];
    setRetrievalBackendForTests({
      id: 'pgvector',
      search: async (req) => {
        seen.push(req.chunkingProfileOverride);
        return denseLexical(['a'], []);
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    });
    const { embedder } = fakeEmbedder();
    installDeps({ embedder });
    const override = { contract_legal: 'p256-1024-contract_legal' };
    for (const profile of ['eval', 'chat'] as const) {
      await runSearchStages({
        input: { scope, query: 'q', profile, signal: new AbortController().signal },
        scope,
        config: cfg,
        profile,
        params: effectiveRetrievalParams(profile, cfg, null),
        embedding: { vector: [0.1, 0.2, 0.3], profile: null },
        signal: new AbortController().signal,
        collector: createTraceCollector({ profile, tenantKey: 's:default' }),
        stageOverrides: { retrievalOverrides: { chunkingProfileByDocType: override } },
      });
    }

    expect(seen).toEqual([override, undefined]);
  });

  it('issues concurrent backend calls per variant sharing one signal', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    const order: string[] = [];
    setRetrievalBackendForTests(
      fakeBackend(async ({ signal }) => {
        order.push('start');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 20);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          });
        });
        order.push('end');
        return denseLexical(['a'], []);
      }),
    );
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });

    await runSearchStages({
      input: { scope, query: 'one', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1], profile: null },
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
      variants: [
        { text: 'one', language: null, kind: 'original' },
        { text: 'two', language: null, kind: 'translated' },
      ],
    });

    expect(order.filter((entry) => entry === 'start').length).toBe(2);
    expect(order.indexOf('end')).toBeGreaterThan(order.indexOf('start'));
  });

  it('aborts in-flight backend calls when the parent signal aborts', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    setRetrievalBackendForTests(
      fakeBackend(async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
          });
        });
        return denseLexical(['a'], []);
      }),
    );
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    const controller = new AbortController();
    const run = runSearchStages({
      input: { scope, query: 'slow', profile: 'eval', signal: controller.signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1], profile: null },
      signal: controller.signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    });
    controller.abort();
    await expect(run).rejects.toMatchObject({ reason: 'aborted' });
  });

  it('maps backend errors to backend_error', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    setRetrievalBackendForTests({
      id: 'pgvector',
      search: async () => {
        throw new RetrievalBackendError('hybrid_search_chunks', '42501');
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    });
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });

    await expect(
      runSearchStages({
        input: { scope, query: 'x', profile: 'eval', signal: new AbortController().signal },
        scope,
        config: cfg,
        profile: 'eval',
        params,
        embedding: { vector: [0.1], profile: null },
        signal: new AbortController().signal,
        collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
      }),
    ).rejects.toBeInstanceOf(StageError);
  });

  it('maps embedding profile mismatch to embedding_profile_mismatch', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    setRetrievalBackendForTests({
      id: 'pgvector',
      search: async () => {
        throw new EmbeddingProfileMismatchError('dims', { profile: 'p1' });
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    });
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });

    try {
      await runSearchStages({
        input: { scope, query: 'x', profile: 'eval', signal: new AbortController().signal },
        scope,
        config: cfg,
        profile: 'eval',
        params,
        embedding: { vector: [0.1], profile: null },
        signal: new AbortController().signal,
        collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(StageError);
      expect((error as StageError).original).toBeInstanceOf(EmbeddingProfileMismatchError);
    }
  });

  it('skips the lexical leg when ICU is unavailable', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    let seenTokens: string[] | null = null;
    setRetrievalBackendForTests(
      fakeBackend(async ({ lexicalTokens }) => {
        seenTokens = lexicalTokens;
        return denseLexical(['a', 'b', 'c'], []);
      }),
    );
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    resetV2StartupForTests();
    await verifyV2Startup({ icuSegmentsChinese: () => false });

    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    await runSearchStages({
      input: { scope, query: 'tokens', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1, 0.2], profile: null },
      signal: new AbortController().signal,
      collector,
    });

    expect(seenTokens).toEqual([]);
    const search = collector.stages().find((row) => row.name === 'search');
    expect(search?.status).toBe('degraded');
    expect(search?.detail).toBe('lexical_icu_unavailable');
  });

  it('caps fused hits to rerank_input_cap', async () => {
    const cfg = config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    const many = Array.from({ length: 120 }, (_, index) => `chunk-${index}`);
    setRetrievalBackendForTests(fakeBackend(async () => denseLexical(many, [])));
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });

    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const output = await runSearchStages({
      input: { scope, query: 'wide', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1], profile: null },
      signal: new AbortController().signal,
      collector,
    });

    expect(output.fusedHits.length).toBe(params.rerank_input_cap);
    const dedupe = collector.stages().find((row) => row.name === 'dedupe');
    expect(dedupe?.counts?.capped_from).toBe(120);
    expect(dedupe?.counts?.rerank_input).toBe(75);
  });
});
describe('runSearchStages binding legs', () => {
  const LAW = 'voyage-law-2-1024';
  const lawProfile = {
    id: LAW,
    provider: 'voyage',
    model: 'voyage-law-2',
    dims: 3,
    storage: 'halfvec' as const,
    status: 'available' as const,
    queryInstruction: null,
    scoreCalibration: {},
    activatedAt: null,
    activatedBy: null,
    previousActiveId: null,
    hasEvidence: true,
  };

  interface Call {
    profile: string;
    docTypes: string[] | undefined;
    lexicalLimit: number;
    lexicalTokens: string[];
    denseLimit: number;
    tenant: unknown;
  }

  function routedBackend(calls: Call[]): RetrievalBackend {
    return {
      id: 'pgvector',
      async search(req) {
        calls.push({
          profile: req.embeddingProfileId,
          docTypes: req.filters.docTypes,
          lexicalLimit: req.lexicalLimit,
          lexicalTokens: req.lexicalTokens,
          denseLimit: req.denseLimit,
          tenant: req.scope,
        });
        if (req.embeddingProfileId === LAW) {
          return { dense: [hit('b', { rank: 1, similarity: 0.41 }), hit('z', { rank: 2, similarity: 0.4 })], lexical: [] };
        }
        return denseLexical(['a', 'b', 'c'], ['c', 'd']);
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    };
  }

  async function run(bindings?: Parameters<typeof runSearchStages>[0]['bindings']) {
    const cfg = config();
    const params = effectiveRetrievalParams('chat', cfg, null);
    const calls: Call[] = [];
    setRetrievalBackendForTests(routedBackend(calls));
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
    await verifyV2Startup();
    const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
    const output = await runSearchStages({
      input: { scope, query: 'neutral sample question', profile: 'chat', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'chat',
      params,
      embedding: { vector: [0.1, 0.2, 0.3], profile: null },
      signal: new AbortController().signal,
      collector,
      ...(bindings ? { bindings } : {}),
    });
    const stages = collector.stages().map((row) => ({
      name: row.name,
      status: row.status,
      counts: row.counts,
      detail: row.detail,
      candidatesOut: row.candidatesOut,
    }));
    const fused = output.fusedHits.map((row) => ({ id: row.hit.chunkId, score: row.score, similarity: row.hit.similarity, ranks: row.ranks }));
    return { calls: calls.map(({ tenant: _tenant, ...rest }) => rest), tenants: calls.map((call) => call.tenant), fused, stages };
  }

  it('with no binding work the calls, fused output and trace match the recorded pre-binding snapshot', async () => {
    const off = await run();
    expect(off).toMatchInlineSnapshot(`
      {
        "calls": [
          {
            "denseLimit": 75,
            "docTypes": undefined,
            "lexicalLimit": 75,
            "lexicalTokens": [
              "neutral",
              "sample",
              "question",
            ],
            "profile": "openai-3-small-1536",
          },
        ],
        "fused": [
          {
            "id": "c",
            "ranks": {
              "dense:0": 3,
              "lexical:0": 1,
            },
            "score": 0.032266458495966696,
            "similarity": 0.88,
          },
          {
            "id": "a",
            "ranks": {
              "dense:0": 1,
            },
            "score": 0.01639344262295082,
            "similarity": 0.9,
          },
          {
            "id": "b",
            "ranks": {
              "dense:0": 2,
            },
            "score": 0.016129032258064516,
            "similarity": 0.89,
          },
          {
            "id": "d",
            "ranks": {
              "lexical:0": 2,
            },
            "score": 0.016129032258064516,
            "similarity": null,
          },
        ],
        "stages": [
          {
            "candidatesOut": undefined,
            "counts": {
              "dense": 3,
              "lexical": 2,
            },
            "detail": undefined,
            "name": "search",
            "status": "ok",
          },
          {
            "candidatesOut": undefined,
            "counts": undefined,
            "detail": undefined,
            "name": "fuse",
            "status": "ok",
          },
          {
            "candidatesOut": undefined,
            "counts": {
              "candidates_in": 4,
              "capped_from": 4,
              "deduped": 0,
              "rerank_input": 4,
            },
            "detail": undefined,
            "name": "dedupe",
            "status": "ok",
          },
        ],
        "tenants": [
          {
            "kind": "single",
            "organizationId": null,
            "userId": null,
          },
        ],
      }
    `);
    const emptyPlan = await run({ plan: { legs: [], controlLeg: null, failures: [] }, embeds: [] });
    expect(emptyPlan).toEqual(off);
  });

  it('a fresh binding adds one backend call and a dense_domain list; shared chunks keep the global similarity', async () => {
    const off = await run();
    const on = await run({
      plan: { legs: [{ docType: 'contract_legal', profileId: LAW, profile: lawProfile, source: 'binding' }], controlLeg: null, failures: [] },
      embeds: [Promise.resolve({ vector: [0.3, 0.2, 0.1] })],
    });
    expect(on.calls).toHaveLength(off.calls.length + 1);
    expect(on.calls.at(-1)).toEqual({ profile: LAW, docTypes: ['contract_legal'], lexicalLimit: 0, lexicalTokens: [], denseLimit: expect.any(Number) });
    expect(on.tenants.every((tenant) => tenant === scope)).toBe(true);
    const z = on.fused.find((row) => row.id === 'z');
    expect(z?.similarity).toBeNull();
    expect(z?.ranks).toEqual({ 'dense_domain:contract_legal': 2 });
    const b = on.fused.find((row) => row.id === 'b');
    const offB = off.fused.find((row) => row.id === 'b');
    expect(b?.similarity).toBe(offB?.similarity);
    expect(b?.ranks['dense_domain:contract_legal']).toBe(1);
    const search = on.stages.find((row) => row.name === 'search');
    expect(search?.status).toBe('ok');
    expect(search?.counts).toMatchObject({ domain: 2 });
  });

  it('a binding embed timeout degrades the search stage and leaves the fused output as with no binding', async () => {
    const off = await run();
    const timedOut = await run({
      plan: { legs: [{ docType: 'contract_legal', profileId: LAW, profile: lawProfile, source: 'binding' }], controlLeg: null, failures: [] },
      embeds: [Promise.resolve({ failure: 'timeout' })],
    });
    expect(timedOut.fused).toEqual(off.fused);
    expect(timedOut.calls).toEqual(off.calls);
    const search = timedOut.stages.find((row) => row.name === 'search');
    expect(search?.status).toBe('degraded');
    expect(search?.detail).toBe('binding_leg_timeout:contract_legal');
    expect(search?.counts).toMatchObject({ domain: 0 });
  });
});
