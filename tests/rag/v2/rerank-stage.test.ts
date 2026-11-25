import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRunConfig } from '../../../eval/harness/run-config.mts';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, RankedHit, RetrievalBackend } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { deriveStatus, StageError } from '@/lib/rag/pipeline';
import { resetRerankerFactoryForTests, setRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import type { Reranker, RerankOptions, RerankProviderId } from '@/lib/rag/rerank/types';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { cellKey, type ThresholdCells } from '@/lib/rag/refusal/gate';
import * as thresholds from '@/lib/rag/refusal/thresholds';
import { runRetrieval } from '@/lib/rag';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import type { Profile, QueryVariant, StageOverrides } from '@/lib/rag/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { runRankStages } from '@/lib/rag/v2/stages/rank';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, fakeReranker, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const COHERE_KEY = 'cohere-test-placeholder-key';

const BASE_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'cohere',
  RAG_REFUSAL_THRESHOLD: 'true',
  COHERE_API_KEY: COHERE_KEY,
};

interface RerankCall {
  query: string;
  docs: string[];
  opts: RerankOptions;
}

function recordingReranker(
  scoreFor: (docs: string[]) => number[],
  options: { id?: RerankProviderId; model?: string; semantics?: Reranker['scoreSemantics']; usage?: Record<string, number> } = {},
): { reranker: Reranker; calls: RerankCall[] } {
  const calls: RerankCall[] = [];
  const reranker: Reranker = {
    id: options.id ?? 'cohere',
    model: options.model ?? 'fake-quality-v1',
    scoreSemantics: options.semantics ?? 'calibrated',
    async rerank(query, docs, opts) {
      calls.push({ query, docs, opts });
      const scores = scoreFor(docs).map((score, index) => ({ index, score }));
      return { scores, ...(options.usage ? { usage: options.usage } : {}) };
    },
  };
  return { reranker, calls };
}

function reverseScores(docs: string[]): number[] {
  return docs.map((_, index) => (index + 1) / (docs.length + 1));
}

function useFactory(reranker: Reranker): void {
  setRerankerFactoryForTests(() => reranker);
}

function fusedHits(count: number, over: (index: number) => Partial<RankedHit> = () => ({})): FusedHit[] {
  return Array.from({ length: count }, (_, index) => ({
    hit: hit(`c${index}`, {
      rank: index + 1,
      documentId: `d${index}`,
      similarity: 0.9,
      content: `body ${index}`,
      ...over(index),
    }),
    score: 1 / (60 + index + 1),
    ranks: { 'dense:0': index + 1 },
  }));
}

function ids(rows: FusedHit[]): string[] {
  return rows.map((row) => row.hit.chunkId);
}

interface Harness {
  env: Record<string, string>;
  clock: { t: number };
}

function setup(envOver: Record<string, string | undefined> = {}, deps: Parameters<typeof installDeps>[0] = {}): Harness {
  uninstallDeps();
  resetRerankerFactoryForTests();
  const env: Record<string, string> = { ...BASE_ENV };
  for (const [key, value] of Object.entries(envOver)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const clock = { t: 1_000 };
  installDeps({ ragEnv: () => env, now: () => clock.t, ...deps });
  return { env, clock };
}

interface RunOptions {
  profile?: Profile;
  hits?: FusedHit[];
  queryLanguage?: 'zh' | 'en' | 'it' | null;
  variants?: QueryVariant[];
  signal?: AbortSignal;
  stageOverrides?: StageOverrides;
  dedupeCounts?: { candidates_in: number; deduped: number; rerank_input: number; capped_from: number };
  clock?: { t: number };
  elapsedMs?: number;
}

function rankRun(env: Record<string, string>, options: RunOptions = {}) {
  const profile = options.profile ?? 'eval';
  const hits = options.hits ?? fusedHits(5);
  const signal = options.signal ?? new AbortController().signal;
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  if (options.clock && options.elapsedMs !== undefined) options.clock.t = collector.startedAt + options.elapsedMs;
  const config = loadRagConfig(env);
  const promise = runRankStages({
    input: { scope, query: 'refund policy', profile, signal },
    config,
    profile,
    embedding: { vector: [0.1], profile: null },
    queryLanguage: options.queryLanguage === undefined ? 'en' : options.queryLanguage,
    fusedHits: hits,
    referenced: null,
    signal,
    collector,
    stageOverrides: options.stageOverrides,
    variants: options.variants,
    dedupeCounts: options.dedupeCounts,
  });
  return { promise, collector, hits };
}

function rerankRecord(collector: ReturnType<typeof createTraceCollector>) {
  return collector.stages().find((row) => row.name === 'rerank');
}

function cellsWith(threshold: number): ThresholdCells {
  const key = cellKey('cohere', 'fake-quality-v1', 'en', 'same');
  return new Map([
    [
      key,
      {
        key,
        provider: 'cohere',
        model: 'fake-quality-v1',
        query_language: 'en',
        pairing: 'same',
        threshold,
        status: 'calibrated',
        source: 'fixture',
        tokenizer_version: LEXICAL_VERSION,
        rerank_text_version: RERANK_TEXT_VERSION,
      },
    ],
  ]);
}

const EVAL_FAKE_MODEL: StageOverrides = { retrievalOverrides: { rerankModel: 'fake-quality-v1' } };

describe('v2 rerank stage in the rank group', () => {
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

  it('follows the reranker scores, records counts and usage, and keeps ties in fused order', async () => {
    const { env } = setup();
    const { reranker, calls } = recordingReranker(reverseScores, { usage: { search_units: 1 } });
    useFactory(reranker);
    const hits = fusedHits(75);
    const run = rankRun(env, {
      hits,
      dedupeCounts: { candidates_in: 130, deduped: 5, rerank_input: 75, capped_from: 120 },
    });
    const out = await run.promise;

    expect(ids(out.survivors)).toEqual(ids(hits).reverse());
    expect(out.rerank.ran).toBe(true);
    expect(out.rerank.scoreByChunk?.get('c74')).toBeGreaterThan(out.rerank.scoreByChunk?.get('c0') ?? 1);
    expect(calls).toHaveLength(1);
    const record = rerankRecord(run.collector);
    expect(record?.status).toBe('ok');
    expect(record?.counts).toMatchObject({ rerank_input: 75, capped_from: 120, usage_search_units: 1 });

    const tied = recordingReranker((docs) => docs.map(() => 0.5));
    useFactory(tied.reranker);
    const tiedRun = await rankRun(env, { hits: fusedHits(6) }).promise;
    expect(ids(tiedRun.survivors)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('sends the rerank text (section path, stripped legacy prefix) and the original query to hosted rerankers', async () => {
    const { env } = setup();
    const { reranker, calls } = recordingReranker(reverseScores);
    useFactory(reranker);
    const hits = fusedHits(2, (index) =>
      index === 0
        ? { sectionPath: ['Policy', 'Refunds'], content: 'Document: a.md. Chunk 1 of 2. Content: thirty day window' }
        : {},
    );
    const variants: QueryVariant[] = [
      { text: 'refund policy', language: 'en', kind: 'original' },
      { text: 'politica rimborsi', language: 'it', kind: 'translated' },
    ];
    await rankRun(env, { hits, variants }).promise;
    expect(calls[0]?.query).toBe('refund policy');
    expect(calls[0]?.docs[0]).toBe('Policy > Refunds\nthirty day window');
    expect(calls[0]?.docs[1]).toBe('body 1');
    expect(calls[0]?.opts.queryByDoc).toBeUndefined();
  });

  it('skips on a stage timeout, keeps the fused order, degrades the run and lets the floor decide', async () => {
    const { env } = setup({ RAG_STAGE_TIMEOUTS: 'rerank=25' });
    useFactory(fakeReranker({ delayMs: 200, model: 'fake-quality-v1' }).reranker);
    const hits = fusedHits(5);
    const run = rankRun(env, { hits, stageOverrides: EVAL_FAKE_MODEL });
    const out = await run.promise;

    const record = rerankRecord(run.collector);
    expect(record).toMatchObject({ status: 'skipped', reason: 'timeout' });
    expect(ids(out.survivors)).toEqual(ids(hits));
    expect(out.rerank.ran).toBe(false);
    expect(out.gate).toMatchObject({ decision: 'not_applied', reason: 'reranker_unavailable' });
    expect(out.decision).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor' });
    expect(deriveStatus(run.collector.stages(), out.survivors.length)).toBe('degraded');
  });

  it('skips on an HTTP 503 from the real Cohere adapter without retrying', async () => {
    const fetchSpy = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const { env } = setup({}, { fetch: fetchSpy as unknown as typeof fetch });
    const hits = fusedHits(4);
    const run = rankRun(env, { hits });
    const out = await run.promise;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(rerankRecord(run.collector)).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(ids(out.survivors)).toEqual(ids(hits));
    expect(out.gate.reason).toBe('reranker_unavailable');
    expect(deriveStatus(run.collector.stages(), out.survivors.length)).toBe('degraded');
  });

  it('records aborted, not degraded, when the request signal aborts mid-rerank', async () => {
    const { env } = setup();
    useFactory(fakeReranker({ delayMs: 300, model: 'fake-quality-v1' }).reranker);
    const controller = new AbortController();
    const run = rankRun(env, { signal: controller.signal, stageOverrides: EVAL_FAKE_MODEL });
    const outcome = run.promise.then(
      () => null,
      (error: unknown) => error,
    );
    setTimeout(() => controller.abort(new Error('client gone')), 20);
    const error = await outcome;

    expect(error).toBeInstanceOf(StageError);
    expect(error).toMatchObject({ stage: 'rerank', reason: 'aborted' });
    expect(rerankRecord(run.collector)?.status).toBe('aborted');
    expect(run.collector.stages().some((row) => row.status === 'skipped' || row.status === 'degraded')).toBe(false);
  });

  it('skips on a partial response', async () => {
    const { env } = setup();
    useFactory(fakeReranker({ partial: true, model: 'fake-quality-v1' }).reranker);
    const hits = fusedHits(4);
    const run = rankRun(env, { hits, stageOverrides: EVAL_FAKE_MODEL });
    const out = await run.promise;
    expect(rerankRecord(run.collector)).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(ids(out.survivors)).toEqual(ids(hits));
    expect(out.gate.reason).toBe('reranker_unavailable');
  });

  it('skips on a missing key without calling the vendor and names no key value', async () => {
    const fetchSpy = vi.fn();
    const { env } = setup({ COHERE_API_KEY: undefined }, { fetch: fetchSpy as unknown as typeof fetch });
    const hits = fusedHits(3);
    const run = rankRun(env, { hits });
    const out = await run.promise;
    const record = rerankRecord(run.collector);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(record).toMatchObject({ status: 'skipped', detail: 'missing_key' });
    expect(ids(out.survivors)).toEqual(ids(hits));
    expect(out.gate.reason).toBe('reranker_unavailable');
    expect(deriveStatus(run.collector.stages(), out.survivors.length)).toBe('degraded');
  });

  it('is disabled, not degraded, with RAG_RERANKER=none', async () => {
    const { env } = setup({ RAG_RERANKER: 'none' });
    const factory = vi.fn();
    setRerankerFactoryForTests(factory);
    const hits = fusedHits(3);
    const run = rankRun(env, { hits });
    const out = await run.promise;
    expect(rerankRecord(run.collector)?.status).toBe('disabled');
    expect(factory).not.toHaveBeenCalled();
    expect(ids(out.survivors)).toEqual(ids(hits));
    expect(out.gate.reason).toBe('reranker_disabled');
    expect(deriveStatus(run.collector.stages(), out.survivors.length)).not.toBe('degraded');
  });

  it('caps the voice rerank timeout by the request deadline and skips below the 80 ms floor', async () => {
    const harness = setup({ RAG_REFUSAL_THRESHOLD: 'false' });
    const { reranker, calls } = recordingReranker(reverseScores);
    useFactory(reranker);
    const voiceRun = (elapsedMs: number) => rankRun(harness.env, { profile: 'voice', clock: harness.clock, elapsedMs });

    const exhausted = voiceRun(760);
    const out = await exhausted.promise;
    expect(rerankRecord(exhausted.collector)).toMatchObject({ status: 'skipped', reason: 'timeout', detail: 'budget_exhausted' });
    expect(calls).toHaveLength(0);
    expect(out.rerank.ran).toBe(false);

    await voiceRun(300).promise;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts.timeoutMs).toBe(Math.min(250, 800 - 300 - 50));

    await voiceRun(600).promise;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.opts.timeoutMs).toBe(Math.min(250, 800 - 600 - 50));
  });

  it('gives local_bm25 the document-language query variant per candidate', async () => {
    const { env } = setup({ RAG_RERANKER: 'local_bm25', RAG_REFUSAL_THRESHOLD: 'false' });
    const hits = fusedHits(3, (index) =>
      index === 1
        ? { language: 'it', content: 'finestra rimborso politica trenta giorni' }
        : { language: 'en', content: index === 0 ? 'unrelated shipping schedule' : 'weather report for tomorrow' },
    );
    const variants: QueryVariant[] = [
      { text: 'refund policy', language: 'en', kind: 'original' },
      { text: 'rimborso politica', language: 'it', kind: 'translated' },
    ];

    const seen = recordingReranker(reverseScores, { id: 'local_bm25', model: 'bm25-v2', semantics: 'relative' });
    useFactory(seen.reranker);
    await rankRun(env, { hits, variants }).promise;
    expect(seen.calls[0]?.opts.queryByDoc).toEqual(['refund policy', 'rimborso politica', 'refund policy']);

    resetRerankerFactoryForTests();
    const real = await rankRun(env, { hits, variants }).promise;
    expect(ids(real.survivors)[0]).toBe('c1');

    const withoutVariant = await rankRun(env, { hits }).promise;
    expect(ids(withoutVariant.survivors)).toEqual(['c0', 'c1', 'c2']);
  });

  it.each([
    { top: 0.4, decision: 'refuse', reason: 'below_threshold', survivors: 0 },
    { top: 0.7, decision: 'answer', reason: 'above_threshold', survivors: 3 },
  ])('routes a calibrated cell with top score $top to $decision', async ({ top, decision, reason, survivors }) => {
    const { env } = setup();
    vi.spyOn(thresholds, 'loadThresholds').mockReturnValue({ cells: cellsWith(0.6), configHash: null });
    useFactory(recordingReranker((docs) => docs.map((_, index) => (index === 1 ? top : top - 0.2))).reranker);
    const run = rankRun(env, { hits: fusedHits(3), stageOverrides: EVAL_FAKE_MODEL });
    const out = await run.promise;
    expect(out.decision).toMatchObject({ decision, reason, topScore: top, threshold: 0.6 });
    expect(out.survivors).toHaveLength(survivors);
    expect(ids(out.preRefusalHits)[0]).toBe('c1');
  });

  it('carries rerank_score and kept_by rerank through the v2 pipeline', async () => {
    const { env } = setup({ RAG_REFUSAL_THRESHOLD: 'false' });
    resetActiveChunkingProfilesForTests();
    resetV2StartupForTests();
    const { embedder } = fakeEmbedder();
    const rpc = fakeRpcClient();
    installDeps({
      embedder,
      adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
      ragEnv: () => env,
    });
    const backend: RetrievalBackend = {
      id: 'pgvector',
      async search() {
        return {
          dense: [1, 2, 3].map((rank) =>
            hit(`chunk-${rank}`, { rank, similarity: 0.9, documentId: `doc-${rank}`, content: `content ${rank}`, chunkIndex: rank }),
          ),
          lexical: [],
        } satisfies BackendLegs;
      },
      health: async () => ({ ok: true }),
      isReady: async () => true,
    };
    setRetrievalBackendForTests(backend);
    useFactory(recordingReranker(reverseScores).reranker);
    await verifyV2Startup();
    const result = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
    });
    resetRetrievalBackendForTests();

    expect(result.status).toBe('ok');
    expect(result.candidates.map((candidate) => candidate.chunk_id)).toEqual(['chunk-3', 'chunk-2', 'chunk-1']);
    expect(result.candidates.every((candidate) => typeof candidate.rerank_score === 'number')).toBe(true);
    expect(new Set(result.kept.map((row) => row.kept_by))).toEqual(new Set(['rerank']));
    expect(result.stages.filter((row) => row.name === 'rerank')).toHaveLength(1);
    expect(result.stages.find((row) => row.name === 'rerank')?.status).toBe('ok');
  });

  it('puts the resolved rerank model into the retrieval config hash', async () => {
    const { env } = setup({ RAG_REFUSAL_THRESHOLD: 'false' });
    resetActiveChunkingProfilesForTests();
    resetV2StartupForTests();
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()), ragEnv: () => env });
    setRetrievalBackendForTests({
      id: 'pgvector',
      search: async () => ({ dense: [hit('chunk-1', { similarity: 0.9 })], lexical: [] }),
      health: async () => ({ ok: true }),
      isReady: async () => true,
    });
    useFactory(recordingReranker(reverseScores).reranker);
    await verifyV2Startup();
    const hashFor = async (rerankModel?: string) => {
      const result = await runRetrieval({
        scope,
        query: 'refund policy',
        profile: 'eval',
        stageOverrides: rerankModel ? { retrievalOverrides: { rerankModel } } : undefined,
        signal: new AbortController().signal,
      });
      return result.retrievalConfigHash;
    };
    const plain = await hashFor();
    const quality = await hashFor('fake-quality-v1');
    const fast = await hashFor('fake-fast-v1');
    resetRetrievalBackendForTests();
    expect(new Set([plain, quality, fast]).size).toBe(3);
  });
});

describe('v2-recommended run config', () => {
  it('still validates and selects Cohere against the fake quality model', () => {
    const config = loadRunConfig(path.join(process.cwd(), 'eval/config/runs/v2-recommended.json'));
    expect(config.name).toBe('v2-recommended');
    expect(config.env).toMatchObject({ RAG_PIPELINE: 'v2', RAG_RERANKER: 'cohere', RAG_REFUSAL_THRESHOLD: 'true' });
    expect(config.overrides?.rerank_model).toBe('fake-quality-v1');
  });
});
