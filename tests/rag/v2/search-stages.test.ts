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