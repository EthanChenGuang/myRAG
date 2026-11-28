import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { buildQueryPlan, planToVariants } from '@/lib/rag/query/plan';
import type { GateResult } from '@/lib/rag/query/rewrite-gate';
import { resetRerankerFactoryForTests, setRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import type { Reranker, RerankOptions } from '@/lib/rag/rerank/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryVariant } from '@/lib/rag/types';
import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import { runRankStages, type RankStagesInput } from '@/lib/rag/v2/stages/rank';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const layer = vi.hoisted(() => ({ outcome: null as unknown }));

vi.mock('@/lib/rag/query/run-layer', () => ({
  runQueryLayer: async () => layer.outcome,
}));

const scope = mintScope('single', null, null);
const ORIGINAL = 'and the second one';
const STANDALONE = 'standalone form of the second question';
const HYDE = 'a generated passage that reads like an answer';

interface RerankCall {
  query: string;
  docs: string[];
  opts: RerankOptions;
}

function recordingReranker(id: Reranker['id'] = 'cohere'): { reranker: Reranker; calls: RerankCall[] } {
  const calls: RerankCall[] = [];
  const reranker: Reranker = {
    id,
    model: 'fake-quality-v1',
    scoreSemantics: id === 'local_bm25' ? 'relative' : 'calibrated',
    supportedLanguages: [],
    async rerank(query, docs, opts) {
      calls.push({ query, docs, opts });
      return { scores: docs.map((_, index) => ({ index, score: 1 - index / (docs.length + 1) })) };
    },
  };
  return { reranker, calls };
}

function gate(transforms: string[]): GateResult {
  return { rewrite: true, transforms, reasons: ['history'], lang: 'en', protectedTokens: [] } as unknown as GateResult;
}

function plan(options: { hyde?: boolean; subQuestions?: string[] } = {}): QueryPlan {
  return buildQueryPlan({
    original: ORIGINAL,
    gate: gate(['condense_history', ...(options.hyde ? ['hyde'] : []), ...(options.subQuestions ? ['decompose'] : [])]),
    framework: 'llamaindex',
    condensed: STANDALONE,
    ...(options.hyde ? { hyde: { text: HYDE, protectedOk: true } } : {}),
    ...(options.subQuestions ? { subQuestions: options.subQuestions } : {}),
  });
}

function row(chunkId: string, ranks: Record<string, number>, similarity: number, standaloneSimilarity?: number): FusedHit {
  return {
    hit: hit(chunkId, { documentId: `doc-${chunkId}`, similarity, content: `body ${chunkId}`, language: 'en' }),
    score: 0,
    ranks,
    ...(standaloneSimilarity !== undefined ? { standaloneSimilarity } : {}),
  };
}

function ids(rows: FusedHit[]): string[] {
  return rows.map((entry) => entry.hit.chunkId);
}

function setup(env: Record<string, string>): void {
  uninstallDeps();
  resetRerankerFactoryForTests();
  installDeps({ ragEnv: () => env });
}

function run(env: Record<string, string>, over: Partial<RankStagesInput> & { fusedHits: FusedHit[] }) {
  const signal = new AbortController().signal;
  const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
  const promise = runRankStages({
    input: { scope, query: ORIGINAL, profile: 'eval', signal },
    config: loadRagConfig(env),
    profile: 'eval',
    embedding: { vector: [0.1], profile: null },
    queryLanguage: 'en',
    referenced: null,
    signal,
    collector,
    ...over,
  });
  return { promise, collector };
}

const RERANK_ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'cohere', COHERE_API_KEY: 'cohere-test-placeholder-key' };
const FLOOR_ENV = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_REFUSAL_THRESHOLD: 'false' };

describe('rank stage under the query layer (D-06, D-07)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRerankerFactoryForTests();
    vi.restoreAllMocks();
  });

  it('reranks against the plan standalone query, never the original or the HyDE passage', async () => {
    setup(RERANK_ENV);
    const { reranker, calls } = recordingReranker();
    setRerankerFactoryForTests(() => reranker);
    const queryPlan = plan({ hyde: true });
    const variants = planToVariants(queryPlan);
    const hits = [row('c0', { 'dense:2': 1 }, 0.9, 0.4), row('c1', { 'dense:1': 1 }, 0.8, 0.8)];

    await run(RERANK_ENV, { fusedHits: hits, variants, queryPlan }).promise;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe(STANDALONE);
    expect(JSON.stringify(calls[0])).not.toContain(HYDE);
  });

  it('sends the standalone query for every document to a per-document reranker, never a variant text', async () => {
    setup(RERANK_ENV);
    const { reranker, calls } = recordingReranker('local_bm25');
    setRerankerFactoryForTests(() => reranker);
    const queryPlan = plan({ hyde: true });
    const variants: QueryVariant[] = [
      ...planToVariants(queryPlan),
      { text: 'translated text', language: 'en', kind: 'translated' },
    ];
    const hits = [row('c0', { 'dense:2': 1 }, 0.9, 0.4), row('c1', { 'dense:1': 1 }, 0.8, 0.8)];

    await run(RERANK_ENV, { fusedHits: hits, variants, queryPlan }).promise;

    expect(calls[0]!.query).toBe(STANDALONE);
    expect(calls[0]!.opts.queryByDoc).toEqual([STANDALONE, STANDALONE]);
  });

  it('refuses a no-answer item whose only high similarity comes from the HyDE list', async () => {
    setup(FLOOR_ENV);
    const queryPlan = plan({ hyde: true });
    const variants = planToVariants(queryPlan);
    // The HyDE dense list matched these chunks closely; the standalone variant's list barely did.
    const hits = [row('c0', { 'dense:2': 1 }, 0.95, 0.1), row('c1', { 'dense:2': 2 }, 0.93, 0)];

    const layered = await run(FLOOR_ENV, { fusedHits: hits, variants, queryPlan }).promise;
    expect(layered.decision.decision).toBe('refuse');
    expect(layered.survivors).toEqual([]);

    const phase4 = await run(FLOOR_ENV, { fusedHits: hits }).promise;
    expect(phase4.decision.decision).toBe('answer');
  });

  it('reserves the missing sub-question chunk in the final top-k and records the count', async () => {
    setup(FLOOR_ENV);
    const queryPlan = plan({ subQuestions: ['first part', 'second part'] });
    const variants = planToVariants(queryPlan);
    const subIndex = (part: number) => variants.findIndex((variant) => variant.subQuestionIndex === part);
    const hits = [
      row('c0', { [`dense:${subIndex(0)}`]: 1 }, 0.9, 0.9),
      row('c1', { 'dense:1': 1 }, 0.9, 0.9),
      row('c2', { 'dense:0': 1 }, 0.9, 0.9),
      row('c3', { [`dense:${subIndex(1)}`]: 1 }, 0.9, 0.9),
    ];

    const on = run(FLOOR_ENV, { fusedHits: hits, variants, queryPlan, coverage: { enabled: true, topK: 3 } });
    const out = await on.promise;
    expect(ids(out.survivors).slice(0, 3)).toEqual(['c0', 'c1', 'c3']);
    expect(ids(out.survivors)).toEqual(['c0', 'c1', 'c3', 'c2']);
    expect(on.collector.stages().find((stage) => stage.name === 'refusal')?.counts).toMatchObject({ subq_reserved: 1 });

    const off = await run(FLOOR_ENV, { fusedHits: hits, variants, queryPlan, coverage: { enabled: false, topK: 3 } }).promise;
    expect(ids(off.survivors)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('with the layer off keeps the original query, hit similarity and Phase 4 counts', async () => {
    setup(RERANK_ENV);
    const { reranker, calls } = recordingReranker();
    setRerankerFactoryForTests(() => reranker);
    const hits = [row('c0', { 'dense:0': 1 }, 0.9), row('c1', { 'dense:0': 2 }, 0.8)];

    const phase4 = run(RERANK_ENV, { fusedHits: hits, coverage: { enabled: true, topK: 1 } });
    const out = await phase4.promise;

    expect(calls[0]!.query).toBe(ORIGINAL);
    expect(ids(out.survivors)).toEqual(['c0', 'c1']);
    const counts = phase4.collector.stages().find((stage) => stage.name === 'refusal')?.counts ?? {};
    expect(Object.keys(counts)).not.toContain('subq_reserved');
  });
});

describe('v2 pipeline passes the plan and coverage to the rank stage', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    resetRagConfigForTests();
    resetRerankerFactoryForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    resetRagConfigForTests();
    resetRerankerFactoryForTests();
    vi.restoreAllMocks();
  });

  it('reranks on the standalone query and keeps the second sub-question in the final context', async () => {
    const queryPlan = plan({ subQuestions: ['first part', 'second part'] });
    const variants = planToVariants(queryPlan);
    layer.outcome = { plan: queryPlan, variants, dateRange: null, handledTranslate: false, shortCircuit: null };
    const vectorOf = new Map(variants.map((variant, index) => [variant.text, [index + 1, 0, 0]]));
    const secondPart = variants.findIndex((variant) => variant.subQuestionIndex === 1);
    setRetrievalBackendForTests({
      id: 'pgvector',
      async search(req) {
        const index = (req.denseVector?.[0] ?? 0) - 1;
        const dense =
          index === secondPart
            ? [hit('second-part-only', { rank: 1, similarity: 0.9, documentId: 'doc-second' })]
            : Array.from({ length: 10 }, (_, rank) =>
                hit(`main-${rank}`, { rank: rank + 1, similarity: 0.9, documentId: `doc-main-${rank}` }),
              );
        return { dense, lexical: [] } satisfies BackendLegs;
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    });
    const { reranker, calls } = recordingReranker();
    setRerankerFactoryForTests(() => reranker);
    const env = { ...RERANK_ENV, RAG_QUERY_LAYER: 'true' };
    installDeps({
      adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
      embedder: async (text) => vectorOf.get(text) ?? [0, 0, 1],
      ragEnv: () => env,
    });
    await verifyV2Startup();

    const trace = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const result = await runRetrieval({
      scope,
      trace,
      query: ORIGINAL,
      profile: 'eval',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe(STANDALONE);
    expect(result.candidates.map((candidate) => candidate.chunk_id)).toContain('second-part-only');
    expect(result.candidates).toHaveLength(8);
    const refusal = trace.stages().find((stage) => stage.name === 'refusal');
    expect(refusal?.counts).toMatchObject({ subq_reserved: 1 });
  });
});
