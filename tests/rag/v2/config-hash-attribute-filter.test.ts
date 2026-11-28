import { describe, expect, it } from 'vitest';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { attributeFilterConfig } from '@/lib/rag/retrieval/attribute-filter-config';
import {
  ATTRIBUTE_STATE_NONE,
  ATTRIBUTE_STATE_SKIPPED,
  attributeFilterHashBlock,
  computeRetrievalConfigHash,
  type AttributeFilterHashStage,
  type RetrievalConfigHashInput,
} from '@/lib/rag/v2/config-hash';

/**
 * 03.3 verification G10: with RAG_ATTRIBUTE_FILTER=off the retrieval-config hash equals the value from before Phase 3.3. The golden is
 * the literal-input hash pinned before Phase 3.3 existed (PINNED_DEFAULT_HASH in params-hash.test.ts, GOLDEN_NO_BLOCK in
 * config-hash-terminology.test.ts); the attribute_filter block is the only Phase 3.3 input to the hash.
 */
/** The literal input of params-hash.test.ts, so the pinned value does not move with committed files. */
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

const PRE_PHASE33_HASH = 'f0bbcf06e9a792e368b2bcf880adf10f17336aa167a2c9fe5597198df3fc4fac';

const STAGES: AttributeFilterHashStage[] = [
  { enabled: false },
  { enabled: true, state: ATTRIBUTE_STATE_NONE },
  { enabled: true, state: ATTRIBUTE_STATE_SKIPPED },
  { enabled: true, state: 'e'.repeat(64) },
];

function hashFor(mode: 'off' | 'hard' | 'soft', stage: AttributeFilterHashStage): string {
  const block = attributeFilterHashBlock(stage, mode, attributeFilterConfig());
  return computeRetrievalConfigHash({ ...literalHashInput(), ...(block ? { attributeFilter: block } : {}) });
}

describe('attribute_filter block in the retrieval-config hash (03.3 G10)', () => {
  it('the literal input without the block still hashes to the pre-3.3 value', () => {
    expect(computeRetrievalConfigHash(literalHashInput())).toBe(PRE_PHASE33_HASH);
  });

  it('RAG_ATTRIBUTE_FILTER=off resolves to mode off, which adds no block for any stage state, so the hash equals the pre-3.3 value', () => {
    for (const env of [{ RAG_PIPELINE: 'v2' }, { RAG_PIPELINE: 'v2', RAG_ATTRIBUTE_FILTER: 'off', RAG_DOC_ATTRIBUTES: 'true' }]) {
      resetRagConfigForTests();
      const mode = loadRagConfig(env).v2.attributeFilter;
      expect(mode).toBe('off');
      for (const stage of STAGES) {
        expect(attributeFilterHashBlock(stage, mode, attributeFilterConfig())).toBeUndefined();
        expect(hashFor(mode, stage)).toBe(PRE_PHASE33_HASH);
      }
    }
    resetRagConfigForTests();
  });

  it('a filter that is on with the stage enabled does move the hash (the test can see a difference)', () => {
    resetRagConfigForTests();
    const mode = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_DOC_ATTRIBUTES: 'true', RAG_ATTRIBUTE_FILTER: 'hard' }).v2.attributeFilter;
    resetRagConfigForTests();
    expect(mode).toBe('hard');
    expect(hashFor(mode, { enabled: true, state: ATTRIBUTE_STATE_NONE })).not.toBe(PRE_PHASE33_HASH);
    expect(hashFor(mode, { enabled: false })).toBe(PRE_PHASE33_HASH);
  });
});
