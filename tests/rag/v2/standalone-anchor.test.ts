import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { anchorToStandalone } from '@/lib/rag/fusion/anchor';
import { rrf, type FusedHit } from '@/lib/rag/fusion/rrf';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryVariant } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);

function fused(ids: string[]): FusedHit[] {
  return rrf([{ id: 'dense:0', weight: 1, hits: ids.map((id, index) => hit(id, { rank: index + 1 })) }]);
}

describe('anchorToStandalone', () => {
  it("keeps the standalone query's i-th hit at or above position 2i - 1", () => {
    const order = anchorToStandalone(fused(['v1', 'v2', 'v3', 'v4', 's1', 's2', 's3']), ['s1', 's2', 's3']);
    const ids = order.map((row) => row.hit.chunkId);
    expect(ids).toEqual(['s1', 'v1', 's2', 'v2', 's3', 'v3', 'v4']);
  });

  it('drops nothing, duplicates nothing and keeps each row unchanged', () => {
    const input = fused(['a', 'b', 'c', 'd', 'e']);
    const order = anchorToStandalone(input, ['d', 'b', 'missing', 'd']);
    expect(order.map((row) => row.hit.chunkId)).toEqual(['d', 'a', 'b', 'c', 'e']);
    expect(new Set(order)).toEqual(new Set(input));
  });

  it('returns the fused order when the standalone order is empty or already leads', () => {
    const input = fused(['a', 'b', 'c']);
    expect(anchorToStandalone(input, [])).toBe(input);
    expect(anchorToStandalone(input, ['a', 'b', 'c']).map((row) => row.hit.chunkId)).toEqual(['a', 'b', 'c']);
  });
});

const ORIGINAL = 'What is the weight, the price and the firmware of the sample module?';
const VARIANTS: QueryVariant[] = [
  { text: ORIGINAL, language: 'en', kind: 'original' },
  { text: 'What is the weight of the sample module?', language: 'en', kind: 'sub_question', subQuestionIndex: 0 },
  { text: 'What is the price of the sample module?', language: 'en', kind: 'sub_question', subQuestionIndex: 1 },
  { text: 'Which firmware supports the sample module?', language: 'en', kind: 'sub_question', subQuestionIndex: 2 },
];
const AGREED = ['agreed-1', 'agreed-2', 'agreed-3', 'agreed-4', 'agreed-5'];

function vectorFor(index: number): number[] {
  return VARIANTS.map((_variant, position) => (position === index ? 1 : 0));
}

/** The original finds its own evidence; every sub-question agrees on the same five other chunks. */
function backend(): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req: BackendSearchRequest) {
      const index = req.denseVector?.indexOf(1) ?? 0;
      const ids = index === 0 ? ['original-best', 'original-second'] : AGREED;
      return { dense: ids.map((id, rank) => hit(id, { rank: rank + 1, similarity: 0.8 - rank * 0.01 })), lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

async function search(trackStandalone: boolean) {
  setRetrievalBackendForTests(backend());
  installDeps({ ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false' }) });
  await verifyV2Startup();
  resetRagConfigForTests();
  const config = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false' });
  const signal = new AbortController().signal;
  const output = await runSearchStages({
    input: { scope, query: ORIGINAL, profile: 'eval', signal },
    scope,
    config,
    profile: 'eval',
    params: effectiveRetrievalParams('eval', config, null),
    embedding: { vector: vectorFor(0), profile: null },
    variantEmbeddings: VARIANTS.map((_variant, index) => ({ vector: vectorFor(index), profile: null })),
    variants: VARIANTS,
    signal,
    collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    ...(trackStandalone ? { trackStandalone: true } : {}),
  });
  return output.fusedHits.map((row) => row.hit.chunkId);
}

describe('search stage: query-layer variants never displace the standalone query hits', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it("with the query layer on, the original's top hits stay in the top five", async () => {
    const ids = await search(true);
    expect(ids.slice(0, 5)).toEqual(['original-best', 'agreed-1', 'original-second', 'agreed-2', 'agreed-3']);
    expect(new Set(ids)).toEqual(new Set([...AGREED, 'original-best', 'original-second']));
  });

  it('with the query layer off, the fused order is plain RRF over every list', async () => {
    const ids = await search(false);
    expect(ids).toEqual([...AGREED, 'original-best', 'original-second']);
  });
});
