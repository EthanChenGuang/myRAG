import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../../eval/harness/fake-query-llm.mts';
import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { storeBypassReason, type StoreTurnFacts } from '@/lib/rag/cache/bypass';
import type { SemanticCache } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { LEGACY_PROFILE } from '@/lib/rag/embeddings/active-profile';
import { resetScopeGateCalibrationForTests, setScopeGateCalibrationForTests } from '@/lib/rag/scope/calibration';
import type { CentroidSnapshot } from '@/lib/rag/scope/centroids';
import { getCentroidSnapshot } from '@/lib/rag/scope/centroids';
import { resetScopeGateStageLogForTests, runScopeGateStage, scopeGateFailOpen } from '@/lib/rag/scope/stage';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { Profile, RagMode, RetrievalCacheContext, RetrievalResult, StageRecord } from '@/lib/rag/types';
import { statusRecords } from '@/lib/rag/v2/result';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';
import { SCOPE_A, SCOPE_SINGLE } from '../cache/fixtures';

vi.mock('@/lib/rag/scope/centroids', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/scope/centroids')>();
  return { ...actual, getCentroidSnapshot: vi.fn(() => null) };
});

const snapshotMock = vi.mocked(getCentroidSnapshot);

const QUESTION = 'What does the sample widget report to the operator?';
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT: RetrievalCacheContext = {
  generatorModel: 'provider/model-a',
  systemPromptHash: 'b'.repeat(64),
  webSearch: false,
  mcpTools: false,
  chatId: null,
};
const RETRIEVAL_STAGES = ['search', 'fuse', 'dedupe', 'rerank', 'refusal', 'expand_parents', 'compress', 'injection_check', 'assemble'];
const QUERY_VECTOR = [0.1, 0.2, 0.3];
const PROFILE_ID = LEGACY_PROFILE.id;
const LAYER_ON = { RAG_QUERY_LAYER: 'true', RAG_SCOPE_GATE: 'true' };

function unit(values: number[]): Float32Array {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return Float32Array.from(values, (value) => value / norm);
}

function snapshot(vector: number[], partial: Partial<CentroidSnapshot> = {}): CentroidSnapshot {
  return {
    tenantKey: scopeKey(SCOPE_SINGLE),
    profileId: PROFILE_ID,
    dims: vector.length,
    centroids: [{ kind: 'tenant', key: 'all', memberCount: 2, vector: unit(vector) }],
    examples: [],
    unsupported: false,
    loadedAt: 0,
    ...partial,
  };
}

/** The query vector is [0.1, 0.2, 0.3]; [0, 0, 1] scores about 0.80, [1, -1, 0] scores below zero. */
const NEAR = [0.1, 0.2, 0.3];
const FAR = [1, -1, 0];

function calibrate(threshold: number, margin: number, mode: RagMode = 'strict') {
  setScopeGateCalibrationForTests({
    schema_version: 1,
    recorded_at: '2026-11-27T00:00:00Z',
    source: 'fixture',
    cells: [
      {
        embedding_profile_id: PROFILE_ID,
        rag_mode: mode,
        threshold,
        margin,
        false_refusal_rate: 0,
        false_refusal_n: 10,
        correct_refusal_rate: 0.5,
        correct_refusal_n: 4,
        status: 'calibrated',
      },
    ],
  });
}

function missCache(): SemanticCache {
  return {
    async check() {
      return null;
    },
    async store() {},
    async invalidateTenant() {
      return 0;
    },
  };
}

async function run(envOver: Record<string, string> = {}, opts: { profile?: Profile; cache?: SemanticCache } = {}) {
  resetActiveChunkingProfilesForTests();
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  installDeps({
    embedder: async () => [...QUERY_VECTOR],
    adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
    queryLlm: () => fake,
    ...(opts.cache ? { semanticCache: () => opts.cache! } : {}),
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'false',
      RAG_RERANKER: 'none',
      ...(opts.cache ? { RAG_SEMANTIC_CACHE: 'pgvector' } : {}),
      ...envOver,
    }),
  });
  const seen = { searches: 0 };
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search() {
      seen.searches += 1;
      return { dense: [hit('chunk-1', { rank: 1, similarity: 0.9, documentId: DOC, chunkIndex: 0 })], lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  setRetrievalBackendForTests(backend);
  await verifyV2Startup();
  const profile = opts.profile ?? 'chat';
  const collector = createTraceCollector({ profile, tenantKey: scopeKey(SCOPE_SINGLE) });
  const result: RetrievalResult = await runRetrieval({
    scope: SCOPE_SINGLE,
    query: QUESTION,
    profile,
    options: { ragMode: 'strict', webSearchEnabled: false, maxResults: 25 },
    signal: new AbortController().signal,
    trace: collector,
    ...(profile === 'voice' ? {} : { cacheContext: CONTEXT }),
  });
  return { result, seen, stages: collector.stages() };
}

function comparable(result: RetrievalResult) {
  // retrievalConfigHash differs by design: RAG_SCOPE_GATE enters the hash while on (06.2 G5), so a flip never serves a stale cache entry.
  const { traceId: _traceId, stages: _stages, scopeGate: _scopeGate, logOutcome: _logOutcome, retrievalConfigHash: _hash, ...rest } = result;
  return rest;
}

describe('scope_gate stage in the v2 pipeline (D-26)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetV2StartupForTests();
    resetScopeGateCalibrationForTests();
    resetScopeGateStageLogForTests();
    snapshotMock.mockReset();
    snapshotMock.mockReturnValue(null);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetScopeGateCalibrationForTests();
    vi.restoreAllMocks();
  });

  it('switch off: no scope_gate record, no snapshot read, and the result equals a gate that labels in_scope', async () => {
    calibrate(0.5, 0.05);
    snapshotMock.mockReturnValue(snapshot(NEAR));
    const off = await run({ RAG_QUERY_LAYER: 'true' });
    expect(off.stages.some((row) => row.name === 'scope_gate')).toBe(false);
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(off.result.scopeGate).toBeUndefined();
    expect(off.result.skipReason).toBeUndefined();

    const on = await run(LAYER_ON);
    expect(on.result.scopeGate?.label).toBe('in_scope');
    expect(comparable(on.result)).toEqual(comparable(off.result));
    expect(on.result.retrievalConfigHash).not.toBe(off.result.retrievalConfigHash);
    expect(on.seen.searches).toBe(off.seen.searches);
  });

  it('the voice profile never runs the gate', async () => {
    calibrate(0.99, 0.05);
    snapshotMock.mockReturnValue(snapshot(FAR));
    const { stages, result, seen } = await run(LAYER_ON, { profile: 'voice' });
    expect(stages.some((row) => row.name === 'scope_gate')).toBe(false);
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(result.scopeGate).toBeUndefined();
    expect(seen.searches).toBeGreaterThan(0);
  });

  it('out_of_scope skips search, rank and context: empty, skip reason out_of_scope, label and score on the result', async () => {
    calibrate(0.5, 0.05);
    snapshotMock.mockReturnValue(snapshot(FAR));
    const { result, seen, stages } = await run(LAYER_ON);
    expect(seen.searches).toBe(0);
    expect(stages.map((row) => row.name).filter((name) => RETRIEVAL_STAGES.includes(name))).toEqual([]);
    expect(stages.find((row) => row.name === 'scope_gate')).toMatchObject({ status: 'ok', detail: 'out_of_scope' });
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('out_of_scope');
    expect(result.skipReason).toBe('out_of_scope');
    expect(result.refusalCandidate).toBe(true);
    expect(result.context).toBe('');
    expect(result.scopeGate).toMatchObject({ label: 'out_of_scope', reason: 'below_threshold', centroid_count: 1 });
    expect(result.scopeGate!.score!).toBeLessThan(0);
    expect(snapshotMock).toHaveBeenCalledWith(SCOPE_SINGLE, PROFILE_ID);
  });

  it('the cache keeps the ticket for the trace but never stores an out_of_scope turn', async () => {
    calibrate(0.5, 0.05);
    snapshotMock.mockReturnValue(snapshot(FAR));
    const { result } = await run({ ...LAYER_ON }, { cache: missCache() });
    expect(result.reason).toBe('out_of_scope');
    const ticket = result.cacheTicket;
    expect(ticket).toBeDefined();
    expect(ticket!.turn.skipReason).toBe('out_of_scope');
    const facts: StoreTurnFacts = {
      ...ticket!.turn,
      chatId: null,
      sourceImages: false,
      retrievalStatus: 'empty',
      groundednessLabel: null,
      embedStore: false,
      answerText: 'A fixed refusal text.',
    };
    expect(storeBypassReason(facts)).toBe('out_of_scope');
    expect(storeBypassReason({ ...facts, skipReason: undefined })).toBeNull();
  });

  it('unsure without a calibration retrieves as before with the score traced', async () => {
    snapshotMock.mockReturnValue(snapshot(FAR));
    const { result, seen, stages } = await run(LAYER_ON);
    expect(seen.searches).toBeGreaterThan(0);
    expect(result.status).toBe('ok');
    expect(result.skipReason).toBeUndefined();
    expect(result.scopeGate).toMatchObject({ label: 'unsure', reason: 'uncalibrated' });
    expect(typeof result.scopeGate!.score).toBe('number');
    expect(stages.find((row) => row.name === 'scope_gate')).toMatchObject({ status: 'ok', detail: 'unsure' });
  });

  it('unsure inside the margin and in_scope both search', async () => {
    calibrate(0.5, 0.05);
    snapshotMock.mockReturnValue(snapshot(NEAR));
    const inScope = await run(LAYER_ON);
    expect(inScope.result.scopeGate?.label).toBe('in_scope');
    expect(inScope.seen.searches).toBeGreaterThan(0);

    // [0.3, 0.2, 0.1] scores 10/14 ≈ 0.714 against the query: inside [0.7, 0.75).
    calibrate(0.75, 0.05);
    snapshotMock.mockReturnValue(snapshot([0.3, 0.2, 0.1]));
    const margin = await run(LAYER_ON);
    expect(margin.result.scopeGate).toMatchObject({ label: 'unsure', reason: 'within_margin' });
    expect(margin.seen.searches).toBeGreaterThan(0);
  });

  it('a thrown stage error is unsure and never degrades the retrieval status', async () => {
    calibrate(0.5, 0.05);
    snapshotMock.mockImplementation(() => {
      throw new Error('synthetic failure');
    });
    const { result, seen, stages } = await run(LAYER_ON);
    expect(seen.searches).toBeGreaterThan(0);
    expect(stages.find((row) => row.name === 'scope_gate')).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(result.scopeGate).toMatchObject({ label: 'unsure', reason: 'failed' });
    expect(result.status).toBe('ok');
  });

  it('no snapshot yet (the loader refreshes in the background) is unsure and retrieves', async () => {
    calibrate(0.5, 0.05);
    const { result, seen } = await run(LAYER_ON);
    expect(result.scopeGate).toMatchObject({ label: 'unsure', reason: 'no_snapshot', score: null });
    expect(seen.searches).toBeGreaterThan(0);
  });
});

describe('scope_gate soft status and stage body', () => {
  afterEach(() => {
    resetScopeGateCalibrationForTests();
    snapshotMock.mockReset();
    snapshotMock.mockReturnValue(null);
  });

  const record = (name: string, status: StageRecord['status']): StageRecord => ({ name, status, startedAt: 0, endedAt: 1 }) as StageRecord;

  it('a timed-out or skipped scope_gate record is always dropped from the status records', () => {
    const records = [record('embed', 'ok'), record('scope_gate', 'timeout'), record('search', 'ok'), record('fuse', 'ok')];
    expect(statusRecords(records, 3).map((row) => row.name)).toEqual(['embed', 'search', 'fuse']);
    expect(statusRecords([record('embed', 'ok'), record('scope_gate', 'skipped')], 0).map((row) => row.name)).toEqual(['embed']);
    expect(scopeGateFailOpen('timeout')).toEqual({ label: 'unsure', score: null, negative_score: null, reason: 'timeout', centroid_count: 0, latency_ms: 0 });
  });

  const plan = (transforms: QueryPlan['gate']['transforms'], skipped: QueryPlan['skipped'] = []): QueryPlan =>
    ({ gate: { transforms }, skipped }) as unknown as QueryPlan;

  it('a translate the gate asked for and that was skipped makes the gate unsure', () => {
    calibrate(0.5, 0.05);
    snapshotMock.mockReturnValue(snapshot(FAR));
    const base = {
      scope: SCOPE_A,
      embeddingProfileId: PROFILE_ID,
      ragMode: 'strict' as const,
      variants: [{ kind: 'original' as const, text: 'q', language: 'en' }],
      embeddings: [{ vector: QUERY_VECTOR, profile: null }],
    };
    expect(runScopeGateStage({ ...base, queryPlan: plan(['translate'], [{ transform: 'translate', reason: 'timeout' }]) })).toMatchObject({
      label: 'unsure',
      reason: 'translate_skipped',
    });
    expect(runScopeGateStage({ ...base, queryPlan: plan(['translate']) }).label).toBe('out_of_scope');
    expect(snapshotMock).toHaveBeenCalledWith(SCOPE_A, PROFILE_ID);
  });

  it('HyDE variants are not scored; every other variant is', () => {
    calibrate(0.5, 0.05);
    snapshotMock.mockReturnValue(snapshot(NEAR));
    const result = runScopeGateStage({
      scope: SCOPE_A,
      embeddingProfileId: PROFILE_ID,
      ragMode: 'strict',
      variants: [
        { kind: 'original', text: 'q', language: 'en' },
        { kind: 'hyde', text: 'h', language: 'en' },
        { kind: 'condensed', text: 'c', language: 'en' },
      ],
      embeddings: [
        { vector: FAR, profile: null },
        { vector: NEAR, profile: null },
        { vector: FAR, profile: null },
      ],
      queryPlan: null,
    });
    expect(result.label).toBe('out_of_scope');
    const withCondensed = runScopeGateStage({
      scope: SCOPE_A,
      embeddingProfileId: PROFILE_ID,
      ragMode: 'strict',
      variants: [
        { kind: 'original', text: 'q', language: 'en' },
        { kind: 'condensed', text: 'c', language: 'en' },
      ],
      embeddings: [
        { vector: FAR, profile: null },
        { vector: NEAR, profile: null },
      ],
      queryPlan: null,
    });
    expect(withCondensed.label).toBe('in_scope');
  });

  it('the calibration cell is read for the request RAG mode only', () => {
    calibrate(0.5, 0.05, 'balanced');
    snapshotMock.mockReturnValue(snapshot(FAR));
    const input = {
      scope: SCOPE_A,
      embeddingProfileId: PROFILE_ID,
      variants: [{ kind: 'original' as const, text: 'q', language: 'en' }],
      embeddings: [{ vector: QUERY_VECTOR, profile: null }],
      queryPlan: null,
    };
    expect(runScopeGateStage({ ...input, ragMode: 'strict' })).toMatchObject({ label: 'unsure', reason: 'uncalibrated' });
    expect(runScopeGateStage({ ...input, ragMode: 'balanced' }).label).toBe('out_of_scope');
  });
});
