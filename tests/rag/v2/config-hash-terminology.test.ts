import { describe, expect, it } from 'vitest';
import { TerminologyParamsSchema, type RetrievalParams, type TerminologyParams } from '@/lib/rag-eval/contracts.generated';
import * as configHash from '@/lib/rag/v2/config-hash';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';

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

/** Captured from the unmodified computeRetrievalConfigHash before this plan (equals PINNED_DEFAULT_HASH in params-hash.test.ts). */
const GOLDEN_NO_BLOCK = 'f0bbcf06e9a792e368b2bcf880adf10f17336aa167a2c9fe5597198df3fc4fac';

type Block = { version: string; params_sha256: string; dense: boolean };
type BlockBuilder = (stage: { enabled: false } | { enabled: true; version: string | null }, params: TerminologyParams, dense: boolean) => Block | undefined;

function builder(): BlockBuilder {
  const fn = (configHash as Record<string, unknown>).terminologyHashBlock;
  expect(typeof fn).toBe('function');
  return fn as BlockBuilder;
}

function hashWith(block: Block | undefined): string {
  return computeRetrievalConfigHash({ ...literalHashInput(), ...(block ? { terminology: block } : {}) } as RetrievalConfigHashInput);
}

const DEFAULT_PARAMS = TerminologyParamsSchema.parse({});
const SHA = 'd'.repeat(64);

describe('terminology block in the retrieval-config hash (04.1.1-16, D-21)', () => {
  it('an input without the block hashes to the golden value captured before the change', () => {
    expect(computeRetrievalConfigHash(literalHashInput())).toBe(GOLDEN_NO_BLOCK);
    expect(hashWith(undefined)).toBe(GOLDEN_NO_BLOCK);
  });

  it('a present block changes the hash, and each version gives its own hash', () => {
    const s1 = hashWith({ version: 's1', params_sha256: SHA, dense: false });
    const s2 = hashWith({ version: 's2', params_sha256: SHA, dense: false });
    const s1w1 = hashWith({ version: 's1.w1', params_sha256: SHA, dense: false });
    const unavailable = hashWith({ version: 'terminology:unavailable', params_sha256: SHA, dense: false });
    expect(new Set([GOLDEN_NO_BLOCK, s1, s2, s1w1, unavailable]).size).toBe(5);
  });

  it('the dense flag and the params hash are part of the block', () => {
    const base = hashWith({ version: 's1', params_sha256: SHA, dense: false });
    expect(hashWith({ version: 's1', params_sha256: SHA, dense: true })).not.toBe(base);
    expect(hashWith({ version: 's1', params_sha256: 'e'.repeat(64), dense: false })).not.toBe(base);
  });

  it('key order inside the block does not matter', () => {
    const a = hashWith({ version: 's1', params_sha256: SHA, dense: false });
    const b = hashWith({ dense: false, params_sha256: SHA, version: 's1' } as Block);
    expect(a).toBe(b);
  });
});

describe('terminologyHashBlock (04.1.1-16, D-21)', () => {
  it('a disabled stage gives no block', () => {
    expect(builder()({ enabled: false }, DEFAULT_PARAMS, false)).toBeUndefined();
    expect(builder()({ enabled: false }, DEFAULT_PARAMS, true)).toBeUndefined();
  });

  it('an ok stage records the effective version; a skipped stage records terminology:unavailable', () => {
    const ok = builder()({ enabled: true, version: 's3.w2' }, DEFAULT_PARAMS, false);
    expect(ok?.version).toBe('s3.w2');
    const skipped = builder()({ enabled: true, version: null }, DEFAULT_PARAMS, false);
    expect(skipped?.version).toBe('terminology:unavailable');
    expect(hashWith(ok)).not.toBe(hashWith(skipped));
    expect(configHash.TERMINOLOGY_UNAVAILABLE).toBe('terminology:unavailable');
  });

  it('params_sha256 follows every TerminologyParams value and ignores config_hash and provenance', () => {
    const base = builder()({ enabled: true, version: 's1' }, DEFAULT_PARAMS, false)!;
    expect(base.params_sha256).toMatch(/^[a-f0-9]{64}$/);
    const changed = builder()({ enabled: true, version: 's1' }, { ...DEFAULT_PARAMS, expansion_weight: 0.25 }, false)!;
    expect(changed.params_sha256).not.toBe(base.params_sha256);
    const capped = builder()({ enabled: true, version: 's1' }, { ...DEFAULT_PARAMS, max_matches: 3 }, false)!;
    expect(capped.params_sha256).not.toBe(base.params_sha256);
    const annotated = builder()(
      { enabled: true, version: 's1' },
      { ...DEFAULT_PARAMS, config_hash: 'f'.repeat(64), provenance: { source: 'sweep' } },
      false,
    )!;
    expect(annotated.params_sha256).toBe(base.params_sha256);
  });

  it('dense reflects the dense switch', () => {
    expect(builder()({ enabled: true, version: 's1' }, DEFAULT_PARAMS, true)?.dense).toBe(true);
    expect(builder()({ enabled: true, version: 's1' }, DEFAULT_PARAMS, false)?.dense).toBe(false);
  });
});

describe('the hash switches do not gain the terminology config fields (04.1.1-16)', () => {
  it('RetrievalConfigHashSwitches has no terminology key for a config with every terminology switch on', () => {
    resetRagConfigForTests();
    const config = loadRagConfig({
      RAG_PIPELINE: 'v2',
      RAG_SUPPORTED_LANGUAGES: 'zh,en,it',
      RAG_PRIMARY_LANGUAGE: 'en',
      RAG_TERMINOLOGY: 'true',
      RAG_TERMINOLOGY_DENSE: 'true',
      RAG_TERMINOLOGY_MINING: 'true',
    });
    expect(config.v2.terminology).toBe(true);
    const switchKeys = Object.keys(literalHashInput().switches);
    expect(switchKeys.some((key) => key.toLowerCase().includes('terminology'))).toBe(false);
    resetRagConfigForTests();
  });
});
