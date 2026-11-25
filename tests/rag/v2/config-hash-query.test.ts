import { describe, expect, it } from 'vitest';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';

/** The literal input of params-hash.test.ts, so the pinned Phase 4 value does not move with committed files. */
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

/** Recorded in params-hash.test.ts (PINNED_DEFAULT_HASH): the Phase 4 hash of literalHashInput(). */
const PINNED_PHASE4_HASH = 'f0bbcf06e9a792e368b2bcf880adf10f17336aa167a2c9fe5597198df3fc4fac';

const LAYER = {
  framework: 'llamaindex',
  model: 'provider/query-model-a',
  queryParamsHash: 'c'.repeat(64),
  prompts: { 'llamaindex.condense': 1, 'llamaindex.fusion': 1, 'shared.suffix': 1 },
  transforms: { condense: true, decompose: true, expand: true, hyde: false, normalizeDates: true, translate: true },
};

function withLayer(overrides: Partial<typeof LAYER> = {}): RetrievalConfigHashInput {
  return { ...literalHashInput(), queryLayer: { ...LAYER, ...overrides } } as RetrievalConfigHashInput;
}

describe('computeRetrievalConfigHash query-layer part (D-04, research A-7)', () => {
  it('layer off: no query-layer part leaves the Phase 4 hash unchanged', () => {
    expect(computeRetrievalConfigHash(literalHashInput())).toBe(PINNED_PHASE4_HASH);
    expect(computeRetrievalConfigHash({ ...literalHashInput(), queryLayer: null } as RetrievalConfigHashInput)).toBe(PINNED_PHASE4_HASH);
  });

  it('layer on: the query-layer part changes the hash', () => {
    expect(computeRetrievalConfigHash(withLayer())).not.toBe(PINNED_PHASE4_HASH);
  });

  it('changing the framework, the query model, a prompt version, a query-params value or a transform switch each changes the hash', () => {
    const base = computeRetrievalConfigHash(withLayer());
    const variants = [
      withLayer({ framework: 'langchain' }),
      withLayer({ model: 'provider/query-model-b' }),
      withLayer({ prompts: { ...LAYER.prompts, 'llamaindex.condense': 2 } }),
      withLayer({ prompts: { ...LAYER.prompts, 'llamaindex.subq': 1 } }),
      withLayer({ queryParamsHash: 'd'.repeat(64) }),
      withLayer({ transforms: { ...LAYER.transforms, hyde: true } }),
    ].map((input) => computeRetrievalConfigHash(input));
    for (const hash of variants) expect(hash).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('the query-layer part is canonical: key order does not change the hash', () => {
    const reordered = withLayer({
      prompts: { 'shared.suffix': 1, 'llamaindex.fusion': 1, 'llamaindex.condense': 1 },
    });
    expect(computeRetrievalConfigHash(reordered)).toBe(computeRetrievalConfigHash(withLayer()));
  });
});
