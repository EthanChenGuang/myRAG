import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { queryLayerHashComponent, queryPromptVersions } from '@/lib/rag/query/hash-part';
import { effectiveQueryParams } from '@/lib/rag/query/query-params';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput, type RetrievalConfigHashQueryLayer } from '@/lib/rag/v2/config-hash';
import type { RetrievalCacheContext, RetrievalResult } from '@/lib/rag/types';

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

const LAYER: RetrievalConfigHashQueryLayer = {
  framework: 'llamaindex',
  model: 'provider/query-model-a',
  queryParamsHash: 'c'.repeat(64),
  prompts: { 'llamaindex.condense': 1, 'llamaindex.fusion': 1, 'shared.suffix': 1 },
  transforms: { condense: true, decompose: true, expand: true, hyde: false, normalizeDates: true, translate: true },
};

function withLayer(overrides: Partial<RetrievalConfigHashQueryLayer> = {}): RetrievalConfigHashInput {
  return { ...literalHashInput(), queryLayer: { ...LAYER, ...overrides } };
}

describe('computeRetrievalConfigHash query-layer part (D-04, research A-7)', () => {
  it('layer off: no query-layer part leaves the Phase 4 hash unchanged', () => {
    expect(computeRetrievalConfigHash(literalHashInput())).toBe(PINNED_PHASE4_HASH);
    expect(computeRetrievalConfigHash({ ...literalHashInput(), queryLayer: null })).toBe(PINNED_PHASE4_HASH);
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

describe('queryLayerHashComponent', () => {
  it('lists every prompt file in src/lib/rag/query/prompts with its version', () => {
    const dir = path.join(process.cwd(), 'src/lib/rag/query/prompts');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    const expected = Object.fromEntries(
      files.map((name) => {
        const file = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as { id: string; version: number };
        return [file.id, file.version];
      }),
    );
    expect(queryPromptVersions()).toEqual(expected);
  });

  it('follows the framework, model, transform switches and the effective query params', () => {
    resetRagConfigForTests();
    const layer = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' }).queryLayer;
    const params = effectiveQueryParams('chat');
    const base = queryLayerHashComponent(layer, params);
    expect(base.framework).toBe(layer.framework);
    expect(base.model).toBe(layer.model);
    expect(base.queryParamsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(queryLayerHashComponent(layer, { ...params, max_searches: params.max_searches + 1 }).queryParamsHash).not.toBe(base.queryParamsHash);
    expect(queryLayerHashComponent({ ...layer, model: 'provider/other' }, params).model).toBe('provider/other');
    expect(queryLayerHashComponent({ ...layer, transforms: { ...layer.transforms, hyde: !layer.transforms.hyde } }, params).transforms.hyde).toBe(
      !layer.transforms.hyde,
    );
    resetRagConfigForTests();
  });
});

describe('cache inputs on the retrieval contract', () => {
  it('cacheContext is typed and has no entry-profile field; cacheHit and cacheTicket are optional on the result', () => {
    const context: RetrievalCacheContext = {
      generatorModel: 'provider/model-a',
      systemPromptHash: 'b'.repeat(64),
      webSearch: false,
      mcpTools: false,
      chatId: null,
    };
    // @ts-expect-error the entry profile follows RunRetrievalInput.profile and is never caller data
    const withProfile: RetrievalCacheContext = { ...context, entryProfile: 'eval' };
    expect(Object.keys(context).sort()).toEqual(['chatId', 'generatorModel', 'mcpTools', 'systemPromptHash', 'webSearch']);
    expect(withProfile.generatorModel).toBe('provider/model-a');
    const result: Pick<RetrievalResult, 'cacheHit' | 'cacheTicket'> = {};
    expect(result.cacheHit).toBeUndefined();
    expect(result.cacheTicket).toBeUndefined();
  });
});
