import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { CacheQuery } from '@/lib/rag/cache/types';
import type { SemanticCacheConfig } from '@/lib/rag/config';

export const USER_A = '00000000-0000-4000-8000-0000000021a1';
export const USER_B = '00000000-0000-4000-8000-0000000021b1';
export const DOC_1 = '00000000-0000-4000-8000-00000000d001';

export const SCOPE_A = mintScope('personal', USER_A, null);
export const SCOPE_B = mintScope('personal', USER_B, null);
export const SCOPE_SINGLE = mintScope('single', null, null);

export const CONFIG: SemanticCacheConfig = {
  backend: 'pgvector',
  ttl: 3600,
  refusalTtl: 600,
  maxDistance: 0.05,
  embedStore: false,
};

export function cacheQuery(overrides: Partial<CacheQuery> = {}): CacheQuery {
  return {
    scope: SCOPE_A,
    standalone: 'what does the placeholder section describe',
    vector: [1, 0, 0, 0],
    embeddingProfileId: 'p1',
    answerLanguage: 'en',
    ragMode: 'strict',
    generatorModel: 'provider/model-a',
    retrievalConfigHash: 'a'.repeat(64),
    queryFramework: 'llamaindex',
    entryProfile: 'chat',
    systemPromptHash: 'b'.repeat(64),
    ...overrides,
  };
}

export function cachedAnswer(overrides: Partial<CachedAnswer> = {}): CachedAnswer {
  return {
    answer_language: 'en',
    answer_text: 'A neutral placeholder answer.',
    created_at: '2026-11-25T00:00:00.000Z',
    groundedness: {
      checkedAt: null,
      label: null,
      latencyMs: null,
      reason: null,
      score: null,
      scorer: null,
      status: 'not_checked',
      threshold: null,
      thresholdSource: null,
      truncated: false,
    },
    is_refusal: false,
    rag_mode: 'strict',
    trace_id: 'trace-placeholder',
    ...overrides,
  };
}
