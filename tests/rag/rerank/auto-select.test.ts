import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests, type RagConfig, type RagEnvInput } from '@/lib/rag/config';
import { deriveStatus } from '@/lib/rag/pipeline';
import {
  AUTO_HOSTED_PROFILES,
  AUTO_NO_KEY_FALLBACK,
  describeReranker,
  resetRerankerFactoryForTests,
  resolveReranker,
  setAutoHostedProfilesForTests,
  setAutoNoKeyFallbackForTests,
  setRerankerFactoryForTests,
} from '@/lib/rag/rerank/select';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { RERANK_TEXT_VERSION, type Reranker } from '@/lib/rag/rerank/types';
import { computeRetrievalConfigHash } from '@/lib/rag/v2/config-hash';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runRankStages } from '@/lib/rag/v2/stages/rank';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import type { Profile, StageOverrides } from '@/lib/rag/types';
import { hit } from '../fusion/helpers';
import { fakeReranker, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const fetch = globalThis.fetch;
const COHERE_KEY = 'cohere-test-placeholder-key-not-real';
const VOYAGE_KEY = 'voyage-test-placeholder-key-not-real';
const MISSING_KEY_WARNING = '[RAG Config] Hosted reranker unavailable, set';

function env(over: Partial<Record<keyof RagEnvInput, string | undefined>> = {}): RagEnvInput {
  const base: Record<string, string | undefined> = {
    RAG_PIPELINE: 'v2',
    RAG_RERANKER: 'auto',
    RAG_RERANK_TIER_CHAT: 'quality',
    RAG_RERANK_TIER_VOICE: 'fast',
    ...over,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) out[key] = value;
  return out as RagEnvInput;
}

function warnedMissingKey(spy: ReturnType<typeof vi.spyOn>): boolean {
  return spy.mock.calls.some((call: unknown[]) => typeof call[0] === 'string' && call[0].startsWith(MISSING_KEY_WARNING));
}

function hashFor(config: RagConfig, profile: Profile, overrides?: Parameters<typeof describeReranker>[3]): string {
  return computeRetrievalConfigHash({
    backendId: 'pgvector',
    embeddingProfileId: 'openai-3-small-1536',
    lexicalVersion: LEXICAL_VERSION,
    rerankTextVersion: RERANK_TEXT_VERSION,
    params: effectiveRetrievalParams(profile, config, null),
    reranker: describeReranker(config, profile, 'en', overrides),
    thresholdsConfigHash: null,
    activeChunkingProfiles: null,
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
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  resetRagConfigForTests();
  resetRerankerFactoryForTests();
  uninstallDeps();
  vi.restoreAllMocks();
});

describe('RAG_RERANKER=auto parse', () => {
  it('parses auto in any case and with surrounding space, without a warning', () => {
    expect(loadRagConfig(env({ RAG_RERANKER: 'auto' })).v2.reranker).toBe('auto');
    resetRagConfigForTests();
    const config = loadRagConfig(env({ RAG_RERANKER: ' AUTO ' }));
    expect(config.v2.reranker).toBe('auto');
    expect(config.warnings).toEqual([]);
    expect(config.disabledStages.has('rerank')).toBe(false);
  });

  it('parses every existing value as before and still warns on unknown values', () => {
    for (const value of ['none', 'cohere', 'voyage', 'local_bm25'] as const) {
      resetRagConfigForTests();
      expect(loadRagConfig(env({ RAG_RERANKER: value })).v2.reranker).toBe(value);
    }
    resetRagConfigForTests();
    expect(loadRagConfig(env({ RAG_RERANKER: '' })).v2.reranker).toBe('none');
    resetRagConfigForTests();
    const bogus = loadRagConfig(env({ RAG_RERANKER: 'automatic' }));
    expect(bogus.v2.reranker).toBe('none');
    expect(bogus.warnings.some((line) => line.includes('Unsupported RAG_RERANKER value'))).toBe(true);
  });
});

describe('resolveReranker under auto', () => {
  it('exports the hosted profile set and the no-key fallback', () => {
    expect([...AUTO_HOSTED_PROFILES].sort()).toEqual(['chat', 'embed', 'eval', 'voice']);
    expect(AUTO_NO_KEY_FALLBACK).toBe('local_bm25');
  });

  it('resolves to Cohere with the tier model when COHERE_API_KEY is set', () => {
    const e = env({ COHERE_API_KEY: COHERE_KEY });
    const config = loadRagConfig(e);
    for (const profile of ['chat', 'embed', 'eval'] as const) {
      const resolved = resolveReranker(config, profile, 'en', undefined, e, fetch);
      expect(resolved).toMatchObject({ provider: 'cohere', model: 'rerank-v5.0-pro', tier: 'quality', auto: true });
      expect(resolved.reason).toBeUndefined();
      expect(resolved.reranker?.id).toBe('cohere');
    }
    const voice = resolveReranker(config, 'voice', 'en', undefined, e, fetch);
    expect(voice).toMatchObject({ provider: 'cohere', model: 'rerank-v5.0-fast', tier: 'fast', auto: true });
    expect(warnedMissingKey(warnSpy)).toBe(false);
  });

  it('gives a profile outside AUTO_HOSTED_PROFILES the no-key fallback even with a key', () => {
    setAutoHostedProfilesForTests(['chat', 'embed', 'eval']);
    const e = env({ COHERE_API_KEY: COHERE_KEY });
    const config = loadRagConfig(e);
    const voice = resolveReranker(config, 'voice', 'en', undefined, e, fetch);
    expect(voice).toMatchObject({ provider: 'local_bm25', model: 'bm25-v2', reason: 'auto_fallback', auto: true });
    expect(voice.reranker?.id).toBe('local_bm25');
    expect(resolveReranker(config, 'chat', 'en', undefined, e, fetch).provider).toBe('cohere');
  });

  it('falls back to local_bm25 without a Cohere key, and a Voyage key alone never selects Voyage', () => {
    const e = env({ VOYAGE_API_KEY: VOYAGE_KEY });
    const config = loadRagConfig(e);
    const chat = resolveReranker(config, 'chat', 'en', undefined, e, fetch);
    expect(chat).toMatchObject({ provider: 'local_bm25', model: 'bm25-v2', reason: 'auto_fallback', auto: true });
    expect(chat.reranker?.id).toBe('local_bm25');
    expect(chat.reranker?.scoreSemantics).toBe('relative');
    expect(warnedMissingKey(warnSpy)).toBe(false);
  });

  it('falls back to no rerank when AUTO_NO_KEY_FALLBACK is none', () => {
    setAutoNoKeyFallbackForTests('none');
    const e = env();
    const config = loadRagConfig(e);
    const chat = resolveReranker(config, 'chat', 'en', undefined, e, fetch);
    expect(chat).toMatchObject({ provider: 'none', model: null, reranker: null, reason: 'auto_fallback', auto: true });
    expect(warnedMissingKey(warnSpy)).toBe(false);
  });

  it('lets eval overrides of reranker and model win over auto', () => {
    const e = env({ COHERE_API_KEY: COHERE_KEY, VOYAGE_API_KEY: VOYAGE_KEY });
    const config = loadRagConfig(e);
    const explicit = resolveReranker(config, 'eval', 'en', { reranker: 'voyage', rerankModel: 'fake-fast-v1' }, e, fetch);
    expect(explicit).toMatchObject({ provider: 'voyage', model: 'fake-fast-v1' });
    expect(explicit.auto).toBeUndefined();
    const modelOnly = resolveReranker(config, 'eval', 'en', { rerankModel: 'fake-quality-v1' }, e, fetch);
    expect(modelOnly).toMatchObject({ provider: 'cohere', model: 'fake-quality-v1', auto: true });
    expect(describeReranker(config, 'eval', 'en', { reranker: 'none' })).toEqual({ id: 'none', model: 'none' });
  });

  it('keeps explicit cohere and voyage without a key on the missing-key path', () => {
    const cohere = env({ RAG_RERANKER: 'cohere' });
    const cohereResolved = resolveReranker(loadRagConfig(cohere), 'chat', 'en', undefined, cohere, fetch);
    expect(cohereResolved).toMatchObject({ provider: 'cohere', reason: 'missing_key', reranker: null });
    expect(cohereResolved.auto).toBeUndefined();
    resetRagConfigForTests();
    const voyage = env({ RAG_RERANKER: 'voyage' });
    expect(resolveReranker(loadRagConfig(voyage), 'chat', 'en', undefined, voyage, fetch)).toMatchObject({
      provider: 'voyage',
      reason: 'missing_key',
    });
    expect(warnedMissingKey(warnSpy)).toBe(true);
  });
});

describe('describeReranker and the config hash under auto', () => {
  it('records the resolved provider and model, never auto', () => {
    const keyed = loadRagConfig(env({ COHERE_API_KEY: COHERE_KEY }));
    expect(describeReranker(keyed, 'chat', 'en')).toEqual({ id: 'cohere', model: 'rerank-v5.0-pro' });
    expect(describeReranker(keyed, 'voice', 'en')).toEqual({ id: 'cohere', model: 'rerank-v5.0-fast' });
    expect(JSON.stringify(describeReranker(keyed, 'chat', 'en'))).not.toContain(COHERE_KEY);
    resetRagConfigForTests();
    const keyless = loadRagConfig(env());
    expect(describeReranker(keyless, 'chat', 'en')).toEqual({ id: 'local_bm25', model: 'bm25-v2' });
    setAutoNoKeyFallbackForTests('none');
    expect(describeReranker(keyless, 'chat', 'en')).toEqual({ id: 'none', model: 'none' });
  });

  it('auto hashes as its resolved provider', () => {
    const autoKeyless = loadRagConfig(env());
    resetRagConfigForTests();
    const explicitLocal = loadRagConfig(env({ RAG_RERANKER: 'local_bm25' }));
    expect(hashFor(autoKeyless, 'chat')).toBe(hashFor(explicitLocal, 'chat'));

    resetRagConfigForTests();
    const autoKeyed = loadRagConfig(env({ COHERE_API_KEY: COHERE_KEY }));
    resetRagConfigForTests();
    const explicitCohere = loadRagConfig(env({ RAG_RERANKER: 'cohere', COHERE_API_KEY: COHERE_KEY }));
    expect(hashFor(autoKeyed, 'chat')).toBe(hashFor(explicitCohere, 'chat'));
    expect(hashFor(autoKeyed, 'voice')).toBe(hashFor(explicitCohere, 'voice'));
    expect(hashFor(autoKeyed, 'chat')).not.toBe(hashFor(autoKeyless, 'chat'));
  });
});

const scope = mintScope('single', null, null);
const EVAL_FAKE_MODEL: StageOverrides = { retrievalOverrides: { rerankModel: 'fake-quality-v1' } };

function fusedHits(count: number): FusedHit[] {
  return Array.from({ length: count }, (_, index) => ({
    hit: hit(`c${index}`, { rank: index + 1, documentId: `d${index}`, similarity: 0.9, content: `body ${index} sample text` }),
    score: 1 / (60 + index + 1),
    ranks: { 'dense:0': index + 1 },
  }));
}

function stageEnv(over: Record<string, string | undefined> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = {
    RAG_PIPELINE: 'v2',
    RAG_LEXICAL_SEARCH: 'false',
    RAG_RERANKER: 'auto',
    RAG_REFUSAL_THRESHOLD: 'true',
    ...over,
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) out[key] = value;
  return out;
}

async function rank(envValues: Record<string, string>, stageOverrides?: StageOverrides, profile: Profile = 'eval') {
  uninstallDeps();
  installDeps({ ragEnv: () => envValues });
  const hits = fusedHits(4);
  const signal = new AbortController().signal;
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const out = await runRankStages({
    input: { scope, query: 'sample text', profile, signal },
    config: loadRagConfig(envValues),
    profile,
    embedding: { vector: [0.1], profile: null },
    queryLanguage: 'en',
    fusedHits: hits,
    referenced: null,
    signal,
    collector,
    stageOverrides,
  });
  const record = collector.stages().find((row) => row.name === 'rerank');
  return { out, record, status: deriveStatus(collector.stages(), out.survivors.length), hits };
}

describe('rerank stage under auto', () => {
  it('reranks with the local fallback when no key is set: ok, auto:local_bm25, not degraded, no warning', async () => {
    const { out, record, status } = await rank(stageEnv());
    expect(record).toMatchObject({ status: 'ok', detail: 'auto:local_bm25' });
    expect(out.rerank).toMatchObject({ ran: true, status: 'ok', provider: 'local_bm25', model: 'bm25-v2' });
    expect(out.gate).toMatchObject({ decision: 'not_applied', reason: 'relative_scores' });
    expect(status).not.toBe('degraded');
    expect(warnedMissingKey(warnSpy)).toBe(false);
  });

  it('is disabled with detail auto:none when the fallback is none, and not degraded', async () => {
    setAutoNoKeyFallbackForTests('none');
    const factory = vi.fn();
    setRerankerFactoryForTests(factory);
    const { out, record, status, hits } = await rank(stageEnv());
    expect(record).toMatchObject({ status: 'disabled', detail: 'auto:none' });
    expect(factory).not.toHaveBeenCalled();
    expect(out.rerank).toMatchObject({ ran: false, status: 'disabled', provider: 'none' });
    expect(out.survivors.map((row) => row.hit.chunkId)).toEqual(hits.map((row) => row.hit.chunkId));
    expect(out.gate.reason).toBe('reranker_disabled');
    expect(status).not.toBe('degraded');
    expect(warnedMissingKey(warnSpy)).toBe(false);
  });

  it('behaves as explicit cohere when the key is set, with detail auto:cohere', async () => {
    setRerankerFactoryForTests(() => fakeReranker({ model: 'fake-quality-v1' }).reranker);
    const keyed = await rank(stageEnv({ COHERE_API_KEY: COHERE_KEY }), EVAL_FAKE_MODEL);
    expect(keyed.record).toMatchObject({ status: 'ok', detail: 'auto:cohere' });
    expect(keyed.record?.detail).not.toContain(COHERE_KEY);
    expect(keyed.out.rerank).toMatchObject({ ran: true, provider: 'cohere', model: 'fake-quality-v1' });

    resetRagConfigForTests();
    const explicit = await rank(stageEnv({ RAG_RERANKER: 'cohere', COHERE_API_KEY: COHERE_KEY }), EVAL_FAKE_MODEL);
    expect(explicit.record).toMatchObject({ status: 'ok', detail: 'cohere:fake-quality-v1' });
    expect(keyed.out.survivors.map((row) => row.hit.chunkId)).toEqual(explicit.out.survivors.map((row) => row.hit.chunkId));
    expect(keyed.out.decision).toEqual(explicit.out.decision);
    expect(keyed.status).toBe(explicit.status);
  });

  it('still skips and degrades on a Cohere timeout under auto, and the floor decides', async () => {
    setRerankerFactoryForTests(() => fakeReranker({ delayMs: 200, model: 'fake-quality-v1' }).reranker);
    const { out, record, status } = await rank(
      stageEnv({ COHERE_API_KEY: COHERE_KEY, RAG_STAGE_TIMEOUTS: 'rerank=25' }),
      EVAL_FAKE_MODEL,
    );
    expect(record).toMatchObject({ status: 'skipped', reason: 'timeout' });
    expect(out.rerank.ran).toBe(false);
    expect(out.gate).toMatchObject({ decision: 'not_applied', reason: 'reranker_unavailable' });
    expect(out.decision).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor' });
    expect(status).toBe('degraded');
  });

  it('leaves explicit cohere without a key on the missing-key path', async () => {
    const fetchSpy = vi.fn();
    uninstallDeps();
    const envValues = stageEnv({ RAG_RERANKER: 'cohere' });
    installDeps({ ragEnv: () => envValues, fetch: fetchSpy as unknown as typeof globalThis.fetch });
    const signal = new AbortController().signal;
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const out = await runRankStages({
      input: { scope, query: 'sample text', profile: 'eval', signal },
      config: loadRagConfig(envValues),
      profile: 'eval',
      embedding: { vector: [0.1], profile: null },
      queryLanguage: 'en',
      fusedHits: fusedHits(3),
      referenced: null,
      signal,
      collector,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(collector.stages().find((row) => row.name === 'rerank')).toMatchObject({ status: 'skipped', detail: 'missing_key' });
    expect(deriveStatus(collector.stages(), out.survivors.length)).toBe('degraded');
    expect(warnedMissingKey(warnSpy)).toBe(true);
  });
});
