import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankedHit } from '@/lib/rag/backend/types';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { logger } from '@/lib/logger';
import { loadRagConfig } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { resetLexstatsCacheForTests } from '@/lib/rag/lexical/stats';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { cellKey, type ThresholdCells } from '@/lib/rag/refusal/gate';
import * as thresholds from '@/lib/rag/refusal/thresholds';
import { resetRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { RERANK_STATS_TENANT, RERANK_STATS_UNAVAILABLE, runRankStages } from '@/lib/rag/v2/stages/rank';
import type { Profile } from '@/lib/rag/types';
import { hit } from '../fusion/helpers';
import { fakeAssemblyAdmin, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

/**
 * 04.4-21 (D-55, D-56) at the stage: the rank stage passes tenant statistics to local_bm25 only under RAG_RERANK_LOCAL_STATS=tenant, and
 * the trace detail, the stage output and the refusal-cell match see bm25-v3-tenant only when tenant statistics served; bm25-v2 in pool
 * mode and on every fallback. Neutral synthetic text only (D-41).
 */
const scope = mintScope('single', null, null);
const TENANT = 's:default';
const BASE_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'local_bm25',
  RAG_REFUSAL_THRESHOLD: 'true',
};
const TEXTS = ['amber tile row seven', 'cobalt river gauge', 'north panel marker amber', 'copper harbor lantern', 'meadow row tile amber'];

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function routingClient(answers: Record<string, () => RpcResponse | Promise<RpcResponse>>): { client: RpcClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const settle = async (): Promise<RpcResponse> => (answers[fn] ? answers[fn]() : { data: null, error: { message: `unexpected ${fn}` } });
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  return { client, calls };
}

const READY: RpcResponse = { data: { state: 'ready', chunk_count: 500 }, error: null };

function statsRows(args: Record<string, unknown>): RpcResponse {
  const terms = args.p_terms as string[];
  const types = args.p_doc_types as string[];
  const langs = args.p_languages as string[];
  return {
    data: types.map((docType, i) => ({
      doc_type: docType,
      language: langs[i],
      chunking_profile_id: 'legacy',
      chunk_count: 500,
      total_len: 5000,
      terms,
      dfs: terms.map((_, j) => 3 + j * 7),
    })),
    error: null,
  };
}

function fused(over: (index: number) => Partial<RankedHit> = () => ({})): FusedHit[] {
  return TEXTS.map((content, index) => ({
    hit: hit(`c${index}`, { rank: index + 1, documentId: `d${index}`, similarity: 0.9, content, docType: 'general', language: 'en', ...over(index) }),
    score: 1 / (60 + index + 1),
    ranks: { 'dense:0': index + 1 },
  }));
}

function cellsFor(model: string, threshold: number): ThresholdCells {
  const key = cellKey('local_bm25', model, 'en', 'same');
  return new Map([
    [
      key,
      {
        key,
        provider: 'local_bm25',
        model,
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

async function run(envOver: Record<string, string>, client: RpcClient | null, hits: FusedHit[] = fused(), profile: Profile = 'chat') {
  const env = { ...BASE_ENV, ...envOver };
  const base = fakeAssemblyAdmin();
  installDeps({
    ragEnv: () => env,
    adminClient: () => {
      if (client === null) return null;
      const admin = base();
      return new Proxy(admin as object, { get: (target, key) => (key === 'rpc' ? client.rpc.bind(client) : Reflect.get(target, key)) }) as never;
    },
  });
  const signal = new AbortController().signal;
  const collector = createTraceCollector({ profile, tenantKey: TENANT });
  const out = await runRankStages({
    input: { scope, query: 'amber tile', profile, signal },
    config: loadRagConfig(env),
    profile,
    embedding: { vector: [0.1], profile: null },
    queryLanguage: 'en',
    fusedHits: hits,
    referenced: null,
    signal,
    collector,
  });
  return { out, record: collector.stages().find((row) => row.name === 'rerank') };
}

describe('rank stage with RAG_RERANK_LOCAL_STATS (04.4-21)', () => {
  beforeEach(() => {
    resetLexstatsCacheForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRerankerFactoryForTests();
    resetLexstatsCacheForTests();
    vi.restoreAllMocks();
  });

  it('pool (unset): no statistics call, model bm25-v2, the detail carries no statistics code', async () => {
    const { client, calls } = routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => statsRows({}) });
    const { out, record } = await run({}, client);
    expect(calls).toEqual([]);
    expect(out.rerank.model).toBe('bm25-v2');
    expect(record?.detail).toBe('local_bm25:bm25-v2');
  });

  it('tenant with ready statistics: one read with the caller scopeKey, model bm25-v3-tenant, detail rerank_stats_tenant', async () => {
    const { client, calls } = routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => statsRows(calls.at(-1)!.args) });
    const { out, record } = await run({ RAG_RERANK_LOCAL_STATS: 'tenant' }, client);
    const reads = calls.filter((c) => c.fn === 'rag_lexical_rerank_stats');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.args).toMatchObject({ p_tenant_key: TENANT, p_doc_types: ['general'], p_languages: ['en'], p_chunking_override: null });
    expect(out.rerank.model).toBe('bm25-v3-tenant');
    expect(record?.detail).toBe(`local_bm25:bm25-v3-tenant;${RERANK_STATS_TENANT}`);
    expect(record?.status).toBe('ok');
  });

  it('tenant: a chunk without language reads the und bucket; a chunk without doc type makes the pool serve', async () => {
    const { client, calls } = routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => statsRows(calls.at(-1)!.args) });
    await run({ RAG_RERANK_LOCAL_STATS: 'tenant' }, client, fused((i) => (i === 2 ? { language: null } : {})));
    expect(calls.find((c) => c.fn === 'rag_lexical_rerank_stats')?.args.p_languages).toEqual(expect.arrayContaining(['en', 'und']));
    resetLexstatsCacheForTests();
    const second = routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => statsRows({}) });
    const { out, record } = await run({ RAG_RERANK_LOCAL_STATS: 'tenant' }, second.client, fused((i) => (i === 2 ? { docType: null } : {})));
    expect(second.calls.filter((c) => c.fn === 'rag_lexical_rerank_stats')).toEqual([]);
    expect(out.rerank.model).toBe('bm25-v2');
    expect(record?.detail).toBe(`local_bm25:bm25-v2;${RERANK_STATS_UNAVAILABLE}`);
  });

  const fallbacks: Array<[string, () => { client: RpcClient | null; calls: Call[] }]> = [
    ['the tenant is not ready', () => routingClient({ rag_lexstats_status: () => ({ data: { state: 'building', chunk_count: 0 }, error: null }) })],
    ['the read fails', () => routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => ({ data: null, error: { message: 'boom' } }) })],
    [
      'the read answers lexical_stats_not_ready',
      () => routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => ({ data: null, error: { message: 'lexical_stats_not_ready: x' } }) }),
    ],
    ['the read rejects', () => routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => Promise.reject(new Error('network')) })],
    ['no admin client', () => ({ client: null, calls: [] })],
  ];
  for (const [name, make] of fallbacks) {
    it(`tenant, ${name}: pool scores, model bm25-v2, detail rerank_stats_unavailable, not a refusal`, async () => {
      const { client } = make();
      const pool = await run({}, routingClient({}).client);
      const { out, record } = await run({ RAG_RERANK_LOCAL_STATS: 'tenant' }, client);
      expect(out.rerank.model).toBe('bm25-v2');
      expect(record?.status).toBe('ok');
      expect(record?.detail).toBe(`local_bm25:bm25-v2;${RERANK_STATS_UNAVAILABLE}`);
      expect([...out.rerank.scoreByChunk.entries()]).toEqual([...pool.out.rerank.scoreByChunk.entries()]);
      expect(out.survivors.map((row) => row.hit.chunkId)).toEqual(pool.out.survivors.map((row) => row.hit.chunkId));
    });
  }

  it('refusal cells: local_bm25 scores are relative, so no cell applies in any mode, and the gate gets the served model', async () => {
    vi.spyOn(thresholds, 'loadThresholds').mockReturnValue({ cells: cellsFor('bm25-v2', 0.5), configHash: null });
    const pool = await run({}, routingClient({}).client);
    expect(pool.out.gate).toMatchObject({ decision: 'not_applied', reason: 'relative_scores' });
    const fallback = await run({ RAG_RERANK_LOCAL_STATS: 'tenant' }, routingClient({ rag_lexstats_status: () => ({ data: null, error: null }) }).client);
    expect(fallback.out.gate).toEqual(pool.out.gate);
    expect(fallback.out.decision).toEqual(pool.out.decision);
    resetLexstatsCacheForTests();
    const { client, calls } = routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => statsRows(calls.at(-1)!.args) });
    const tenant = await run({ RAG_RERANK_LOCAL_STATS: 'tenant' }, client);
    expect(tenant.out.rerank.model).toBe('bm25-v3-tenant');
    expect(tenant.out.gate).toMatchObject({ decision: 'not_applied', reason: 'relative_scores', cellKey: null });
  });

  it('voice: one read per rerank call', async () => {
    const { client, calls } = routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => statsRows(calls.at(-1)!.args) });
    await run({ RAG_RERANK_LOCAL_STATS: 'tenant' }, client, fused(), 'voice');
    expect(calls.filter((c) => c.fn === 'rag_lexical_rerank_stats')).toHaveLength(1);
  });

  it('logs carry a tenant hash and a code only', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await run({ RAG_RERANK_LOCAL_STATS: 'tenant' }, routingClient({ rag_lexstats_status: () => READY, rag_lexical_rerank_stats: () => ({ data: null, error: { message: 'boom' } }) }).client);
    const text = warn.mock.calls.map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ')).join('\n');
    expect(text).toContain('rerank_stats_unavailable');
    for (const word of ['amber', 'tile', TENANT]) expect(text).not.toContain(word);
  });
});
