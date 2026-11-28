import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import type { RagEnvInput } from '@/lib/rag/config';
import type { RetrievalOverrides } from '@/lib/rag/types';
import {
  resetRerankerFactoryForTests,
  resolveReranker,
  setRerankerFactoryForTests,
} from '@/lib/rag/rerank/select';
import type { Reranker } from '@/lib/rag/rerank/types';

const fetch = globalThis.fetch;

function baseEnv(over: Partial<RagEnvInput> = {}): RagEnvInput {
  return {
    RAG_PIPELINE: 'v2',
    RAG_RERANKER: 'cohere',
    RAG_RERANK_TIER_CHAT: 'quality',
    RAG_RERANK_TIER_VOICE: 'fast',
    COHERE_API_KEY: 'cohere-test-key-not-real-32charsxxxxxxxx',
    VOYAGE_API_KEY: 'voyage-test-key-not-real-32charsxxxxxxx',
    ...over,
  };
}

afterEach(() => {
  resetRagConfigForTests();
  resetRerankerFactoryForTests();
  vi.restoreAllMocks();
});

describe('resolveReranker tiers and models', () => {
  it('uses the chat rerank tier for embed and the voice tier for voice', () => {
    const env = baseEnv({ RAG_RERANK_TIER_CHAT: 'quality', RAG_RERANK_TIER_VOICE: 'fast' });
    const config = loadRagConfig(env);
    const embed = resolveReranker(config, 'embed', 'en', undefined, env, fetch);
    expect(embed.tier).toBe('quality');
    const voice = resolveReranker(config, 'voice', 'en', undefined, env, fetch);
    expect(voice.tier).toBe('fast');
  });

  it('maps cohere chat quality to rerank-v5.0-pro and voice fast to rerank-v5.0-fast', () => {
    const config = loadRagConfig(baseEnv());
    const chat = resolveReranker(config, 'chat', 'en', undefined, baseEnv(), fetch);
    expect(chat.provider).toBe('cohere');
    expect(chat.tier).toBe('quality');
    expect(chat.model).toBe('rerank-v5.0-pro');
    expect(chat.reranker).not.toBeNull();

    const voice = resolveReranker(
      config,
      'voice',
      'en',
      undefined,
      baseEnv({ RAG_RERANK_TIER_VOICE: 'fast' }),
      fetch,
    );
    expect(voice.tier).toBe('fast');
    expect(voice.model).toBe('rerank-v5.0-fast');
  });

  it('maps voyage quality zh override to rerank-2.5 and fast to rerank-3-lite', () => {
    const env = baseEnv({
      RAG_RERANKER: 'voyage',
      RAG_RERANK_VOYAGE_MODEL_BY_LANG: 'zh=rerank-2.5',
    });
    const config = loadRagConfig(env);
    const zh = resolveReranker(config, 'chat', 'zh', undefined, env, fetch);
    expect(zh.provider).toBe('voyage');
    expect(zh.model).toBe('rerank-2.5');

    const itQuality = resolveReranker(config, 'chat', 'it', undefined, env, fetch);
    expect(itQuality.model).toBe('rerank-3');

    const fastEnv = { ...env, RAG_RERANK_TIER_CHAT: 'fast' };
    const fastConfig = loadRagConfig(fastEnv);
    const fast = resolveReranker(fastConfig, 'chat', 'zh', undefined, fastEnv, fetch);
    expect(fast.model).toBe('rerank-3-lite');
  });

  it('returns local_bm25 with relative semantics and none with reason disabled', () => {
    const localEnv = baseEnv({ RAG_RERANKER: 'local_bm25' });
    const localConfig = loadRagConfig(localEnv);
    const local = resolveReranker(localConfig, 'embed', 'en', undefined, localEnv, fetch);
    expect(local.provider).toBe('local_bm25');
    expect(local.reranker?.id).toBe('local_bm25');
    expect(local.reranker?.scoreSemantics).toBe('relative');
    expect(local.reason).toBeUndefined();

    const noneEnv = baseEnv({ RAG_RERANKER: 'none' });
    const noneConfig = loadRagConfig(noneEnv);
    const none = resolveReranker(noneConfig, 'chat', 'en', undefined, noneEnv, fetch);
    expect(none.reranker).toBeNull();
    expect(none.reason).toBe('disabled');
  });
});

describe('resolveReranker keys and eval overrides', () => {
  it('disables voyage without VOYAGE_API_KEY with reason missing_key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = baseEnv({ RAG_RERANKER: 'voyage', VOYAGE_API_KEY: '' });
    const config = loadRagConfig(env);
    const resolved = resolveReranker(config, 'chat', 'en', undefined, env, fetch);
    expect(resolved.reranker).toBeNull();
    expect(resolved.reason).toBe('missing_key');
    expect(JSON.stringify(warn.mock.calls)).toMatch(/VOYAGE_API_KEY/);
  });

  it('disables cohere without COHERE_API_KEY and warns without exposing a key value', () => {
    const secret = 'super-secret-cohere-key-value-should-never-appear';
    const env = baseEnv({ COHERE_API_KEY: secret });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = loadRagConfig(env);

    const first = resolveReranker(config, 'chat', 'en', undefined, { ...env, COHERE_API_KEY: '' }, fetch);
    expect(first.reranker).toBeNull();
    expect(first.reason).toBe('missing_key');
    expect(warn).toHaveBeenCalled();
    const blob = JSON.stringify(warn.mock.calls);
    expect(blob).toMatch(/COHERE_API_KEY/);
    expect(blob).not.toContain(secret);

    warn.mockClear();
    resolveReranker(config, 'chat', 'en', undefined, { ...env, COHERE_API_KEY: '' }, fetch);
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies eval-only reranker and model overrides, ignoring them on chat and embed', () => {
    const overrides: RetrievalOverrides = { reranker: 'cohere', rerankModel: 'fake-quality-v1' };
    const env = baseEnv({ RAG_RERANKER: 'voyage' });
    const config = loadRagConfig(env);

    const evalResolved = resolveReranker(config, 'eval', 'en', overrides, env, fetch);
    expect(evalResolved.provider).toBe('cohere');
    expect(evalResolved.model).toBe('fake-quality-v1');

    const chatResolved = resolveReranker(config, 'chat', 'en', overrides, env, fetch);
    expect(chatResolved.provider).toBe('voyage');
    expect(chatResolved.model).toBe('rerank-3');

    const embedResolved = resolveReranker(config, 'embed', 'en', overrides, env, fetch);
    expect(embedResolved.provider).toBe('voyage');

    const voiceResolved = resolveReranker(config, 'voice', 'en', overrides, env, fetch);
    expect(voiceResolved.provider).toBe('voyage');
  });

  it('uses setRerankerFactoryForTests instead of the default adapters', () => {
    const stub: Reranker = {
      id: 'cohere',
      model: 'stub-model',
      scoreSemantics: 'calibrated',
      supportedLanguages: [],
      rerank: async () => ({ scores: [] }),
    };
    setRerankerFactoryForTests(() => stub);
    const env = baseEnv();
    const config = loadRagConfig(env);
    const resolved = resolveReranker(config, 'chat', 'en', undefined, env, fetch);
    expect(resolved.reranker).toBe(stub);
    resetRerankerFactoryForTests();
    const again = resolveReranker(config, 'chat', 'en', undefined, env, fetch);
    expect(again.reranker).not.toBe(stub);
  });
});