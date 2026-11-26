import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { terminologyParams } from '@/lib/rag/terminology/expand';
import { RetrievalOverridesSchema } from '@/lib/rag-eval/contracts.generated';
import type { RetrievalFilters } from '@/lib/rag/backend/types';
import type { QueryVariant } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages, TERMINOLOGY_LIST_ID } from '@/lib/rag/v2/stages/search';
import { hit } from '../fusion/helpers';
import { fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const FILTERS: RetrievalFilters = { currentOnly: true, docTypes: ['general'] };
/** D-34: the pool is passed explicitly and asserted against what was passed. */
const POOL = 17;
const CHUNKING = { general: 'synthetic-profile' };
const EXPANSION = ['term', 'alpha', 'beta'];

function recordingBackend(): { backend: RetrievalBackend; requests: BackendSearchRequest[] } {
  const requests: BackendSearchRequest[] = [];
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search(req): Promise<BackendLegs> {
      requests.push(req);
      if (req.denseVector === null) return { dense: [], lexical: [hit('gold', { rank: 1, lexicalScore: 1 })] };
      const lexical = req.lexicalTokens.length > 0 ? [hit('a', { rank: 1, lexicalScore: 1 })] : [];
      return { dense: [hit('a', { rank: 1, similarity: 0.9 }), hit('gold', { rank: 2, similarity: 0.8 })], lexical };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  return { backend, requests };
}

interface SearchOptions {
  variants?: QueryVariant[];
  terminologyDenseWeight?: number;
  legWeights?: { dense: number; lexical: number };
}

async function search(
  terminology: { tokens: string[]; expansionWeight: number } | null,
  env: Record<string, string> = {},
  options: SearchOptions = {},
) {
  resetRagConfigForTests();
  const cfg = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', ...env });
  const params = effectiveRetrievalParams('eval', cfg, RetrievalOverridesSchema.parse({ candidate_pool_size: POOL, ...(options.legWeights ? { leg_weights: options.legWeights } : {}) }));
  const { backend, requests } = recordingBackend();
  setRetrievalBackendForTests(backend);
  const { embedder } = fakeEmbedder();
  installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', ...env }) });
  await verifyV2Startup();
  const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
  const output = await runSearchStages({
    input: { scope, query: 'what is termalpha', profile: 'eval', signal: new AbortController().signal },
    scope,
    config: cfg,
    profile: 'eval',
    params,
    embedding: { vector: [0.1, 0.2, 0.3], profile: null },
    signal: new AbortController().signal,
    collector,
    filters: FILTERS,
    stageOverrides: { retrievalOverrides: { chunkingProfileByDocType: CHUNKING } as never },
    ...(terminology ? { terminology } : {}),
    ...(options.variants ? { variants: options.variants, variantEmbeddings: options.variants.map(() => ({ vector: [0.1, 0.2, 0.3], profile: null })) } : {}),
    ...(options.terminologyDenseWeight !== undefined ? { terminologyDenseWeight: options.terminologyDenseWeight } : {}),
  });
  return { output, requests, params, collector };
}

describe('the term:0 list (D-16, D-34, T-0411-46)', () => {
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
    vi.restoreAllMocks();
  });

  it('is one lexical-only call under the same scope, filters and chunking override, limited by the effective pool', async () => {
    const weight = terminologyParams().expansion_weight;
    const { requests, params } = await search({ tokens: EXPANSION, expansionWeight: weight });
    expect(requests).toHaveLength(2);
    const [original, term] = [requests.find((req) => req.denseVector !== null)!, requests.find((req) => req.denseVector === null)!];
    expect(term.lexicalTokens).toEqual(EXPANSION);
    expect(term.denseLimit).toBe(0);
    expect(params.candidate_pool_size).toBe(POOL);
    expect(term.lexicalLimit).toBe(POOL);
    expect(term.lexicalLanguages).toBeNull();
    expect(term.scope).toBe(original.scope);
    expect(term.filters).toBe(original.filters);
    expect(original.chunkingProfileOverride).toEqual(CHUNKING);
    expect(term.chunkingProfileOverride).toEqual(CHUNKING);
    expect(term.signal).toBe(original.signal);
  });

  it('adds expansion_weight × lexical leg weight / (rrf_k + rank) and leaves the original lists unchanged', async () => {
    const weight = terminologyParams().expansion_weight;
    const off = await search(null);
    const on = await search({ tokens: EXPANSION, expansionWeight: weight });
    const goldOff = off.output.fusedHits.find((row) => row.hit.chunkId === 'gold')!;
    const goldOn = on.output.fusedHits.find((row) => row.hit.chunkId === 'gold')!;
    expect(goldOn.ranks[TERMINOLOGY_LIST_ID]).toBe(1);
    const lexicalWeight = on.params.leg_weights?.lexical ?? 1;
    expect(goldOn.score - goldOff.score).toBeCloseTo((weight * lexicalWeight) / (on.params.rrf_k + 1), 12);
    const { [TERMINOLOGY_LIST_ID]: _term, ...originalRanks } = goldOn.ranks;
    expect(originalRanks).toEqual(goldOff.ranks);
    expect(off.requests).toHaveLength(1);
    expect(off.collector.stages().find((row) => row.name === 'search')?.counts).not.toHaveProperty('term');
    expect(on.collector.stages().find((row) => row.name === 'search')?.counts).toMatchObject({ term: 1 });
  });

  it('is not searched with lexical search off or with no expansion tokens', async () => {
    const weight = terminologyParams().expansion_weight;
    const lexicalOff = await search({ tokens: EXPANSION, expansionWeight: weight }, { RAG_LEXICAL_SEARCH: 'false' });
    expect(lexicalOff.requests.every((req) => req.denseVector !== null)).toBe(true);
    const empty = await search({ tokens: [], expansionWeight: weight });
    expect(empty.requests).toHaveLength(1);
  });

  describe('the dense terminology variant (D-18, D-34)', () => {
    const VARIANTS: QueryVariant[] = [
      { text: 'what is termalpha', language: 'en', kind: 'original' },
      { text: 'what is term alpha beta', language: 'en', kind: 'terminology', legs: 'dense' },
    ];
    /** D-34: the leg weights are passed explicitly and asserted against what was passed. */
    const LEG_WEIGHTS = { dense: 1.6, lexical: 0.7 };

    it('is searched dense-only, even without the legs field', async () => {
      const dense = terminologyParams().dense_weight;
      const withoutLegs = VARIANTS.map(({ legs: _legs, ...rest }) => rest);
      const { requests } = await search(null, {}, { variants: withoutLegs, terminologyDenseWeight: dense });
      expect(requests).toHaveLength(2);
      expect(requests[0]!.lexicalTokens.length).toBeGreaterThan(0);
      expect(requests[1]!.lexicalTokens).toEqual([]);
      expect(requests[1]!.denseLimit).toBe(POOL);
    });

    it('gets dense_weight × the dense leg weight in force; the original lists keep their weights', async () => {
      const dense = terminologyParams().dense_weight;
      const { output, params } = await search(null, {}, { variants: VARIANTS, terminologyDenseWeight: dense, legWeights: LEG_WEIGHTS });
      expect(params.leg_weights?.dense).toBe(LEG_WEIGHTS.dense);
      const gold = output.fusedHits.find((row) => row.hit.chunkId === 'gold')!;
      expect(gold.ranks).toEqual({ 'dense:0': 2, 'dense:1': 2 });
      expect(Object.keys(gold.ranks)).not.toContain('lexical:1');
      const k = params.rrf_k;
      const expected = LEG_WEIGHTS.dense / (k + 2) + (dense * LEG_WEIGHTS.dense) / (k + 2);
      expect(gold.score).toBeCloseTo(expected, 12);
      expect(dense * LEG_WEIGHTS.dense).toBeLessThan(LEG_WEIGHTS.dense);
      const top = output.fusedHits.find((row) => row.hit.chunkId === 'a')!;
      expect(top.score).toBeCloseTo(LEG_WEIGHTS.dense / (k + 1) + LEG_WEIGHTS.lexical / (k + 1) + (dense * LEG_WEIGHTS.dense) / (k + 1), 12);
    });
  });
});
