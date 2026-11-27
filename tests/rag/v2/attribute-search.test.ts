import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend, RetrievalFilters } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { QueryVariant } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import type { AttributeSearchInput } from '@/lib/rag/v2/stages/query';
import { hit } from '../fusion/helpers';
import { fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const DOC = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HARD: RetrievalFilters = { currentOnly: true, documentIds: [DOC(1), DOC(2)] };
const FALLBACK: RetrievalFilters = { currentOnly: true };

type Handler = (req: BackendSearchRequest) => Promise<BackendLegs>;

function backendWith(handler: Handler, requests: BackendSearchRequest[]): RetrievalBackend {
  return {
    id: 'pgvector',
    search(req) {
      requests.push(req);
      return handler(req);
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function legs(dense: Array<[string, number, string?]>, lexical: Array<[string, number, string?]> = []): BackendLegs {
  return {
    dense: dense.map(([chunkId, similarity, documentId], index) => hit(chunkId, { rank: index + 1, similarity, documentId: documentId ?? DOC(1) })),
    lexical: lexical.map(([chunkId, score, documentId], index) =>
      hit(chunkId, { rank: index + 1, lexicalScore: score, documentId: documentId ?? DOC(1) }),
    ),
  };
}

function isSoftRequest(req: BackendSearchRequest, softIds: readonly string[]): boolean {
  return JSON.stringify(req.filters.documentIds ?? null) === JSON.stringify(softIds);
}

interface RunArgs {
  handler: Handler;
  filters?: RetrievalFilters;
  attributes?: AttributeSearchInput;
  env?: Record<string, string>;
  variants?: QueryVariant[];
  trackStandalone?: boolean;
}

async function run(args: RunArgs) {
  const env = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', ...args.env };
  resetRagConfigForTests();
  const cfg = loadRagConfig(env);
  const params = effectiveRetrievalParams('eval', cfg, null);
  const requests: BackendSearchRequest[] = [];
  setRetrievalBackendForTests(backendWith(args.handler, requests));
  const { embedder, signals } = fakeEmbedder();
  installDeps({ embedder, ragEnv: () => env, searchRpc: fakeRpcClient().client });
  await verifyV2Startup();
  const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
  const output = await runSearchStages({
    input: { scope, query: 'fixture query about the record', profile: 'eval', signal: new AbortController().signal },
    scope,
    config: cfg,
    profile: 'eval',
    params,
    embedding: { vector: [0.1, 0.2, 0.3], profile: null },
    signal: new AbortController().signal,
    collector,
    ...(args.variants ? { variants: args.variants, variantEmbeddings: args.variants.map(() => ({ vector: [0.1, 0.2, 0.3], profile: null })) } : {}),
    ...(args.filters ? { filters: args.filters } : {}),
    ...(args.attributes ? { attributes: args.attributes } : {}),
    ...(args.trackStandalone ? { trackStandalone: true } : {}),
  });
  const stages = collector.stages();
  return { output, stages, requests, params, embedCalls: signals, search: stages.filter((row) => row.name === 'search') };
}

describe('search stage with the attribute filter (03.3-19, D-29, F-18)', () => {
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
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('identity: no attribute input and an inert one send the same requests and records', async () => {
    const handler: Handler = async () => legs([['a', 0.9], ['b', 0.8]], [['b', 1]]);
    const without = await run({ handler });
    const inert = await run({ handler, attributes: { mode: 'hard', softIds: [], softWeight: 0.5, fallbackFilters: null } });
    const plain = (rows: BackendSearchRequest[]) => rows.map(({ signal: _signal, ...rest }) => rest);
    expect(plain(inert.requests)).toEqual(plain(without.requests));
    expect(inert.output.fusedHits).toEqual(without.output.fusedHits);
    const strip = (rows: typeof without.stages) => rows.map(({ startedAt: _s, endedAt: _e, latency_ms: _l, ...rest }) => rest);
    expect(strip(inert.stages)).toEqual(strip(without.stages));
  });

  it('hard with results: one round, every leg narrowed, applied 1 and fallback 0', async () => {
    const { requests, search } = await run({
      handler: async () => legs([['a', 0.9, DOC(1)]], [['a', 1, DOC(1)]]),
      filters: HARD,
      attributes: { mode: 'hard', softIds: [], softWeight: 0.5, fallbackFilters: FALLBACK },
    });
    expect(requests).toHaveLength(1);
    for (const req of requests) expect(req.filters.documentIds).toEqual(HARD.documentIds);
    expect(search).toHaveLength(1);
    expect(search[0]!.counts).toMatchObject({ attribute_filter_applied: 1, attribute_filter_fallback: 0 });
  });

  it('hard with every list empty: one more round with the fallback filters inside the same search record', async () => {
    const explicitFallback: RetrievalFilters = { currentOnly: true, documentIds: [DOC(7), DOC(8)], scopes: ['s1'] };
    const { requests, search, output } = await run({
      handler: async (req) => (req.filters.documentIds?.includes(DOC(1)) ? legs([]) : legs([['z', 0.7, DOC(7)]])),
      filters: { ...HARD, documentIds: [DOC(1)], scopes: ['s1'] },
      attributes: { mode: 'hard', softIds: [], softWeight: 0.5, fallbackFilters: explicitFallback },
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.filters).toEqual(explicitFallback);
    expect(search).toHaveLength(1);
    expect(search[0]!.detail).toContain('attribute_filter_fallback');
    expect(search[0]!.counts).toMatchObject({ attribute_filter_applied: 1, attribute_filter_fallback: 1 });
    expect(output.fusedHits.map((row) => row.hit.chunkId)).toEqual(['z']);
  });

  it('soft: one extra search on the soft ids, fused as attr:0 with the config weight, no extra embed', async () => {
    const softIds = [DOC(3)];
    const { requests, output, embedCalls } = await run({
      handler: async (req) => (isSoftRequest(req, softIds) ? legs([['s', 0.55, DOC(3)], ['a', 0.6, DOC(1)]]) : legs([['a', 0.9], ['b', 0.8]])),
      attributes: { mode: 'soft', softIds, softWeight: 0.5, fallbackFilters: null },
    });
    expect(requests).toHaveLength(2);
    expect(requests.filter((req) => isSoftRequest(req, softIds))).toHaveLength(1);
    expect(embedCalls.length).toBe(0);
    const s = output.fusedHits.find((row) => row.hit.chunkId === 's');
    expect(s?.ranks['attr:0']).toBe(1);
    const a = output.fusedHits.find((row) => row.hit.chunkId === 'a');
    expect(a?.ranks['attr:0']).toBe(2);
  });

  it('soft ids are intersected with the request document filter; an empty intersection adds no search', async () => {
    const { requests } = await run({
      handler: async () => legs([['a', 0.9]]),
      filters: { currentOnly: true, documentIds: [DOC(1)] },
      attributes: { mode: 'soft', softIds: [DOC(3)], softWeight: 0.5, fallbackFilters: null },
    });
    expect(requests).toHaveLength(1);
    const both = await run({
      handler: async () => legs([['a', 0.9]]),
      filters: { currentOnly: true, documentIds: [DOC(1), DOC(3)] },
      attributes: { mode: 'soft', softIds: [DOC(3), DOC(4)], softWeight: 0.5, fallbackFilters: null },
    });
    expect(both.requests).toHaveLength(2);
    expect(both.requests.some((req) => JSON.stringify(req.filters.documentIds) === JSON.stringify([DOC(3)]))).toBe(true);
  });

  it('scores: shared chunks keep the main hit; attr-only chunks carry the restricted similarity and standalone similarity', async () => {
    const softIds = [DOC(3)];
    const { output } = await run({
      handler: async (req) =>
        isSoftRequest(req, softIds) ? legs([['s', 0.42, DOC(3)], ['a', 0.11, DOC(1)]]) : legs([['a', 0.9], ['b', 0.8]], [['b', 1]]),
      attributes: { mode: 'soft', softIds, softWeight: 0.5, fallbackFilters: null },
      trackStandalone: true,
    });
    const byId = new Map(output.fusedHits.map((row) => [row.hit.chunkId, row]));
    expect(byId.get('a')?.hit.similarity).toBe(0.9);
    expect(byId.get('b')?.hit.similarity).toBe(0.8);
    expect(byId.get('b')?.hit.lexicalScore).toBe(null);
    expect(byId.get('s')?.hit.similarity).toBe(0.42);
    expect(byId.get('s')?.standaloneSimilarity).toBe(0.42);
    expect(byId.get('a')?.standaloneSimilarity).toBe(0.9);
  });

  it('a failed attr:0 search degrades the stage with a fixed code; the other legs continue', async () => {
    const softIds = [DOC(3)];
    const { output, search } = await run({
      handler: async (req) => {
        if (isSoftRequest(req, softIds)) throw new Error('fixture soft failure');
        return legs([['a', 0.9]]);
      },
      attributes: { mode: 'soft', softIds, softWeight: 0.5, fallbackFilters: null },
    });
    expect(search[0]!.status).toBe('degraded');
    expect(search[0]!.detail).toContain('attribute_soft_leg_failed');
    expect(output.fusedHits.map((row) => row.hit.chunkId)).toEqual(['a']);
  });

  it('a hard filter makes the exact_id_lookup record disabled like any document-id filter', async () => {
    const { stages } = await run({
      handler: async () => legs([['a', 0.9]]),
      filters: HARD,
      attributes: { mode: 'hard', softIds: [], softWeight: 0.5, fallbackFilters: FALLBACK },
      env: { RAG_EXACT_ID_LOOKUP: 'true' },
    });
    expect(stages.find((row) => row.name === 'exact_id_lookup')?.status).toBe('disabled');
  });
});
