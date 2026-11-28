import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import type { RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { resetActiveChunkingProfilesForTests, setActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { readSecurityConfig } from '@/lib/rag/security/config';
import type { RunRetrievalInput } from '@/lib/rag/types';
import { evalTuningOverrides, toStageRetrievalOverrides } from '@/lib/rag/v2/overrides';
import { requestRetrievalConfigHash } from '@/lib/rag/v2/result';

// 04.2-06 hand-off (W-5), closed by 07-25: the eval-only diversity and dup_cluster blocks reach the request hash and the stages.
describe('eval tuning overrides reach the request hash (04.2-06 hand-off, 07-25)', () => {
  beforeEach(() => {
    resetRagConfigForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setRetrievalBackendForTests({ id: 'pgvector' } as unknown as RetrievalBackend);
    setActiveChunkingProfilesForTests({ general: 'legacy' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRetrievalBackendForTests();
    resetActiveChunkingProfilesForTests();
    resetRagConfigForTests();
  });

  it('maps the API diversity, dup_cluster and table_lookup blocks to the internal overrides', () => {
    const mapped = toStageRetrievalOverrides({
      table_lookup: { min_cells: 3 },
      diversity: { mmr_lambda: 0.4, mmr_window_factor: 2 },
      dup_cluster: { threshold: 0.9 },
    } as never);
    expect(mapped).toEqual({
      tableLookup: { min_cells: 3 },
      diversity: { mmr_lambda: 0.4, mmr_window_factor: 2 },
      dupCluster: { threshold: 0.9 },
    });
  });

  it('evalTuningOverrides carries every tuning block for profile eval and nothing for chat', () => {
    const overrides = { diversity: { mmr_lambda: 0.4 }, dupCluster: { threshold: 0.9 } };
    expect(evalTuningOverrides('eval', overrides)).toEqual({ diversity: { mmr_lambda: 0.4 }, dup_cluster: { threshold: 0.9 } });
    expect(evalTuningOverrides('chat', overrides)).toBeUndefined();
  });

  function input(profile: 'eval' | 'chat', lambda?: number) {
    const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RESULT_DIVERSITY: 'mmr' });
    return {
      input: {
        scope: null,
        query: 'q',
        profile,
        signal: new AbortController().signal,
        ...(lambda === undefined ? {} : { stageOverrides: { retrievalOverrides: { diversity: { mmr_lambda: lambda } } } }),
      } as RunRetrievalInput,
      config,
      profile,
      embeddingProfileId: 'openai-3-small-1536',
      queryLanguage: 'en',
      security: readSecurityConfig({}),
    };
  }

  it('two eval mmr lambdas give two request hashes', async () => {
    expect(await requestRetrievalConfigHash(input('eval', 0.4))).not.toBe(await requestRetrievalConfigHash(input('eval', 0.7)));
  });

  it('a diversity override outside profile eval leaves the hash unchanged', async () => {
    expect(await requestRetrievalConfigHash(input('chat', 0.4))).toBe(await requestRetrievalConfigHash(input('chat')));
  });
});
