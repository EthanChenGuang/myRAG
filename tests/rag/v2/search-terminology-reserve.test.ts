import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, RetrievalBackend, RetrievalFilters } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { terminologyParams } from '@/lib/rag/terminology/expand';
import { RetrievalOverridesSchema, RetrievalParamsSchema } from '@/lib/rag-eval/contracts.generated';
import type { StageName } from '@/lib/rag/config';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { hit } from '../fusion/helpers';
import { fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const FILTERS: RetrievalFilters = { currentOnly: true, docTypes: ['general'] };
const CHUNKING = { general: 'synthetic-profile' };
const EXPANSION = ['term', 'alpha'];
/** D-34: rrf_k and the pool are passed explicitly; the caps come from the generated contract at test time. */
const K = 60;
const SNAPSHOT_POOL = 40;

function capBounds() {
  const cap = RetrievalParamsSchema.shape.rerank_input_cap.removeDefault();
  return { min: cap.minValue!, max: cap.maxValue! };
}

function testedCaps(): number[] {
  const { min, max } = capBounds();
  return [min, Math.round((min + max) / 2), max];
}

function fullPool(): number {
  return RetrievalParamsSchema.shape.candidate_pool_size.removeDefault().maxValue!;
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

/** Full original lists of pool hits, none holding the gold chunk; the lexical-only term:0 call returns gold at rank 1. */
function fullListBackend(pool: number): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req): Promise<BackendLegs> {
      if (req.denseVector === null) return { dense: [], lexical: [hit('gold', { rank: 1, lexicalScore: 1 })] };
      return {
        dense: ids('dense', pool).map((chunkId, index) => hit(chunkId, { rank: index + 1, similarity: 0.9 })),
        lexical: ids('lexical', pool).map((chunkId, index) => hit(chunkId, { rank: index + 1, lexicalScore: 1 })),
      };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

interface SearchArgs {
  pool: number;
  cap: number;
  terminology: { tokens: string[]; expansionWeight: number; reserveSlots?: number } | null;
  disabledStages?: StageName[];
}

async function search({ pool, cap, terminology, disabledStages }: SearchArgs) {
  resetRagConfigForTests();
  const env = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' };
  const cfg = loadRagConfig(env);
  // The cap is validated by the generated contract, not by the run-time guard, so the test follows the contract's range (D-34).
  const params = RetrievalParamsSchema.parse({
    ...effectiveRetrievalParams('eval', cfg, RetrievalOverridesSchema.parse({ candidate_pool_size: pool, rrf_k: K })),
    rerank_input_cap: cap,
  });
  setRetrievalBackendForTests(fullListBackend(pool));
  const { embedder } = fakeEmbedder();
  installDeps({ embedder, ragEnv: () => env });
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
    stageOverrides: {
      retrievalOverrides: { chunkingProfileByDocType: CHUNKING } as never,
      ...(disabledStages ? { disabledStages } : {}),
    },
    ...(terminology ? { terminology } : {}),
  });
  return { output, params, collector };
}

function chunkIds(output: { fusedHits: { hit: { chunkId: string } }[] }): string[] {
  return output.fusedHits.map((row) => row.hit.chunkId);
}

describe('term:0 reach into the rerank input (D-34, TERM-06)', () => {
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

  it('switch off and no expansion tokens: output equals the snapshot captured before the reservation existed', async () => {
    const cap = capBounds().min;
    const off = await search({ pool: SNAPSHOT_POOL, cap, terminology: null });
    expect(off.params.rerank_input_cap).toBe(cap);
    expect(JSON.stringify(off.output)).toMatchSnapshot();
    expect(off.output.dedupeCounts).not.toHaveProperty('term_reserved');
    const empty = await search({ pool: SNAPSHOT_POOL, cap, terminology: { tokens: [], expansionWeight: terminologyParams().expansion_weight } });
    expect(JSON.stringify(empty.output)).toBe(JSON.stringify(off.output));
  });

  it.each(testedCaps())('with full lists, the gold chunk is the last rerank-input entry at cap %i', async (cap) => {
    const pool = fullPool();
    const { output, params, collector } = await search({
      pool,
      cap,
      terminology: { tokens: EXPANSION, expansionWeight: terminologyParams().expansion_weight },
    });
    expect(params.rerank_input_cap).toBe(cap);
    expect(params.candidate_pool_size).toBe(pool);
    expect(params.rrf_k).toBe(K);
    expect(output.fusedHits).toHaveLength(cap);
    expect(output.fusedHits.at(-1)?.hit.chunkId).toBe('gold');
    expect(output.dedupeCounts.term_reserved).toBe(1);
    const dedupe = collector.stages().find((row) => row.name === 'dedupe');
    expect(dedupe?.counts).toMatchObject({ term_reserved: 1, rerank_input: cap });
  });

  it.each(testedCaps())('with reserve_slots 0, the gold chunk is absent at cap %i and no term_reserved count exists', async (cap) => {
    const { output, collector } = await search({
      pool: fullPool(),
      cap,
      terminology: { tokens: EXPANSION, expansionWeight: terminologyParams().expansion_weight, reserveSlots: 0 },
    });
    expect(output.fusedHits).toHaveLength(cap);
    expect(chunkIds(output)).not.toContain('gold');
    expect(output.dedupeCounts).not.toHaveProperty('term_reserved');
    expect(collector.stages().find((row) => row.name === 'dedupe')?.counts).not.toHaveProperty('term_reserved');
  });

  it('applies the same reservation on the sliceCap fallback when the dedupe stage is skipped', async () => {
    const cap = capBounds().min;
    const { output, collector } = await search({
      pool: fullPool(),
      cap,
      terminology: { tokens: EXPANSION, expansionWeight: terminologyParams().expansion_weight },
      disabledStages: ['dedupe'],
    });
    expect(collector.stages().find((row) => row.name === 'dedupe')?.status).not.toBe('ok');
    expect(output.fusedHits).toHaveLength(cap);
    expect(output.fusedHits.at(-1)?.hit.chunkId).toBe('gold');
    expect(output.dedupeCounts.term_reserved).toBe(1);
  });
});
