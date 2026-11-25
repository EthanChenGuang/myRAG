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
import { computeRetrievalConfigHash, securityHashComponent, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';
import { readSecurityConfig } from '@/lib/rag/security/config';
import { describeReranker } from '@/lib/rag/rerank/select';
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
    reranker: describeReranker(config, 'chat', ''),
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

/** A hash input built only from literals, so the pinned value does not move with the committed params file. */
function literalHashInput(): RetrievalConfigHashInput {
  return {
    backendId: 'pgvector',
    embeddingProfileId: 'openai-3-small-1536',
    lexicalVersion: 1,
    rerankTextVersion: 1,
    params: {
      candidate_pool_size: 75,
      config_hash: 'a808a46f380d35f92c15bd2fb19d37a13b02c7827372c73e4dd76480714433f7',
      final_top_k: 8,
      leg_weights: { dense: 1, exact_id: 1, lexical: 1 },
      provenance: { source: 'defaults' },
      rerank_input_cap: 75,
      rrf_k: 60,
      schema_version: 1,
      sub_question_coverage: true,
    } as RetrievalParams,
    reranker: { id: 'none', model: 'none' },
    thresholdsConfigHash: null,
    activeChunkingProfiles: { general: 'legacy' },
    switches: {
      lexicalSearch: false,
      refusalThreshold: false,
      edgeOrder: false,
      compression: false,
      tokenBudget: 6000,
      parentChild: false,
      iterativeScan: 'off',
      exactScanCutoff: 0,
      lexicalTranslation: false,
      exactIdLookup: false,
      rerankTierChat: 'quality',
      rerankTierVoice: 'fast',
    },
  };
}

/** The hash of literalHashInput() before the security component existed (05.1-14 base). */
const PINNED_DEFAULT_HASH = 'f0bbcf06e9a792e368b2bcf880adf10f17336aa167a2c9fe5597198df3fc4fac';

const SECURITY_DEFAULT = {
  contextTagging: false,
  injectionCheck: 'off',
  promptGuard: false,
  lakera: false,
  lakeraMultiTenantAck: false,
  lakeraEffective: false,
  toolResultGuard: 'off',
  rulesVersion: 'rules-v1',
  detectorsVersion: 'detectors-v1',
} as const;

describe('computeRetrievalConfigHash security component (D-18)', () => {
  it('with no security component the hash equals the pinned pre-5.1 value', () => {
    expect(computeRetrievalConfigHash(literalHashInput())).toBe(PINNED_DEFAULT_HASH);
    expect(computeRetrievalConfigHash({ ...literalHashInput(), security: null })).toBe(PINNED_DEFAULT_HASH);
  });

  it('a security component changes the hash, and each single change gives a distinct hash', () => {
    const variants = [
      { ...SECURITY_DEFAULT, contextTagging: true },
      { ...SECURITY_DEFAULT, injectionCheck: 'flag' },
      { ...SECURITY_DEFAULT, injectionCheck: 'drop' },
      { ...SECURITY_DEFAULT, injectionCheck: 'downweight' },
      { ...SECURITY_DEFAULT, promptGuard: true },
      { ...SECURITY_DEFAULT, lakera: true },
      { ...SECURITY_DEFAULT, lakeraMultiTenantAck: true },
      { ...SECURITY_DEFAULT, lakeraEffective: true },
      { ...SECURITY_DEFAULT, toolResultGuard: 'tag' },
      { ...SECURITY_DEFAULT, rulesVersion: 'rules-v2' },
      { ...SECURITY_DEFAULT, detectorsVersion: 'detectors-v2' },
    ] as const;
    const hashes = variants.map((security) => computeRetrievalConfigHash({ ...literalHashInput(), security }));
    expect(new Set([...hashes, PINNED_DEFAULT_HASH]).size).toBe(variants.length + 1);
  });
});

describe('securityHashComponent (D-18, plan-check W2)', () => {
  const VERSIONS = { rulesVersion: 'rules-v1', detectorsVersion: 'detectors-v1' };
  const hashFor = (env: Record<string, string>, multiTenant: boolean, versions: { rulesVersion: string; detectorsVersion: string } = VERSIONS) =>
    computeRetrievalConfigHash({ ...literalHashInput(), security: securityHashComponent(readSecurityConfig(env), { multiTenant, ...versions }) });
  const LAKERA_ON = { RAG_INJECTION_CHECK: 'drop', RAG_INJECTION_LAKERA: 'true', LAKERA_GUARD_API_KEY: 'placeholder-key' };

  it('is null with every switch at its default, so the hash is the pinned value in both deployment modes', () => {
    expect(securityHashComponent(readSecurityConfig({}), { multiTenant: false })).toBeNull();
    expect(hashFor({}, false)).toBe(PINNED_DEFAULT_HASH);
    expect(hashFor({}, true)).toBe(PINNED_DEFAULT_HASH);
    expect(hashFor({ LAKERA_GUARD_API_KEY: 'placeholder-key', LAKERA_GUARD_BASE_URL: 'https://guard.example.test' }, true)).toBe(PINNED_DEFAULT_HASH);
  });

  it('gives a distinct hash for each single switch change', () => {
    const envs: Array<Record<string, string>> = [
      { RAG_CONTEXT_TAGGING: 'true' },
      { RAG_INJECTION_CHECK: 'flag' },
      { RAG_INJECTION_CHECK: 'drop' },
      { RAG_INJECTION_CHECK: 'downweight' },
      { RAG_INJECTION_PROMPT_GUARD: 'true' },
      { RAG_INJECTION_LAKERA: 'true' },
      { RAG_TOOL_RESULT_GUARD: 'tag' },
      { RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true' },
    ];
    const hashes = envs.map((env) => hashFor(env, false));
    expect(new Set([...hashes, PINNED_DEFAULT_HASH]).size).toBe(envs.length + 1);
  });

  it("multi-tenant: the acknowledgement and the key move Lakera's effective state and the hash", () => {
    const acked = securityHashComponent(readSecurityConfig({ ...LAKERA_ON, RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true' }), { multiTenant: true, ...VERSIONS });
    const unacked = securityHashComponent(readSecurityConfig(LAKERA_ON), { multiTenant: true, ...VERSIONS });
    expect(acked?.lakeraEffective).toBe(true);
    expect(unacked?.lakeraEffective).toBe(false);
    expect(hashFor({ ...LAKERA_ON, RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true' }, true)).not.toBe(hashFor(LAKERA_ON, true));

    const { LAKERA_GUARD_API_KEY: _key, ...noKey } = { ...LAKERA_ON, RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true' };
    expect(securityHashComponent(readSecurityConfig(noKey), { multiTenant: true, ...VERSIONS })?.lakeraEffective).toBe(false);
    expect(hashFor(noKey, true)).not.toBe(hashFor({ ...LAKERA_ON, RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true' }, true));
  });

  it('single-tenant: the acknowledgement does not change the effective state but is still part of the component', () => {
    const acked = securityHashComponent(readSecurityConfig({ ...LAKERA_ON, RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true' }), { multiTenant: false, ...VERSIONS });
    const unacked = securityHashComponent(readSecurityConfig(LAKERA_ON), { multiTenant: false, ...VERSIONS });
    expect(acked?.lakeraEffective).toBe(true);
    expect(unacked?.lakeraEffective).toBe(true);
    expect(acked?.lakeraMultiTenantAck).toBe(true);
    expect(hashFor({ ...LAKERA_ON, RAG_INJECTION_LAKERA_MULTI_TENANT_ACK: 'true' }, false)).not.toBe(hashFor(LAKERA_ON, false));
  });

  it('never carries the key, only its presence through the effective state', () => {
    const component = securityHashComponent(readSecurityConfig(LAKERA_ON), { multiTenant: false, ...VERSIONS });
    expect(JSON.stringify(component)).not.toContain('placeholder-key');
  });

  it('the rules and detector versions move the hash while the check is on and not while every switch is off', () => {
    const on = { RAG_INJECTION_CHECK: 'drop' };
    expect(hashFor(on, false, { ...VERSIONS, rulesVersion: 'rules-v2' })).not.toBe(hashFor(on, false));
    expect(hashFor(on, false, { ...VERSIONS, detectorsVersion: 'detectors-v2' })).not.toBe(hashFor(on, false));
    expect(hashFor({}, false, { ...VERSIONS, rulesVersion: 'rules-v2' })).toBe(PINNED_DEFAULT_HASH);
    expect(hashFor({}, false, { ...VERSIONS, detectorsVersion: 'detectors-v2' })).toBe(PINNED_DEFAULT_HASH);
  });

  it('reads the real rules and detector config versions when none are given', () => {
    const component = securityHashComponent(readSecurityConfig({ RAG_INJECTION_CHECK: 'flag' }), { multiTenant: false });
    expect(component?.rulesVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(component?.detectorsVersion).toMatch(/\S/);
  });
});

describe('computeRetrievalConfigHash binding legs (03.1.1-09)', () => {
  beforeEach(() => {
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRagConfigForTests();
  });

  it('is unchanged without a planned leg and changes with the binding map or the control leg', () => {
    const base = computeRetrievalConfigHash(baseHashInput());
    expect(computeRetrievalConfigHash({ ...baseHashInput(), embeddingBindings: {} })).toBe(base);
    expect(computeRetrievalConfigHash({ ...baseHashInput(), embeddingBindings: null, domainControlLeg: null })).toBe(base);
    const law = computeRetrievalConfigHash({ ...baseHashInput(), embeddingBindings: { contract_legal: 'voyage-law-2-1024' } });
    const domain = computeRetrievalConfigHash({ ...baseHashInput(), embeddingBindings: { contract_legal: 'voyage-4-large-1024-domain' } });
    const control = computeRetrievalConfigHash({ ...baseHashInput(), domainControlLeg: 'contract_legal' });
    expect(new Set([base, law, domain, control]).size).toBe(4);
  });
});
