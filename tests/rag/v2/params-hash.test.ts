import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { setRagDepsForTests, resetRagDepsForTests } from '@/lib/rag/deps';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';
import { RetrievalParamsSchema, type RetrievalOverrides, type RetrievalParams } from '@/lib/rag-eval/contracts.generated';
import rawCommitted from '../../../eval/config/retrieval-params.json';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { v2ProfileSettings } from '@/lib/rag/v2/profiles';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';
import {
  getActiveChunkingProfiles,
  refreshActiveChunkingProfiles,
  resetActiveChunkingProfilesForTests,
  setActiveChunkingProfilesForTests,
} from '@/lib/rag/chunking/active';

const COMMITTED = RetrievalParamsSchema.parse(rawCommitted);

function baseConfig(overrides: Record<string, string> = {}): RagConfig {
  return loadRagConfig({
    RAG_PIPELINE: 'v2',
    RAG_CONTEXT_TOKEN_BUDGET: '7500',
    RAG_CONTEXT_COMPRESSION: 'true',
    RAG_RERANK_TIER_CHAT: 'quality',
    RAG_RERANK_TIER_VOICE: 'fast',
    ...overrides,
  });
}

function baseHashInput(chunking: Record<string, string> | null = { pdf: 'legacy-pdf' }): RetrievalConfigHashInput {
  const config = baseConfig();
  const params = effectiveRetrievalParams('chat', config, null);
  return {
    backendId: 'pgvector',
    embeddingProfileId: 'openai-3-small-1536',
    lexicalVersion: LEXICAL_VERSION,
    rerankTextVersion: RERANK_TEXT_VERSION,
    params,
    reranker: { id: config.v2.reranker, model: 'none' },
    thresholdsConfigHash: 'abcd'.repeat(16),
    activeChunkingProfiles: chunking,
    switches: {
      lexicalSearch: config.v2.lexicalSearch,
      refusalThreshold: config.v2.refusalThreshold,
      edgeOrder: config.v2.edgeOrder,
      compression: config.v2.compression,
      tokenBudget: config.v2.tokenBudget,
      parentChild: config.v2.parentChild,
      iterativeScan: config.v2.iterativeScan,
      exactScanCutoff: config.v2.exactScanCutoff,
      lexicalTranslation: config.v2.lexicalTranslation,
      exactIdLookup: config.exactIdLookup,
      rerankTierChat: config.v2.rerankTier.chat,
      rerankTierVoice: config.v2.rerankTier.voice,
    },
  };
}

describe('effectiveRetrievalParams', () => {
  beforeEach(() => {
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagConfigForTests();
  });

  it('returns committed file defaults for chat', () => {
    const params = effectiveRetrievalParams('chat', baseConfig(), null);
    expect(params.candidate_pool_size).toBe(COMMITTED.candidate_pool_size);
    expect(params.rerank_input_cap).toBe(COMMITTED.rerank_input_cap);
    expect(params.final_top_k).toBe(COMMITTED.final_top_k);
  });

  it('applies RAG_RETRIEVAL_PARAMS_OVERRIDE to every profile', () => {
    const config = baseConfig({ RAG_RETRIEVAL_PARAMS_OVERRIDE: 'topk=12' });
    expect(effectiveRetrievalParams('chat', config, null).final_top_k).toBe(12);
    expect(effectiveRetrievalParams('voice', config, null).final_top_k).toBe(12);
    expect(effectiveRetrievalParams('embed', config, null).final_top_k).toBe(12);
  });

  it('applies retrieval_overrides only for eval', () => {
    const config = baseConfig();
    const overrides: RetrievalOverrides = { final_top_k: 5, candidate_pool_size: null, rerank_input_cap: null, rrf_k: null, leg_weights: null, rerank_model: null };
    expect(effectiveRetrievalParams('eval', config, overrides).final_top_k).toBe(5);
    expect(effectiveRetrievalParams('chat', config, overrides).final_top_k).toBe(COMMITTED.final_top_k);
    expect(effectiveRetrievalParams('embed', config, overrides).final_top_k).toBe(COMMITTED.final_top_k);
    expect(effectiveRetrievalParams('voice', config, overrides).final_top_k).toBe(COMMITTED.final_top_k);
  });

  it('rejects rerank_input_cap outside 50..100 and keeps the prior value', () => {
    const config = baseConfig();
    const overrides: RetrievalOverrides = {
      rerank_input_cap: 120,
      candidate_pool_size: null,
      final_top_k: null,
      rrf_k: null,
      leg_weights: null,
      rerank_model: null,
    };
    expect(effectiveRetrievalParams('eval', config, overrides).rerank_input_cap).toBe(COMMITTED.rerank_input_cap);
    const warnSpy = console.warn as ReturnType<typeof vi.spyOn>;
    const configWarns = (call: unknown[]) => String(call[0]).includes('[RAG Config]');
    const warns = warnSpy.mock.calls.filter(configWarns);
    expect(warns.length).toBe(1);
    effectiveRetrievalParams('eval', config, overrides);
    expect(warnSpy.mock.calls.filter(configWarns).length).toBe(1);
  });
});

describe('v2ProfileSettings', () => {
  beforeEach(() => resetRagConfigForTests());
  afterEach(() => resetRagConfigForTests());

  it('sets voice tier, budget, deadline and rerank budget fields', () => {
    const config = baseConfig({ RAG_RERANK_TIER_VOICE: 'fast' });
    const s = v2ProfileSettings('voice', config);
    expect(s.rerankTier).toBe('fast');
    expect(s.tokenBudget).toBe(2000);
    expect(s.compression).toBe(false);
    expect(s.deadlineMs).toBe(800);
    expect(s.rerankReserveMs).toBe(50);
    expect(s.rerankFloorMs).toBe(80);
  });

  it('sets chat tier and budget from config switches', () => {
    const config = baseConfig({ RAG_CONTEXT_TOKEN_BUDGET: '9000', RAG_CONTEXT_COMPRESSION: 'true', RAG_RERANK_TIER_CHAT: 'quality' });
    const s = v2ProfileSettings('chat', config);
    expect(s.rerankTier).toBe('quality');
    expect(s.tokenBudget).toBe(9000);
    expect(s.compression).toBe(true);
    expect(s.deadlineMs).toBeNull();
    expect(s.rerankReserveMs).toBeNull();
    expect(s.rerankFloorMs).toBeNull();
  });

  it('makes embed and eval follow chat settings', () => {
    const config = baseConfig({ RAG_CONTEXT_TOKEN_BUDGET: '6400' });
    const chat = v2ProfileSettings('chat', config);
    expect(v2ProfileSettings('embed', config)).toEqual(chat);
    expect(v2ProfileSettings('eval', config)).toEqual(chat);
  });
});

describe('computeRetrievalConfigHash', () => {
  it('is stable for equivalent inputs regardless of construction order', () => {
    const a = baseHashInput();
    const b: RetrievalConfigHashInput = {
      switches: { ...a.switches },
      params: { ...a.params },
      reranker: { ...a.reranker },
      activeChunkingProfiles: { ...a.activeChunkingProfiles! },
      thresholdsConfigHash: a.thresholdsConfigHash,
      rerankTextVersion: a.rerankTextVersion,
      lexicalVersion: a.lexicalVersion,
      embeddingProfileId: a.embeddingProfileId,
      backendId: a.backendId,
    };
    expect(computeRetrievalConfigHash(a)).toBe(computeRetrievalConfigHash(b));
  });

  it('changes when any single hash part changes', () => {
    const base = computeRetrievalConfigHash(baseHashInput());
    const parts: Array<(input: RetrievalConfigHashInput) => RetrievalConfigHashInput> = [
      (i) => ({ ...i, backendId: 'qdrant' }),
      (i) => ({ ...i, embeddingProfileId: 'voyage-profile' }),
      (i) => ({ ...i, lexicalVersion: i.lexicalVersion + 1 }),
      (i) => ({
        ...i,
        params: { ...i.params, final_top_k: i.params.final_top_k + 1 } as RetrievalParams,
      }),
      (i) => ({ ...i, reranker: { id: 'cohere', model: 'rerank-v5.0-fast' } }),
      (i) => ({ ...i, rerankTextVersion: i.rerankTextVersion + 1 }),
      (i) => ({ ...i, activeChunkingProfiles: { pdf: 'other' } }),
      (i) => ({ ...i, switches: { ...i.switches, lexicalSearch: !i.switches.lexicalSearch } }),
    ];
    for (const mutate of parts) {
      expect(computeRetrievalConfigHash(mutate(baseHashInput()))).not.toBe(base);
    }
  });

  it('counts the thresholds file only while the refusal threshold switch is on', () => {
    const on = (i: RetrievalConfigHashInput): RetrievalConfigHashInput => ({
      ...i,
      switches: { ...i.switches, refusalThreshold: true },
    });
    const off = (i: RetrievalConfigHashInput): RetrievalConfigHashInput => ({
      ...i,
      switches: { ...i.switches, refusalThreshold: false },
    });
    const other = (i: RetrievalConfigHashInput): RetrievalConfigHashInput => ({ ...i, thresholdsConfigHash: 'eeee'.repeat(16) });
    expect(computeRetrievalConfigHash(other(on(baseHashInput())))).not.toBe(computeRetrievalConfigHash(on(baseHashInput())));
    expect(computeRetrievalConfigHash(other(off(baseHashInput())))).toBe(computeRetrievalConfigHash(off(baseHashInput())));
    expect(computeRetrievalConfigHash({ ...off(baseHashInput()), thresholdsConfigHash: null })).toBe(
      computeRetrievalConfigHash(off(baseHashInput())),
    );
  });

  it('hashes unavailable chunking differently from an empty map', () => {
    const empty = computeRetrievalConfigHash(baseHashInput({}));
    const unavailable = computeRetrievalConfigHash(baseHashInput(null));
    expect(empty).not.toBe(unavailable);
  });
});

describe('getActiveChunkingProfiles', () => {
  let now: number;
  const rpc = vi.fn();

  beforeEach(() => {
    now = 1_000_000;
    rpc.mockReset();
    resetRagDepsForTests();
    resetActiveChunkingProfilesForTests();
    setRagDepsForTests({
      now: () => now,
      adminClient: () => ({ rpc }) as unknown as SupabaseClient,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagDepsForTests();
    resetActiveChunkingProfilesForTests();
  });

  it('calls the RPC once within 30s then again after TTL', async () => {
    rpc.mockResolvedValue({
      data: [{ doc_type: 'pdf', id: 'legacy-pdf', is_active: true }],
      error: null,
    });
    await getActiveChunkingProfiles();
    await getActiveChunkingProfiles();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('rag_list_chunking_profiles', {});
    now += 30_001;
    await getActiveChunkingProfiles();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('returns null on RPC error and logs one line with the code only', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST123' } });
    expect(await getActiveChunkingProfiles()).toBeNull();
    const chunkWarnSpy = console.warn as ReturnType<typeof vi.spyOn>;
    const chunkingWarn = (call: unknown[]) => String(call[0]).includes('[RAG Chunking]');
    const warns = chunkWarnSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
    expect(warns).toMatch(/\[RAG Chunking\]/);
    expect(warns).toMatch(/PGRST123/);
    expect(warns).not.toMatch(/content|secret/i);
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST123' } });
    await getActiveChunkingProfiles();
    expect(chunkWarnSpy.mock.calls.filter(chunkingWarn).length).toBe(1);
  });

  it('refreshActiveChunkingProfiles forces the next read to hit the RPC', async () => {
    rpc.mockResolvedValue({ data: [{ doc_type: 'pdf', id: 'legacy-pdf', is_active: true }], error: null });
    await getActiveChunkingProfiles();
    rpc.mockResolvedValue({ data: [{ doc_type: 'pdf', id: 'next-pdf', is_active: true }], error: null });
    const refreshed = await refreshActiveChunkingProfiles();
    expect(refreshed).toEqual({ pdf: 'next-pdf' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('returns null without an RPC when adminClient is missing', async () => {
    resetRagDepsForTests();
    setRagDepsForTests({ adminClient: () => null });
    expect(await getActiveChunkingProfiles()).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('allows tests to seed the cache without an RPC', async () => {
    setActiveChunkingProfilesForTests({ pdf: 'seeded' });
    const map = await getActiveChunkingProfiles();
    expect(map).toEqual({ pdf: 'seeded' });
    expect(rpc).not.toHaveBeenCalled();
  });
});
describe('eval chunking override in the retrieval config hash', () => {
  it('the eval override replaces the active pointer for its doc type and only for the eval profile', async () => {
    const { hashedChunkingProfiles } = await import('@/lib/rag/v2/overrides');
    const active = { contract_legal: 'legacy', general: 'legacy' };
    const override = { chunkingProfileByDocType: { contract_legal: 'p256-1024-contract_legal' } };
    expect(hashedChunkingProfiles('eval', active, override)).toEqual({ contract_legal: 'p256-1024-contract_legal', general: 'legacy' });
    expect(hashedChunkingProfiles('chat', active, override)).toBe(active);
    expect(hashedChunkingProfiles('eval', active, undefined)).toBe(active);
    expect(hashedChunkingProfiles('eval', null, undefined)).toBeNull();
    expect(hashedChunkingProfiles('eval', null, override)).toEqual({ contract_legal: 'p256-1024-contract_legal' });
    const withOverride = computeRetrievalConfigHash({ ...baseHashInput(), activeChunkingProfiles: hashedChunkingProfiles('eval', active, override) });
    const without = computeRetrievalConfigHash({ ...baseHashInput(), activeChunkingProfiles: hashedChunkingProfiles('eval', active, undefined) });
    expect(withOverride).not.toBe(without);
  });
});
