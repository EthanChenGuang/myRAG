import { afterEach, describe, expect, it } from 'vitest';
import type { RankedHit } from '@/lib/rag/backend/types';
import { loadRagConfig } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { resetRerankerFactoryForTests, setRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import type { Reranker } from '@/lib/rag/rerank/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { IDENTIFIER_MATCH_REASON, runRankStages } from '@/lib/rag/v2/stages/rank';
import { hit } from '../fusion/helpers';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const QUERY = 'Which interface does the XR-5100 have?';

function row(index: number, over: Partial<RankedHit>): FusedHit {
  return {
    hit: hit(`c${index}`, { rank: index + 1, documentId: `d${index}`, similarity: 0.2, ...over }),
    score: 1 / (60 + index + 1),
    ranks: { 'dense:0': index + 1 },
  };
}

/** Low dense similarity on every row: the similarity floor alone refuses. */
function filteredPool(): FusedHit[] {
  return [
    row(0, { content: 'Firmware 2.1 supports the XR-5100 and the XR-4410.' }),
    row(1, { content: '| XR-5100 | interface | USB-C and RS-485 |' }),
  ];
}

function capturing(semantics: 'relative' | 'calibrated', queries: Array<{ query: string; byDoc?: string[] }>): Reranker {
  return {
    id: semantics === 'relative' ? 'local_bm25' : 'cohere',
    model: 'fake-v1',
    scoreSemantics: semantics,
    supportedLanguages: [],
    async rerank(query, docs, opts) {
      queries.push({ query, ...(opts.queryByDoc ? { byDoc: [...opts.queryByDoc] } : {}) });
      return { scores: docs.map((_, index) => ({ index, score: 0.5 })) };
    },
  };
}

async function rank(options: {
  env: Record<string, string>;
  identifiers?: { askedNorms: string[]; filteredBy?: { norms: string[]; spellings: string[] } };
  reranker?: Reranker;
}) {
  const env = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_REFUSAL_THRESHOLD: 'true', ...options.env };
  uninstallDeps();
  installDeps({ ragEnv: () => env });
  if (options.reranker) {
    const reranker = options.reranker;
    setRerankerFactoryForTests(() => reranker);
  }
  const signal = new AbortController().signal;
  return runRankStages({
    input: { scope, query: QUERY, profile: 'eval', signal },
    config: loadRagConfig(env),
    profile: 'eval',
    embedding: { vector: [0.1], profile: null },
    queryLanguage: 'en',
    fusedHits: filteredPool(),
    referenced: null,
    signal,
    collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
    stageOverrides: { retrievalOverrides: { rerankModel: 'fake-v1' } },
    ...(options.identifiers ? { identifiers: { ...options.identifiers, patterns: [] } } : {}),
  });
}

afterEach(() => {
  resetRerankerFactoryForTests();
  uninstallDeps();
});

describe('refusal floor under an applied identifier filter (D-31)', () => {
  for (const floor of ['similarity', 'legacy_rule']) {
    it(`answers on a candidate carrying the found identifier (floor ${floor})`, async () => {
      const env = { RAG_RERANKER: 'none', RAG_REFUSAL_FLOOR: floor };
      const off = await rank({ env });
      expect(off.decision.decision).toBe('refuse');
      const on = await rank({ env, identifiers: { askedNorms: ['xr5100'], filteredBy: { norms: ['xr5100'], spellings: ['XR-5100'] } } });
      expect(on.decision).toMatchObject({ decision: 'answer', basis: 'none', reason: IDENTIFIER_MATCH_REASON, topScore: 0.2 });
      expect(on.survivors.map((entry) => entry.hit.chunkId)).toEqual(['c0', 'c1']);
    });
  }

  it('keeps the floor when the filter fell back or no candidate carries the found identifier', async () => {
    const env = { RAG_RERANKER: 'none', RAG_REFUSAL_FLOOR: 'similarity' };
    const fellBack = await rank({ env, identifiers: { askedNorms: ['xr5100'] } });
    expect(fellBack.decision.decision).toBe('refuse');
    const elsewhere = await rank({ env, identifiers: { askedNorms: ['qp220'], filteredBy: { norms: ['qp220'], spellings: ['QP-220'] } } });
    expect(elsewhere.decision.decision).toBe('refuse');
  });
});

describe('rerank query under an applied identifier filter (D-31)', () => {
  it('drops the found spelling from the query of a pool-statistics reranker', async () => {
    const queries: Array<{ query: string; byDoc?: string[] }> = [];
    await rank({
      env: { RAG_RERANKER: 'local_bm25', RAG_REFUSAL_FLOOR: 'similarity' },
      identifiers: { askedNorms: ['xr5100'], filteredBy: { norms: ['xr5100'], spellings: ['XR-5100'] } },
      reranker: capturing('relative', queries),
    });
    expect(queries).toEqual([{ query: 'Which interface does the have?', byDoc: ['Which interface does the have?', 'Which interface does the have?'] }]);
  });

  it('keeps the query unchanged without the filter and for a calibrated reranker', async () => {
    const relative: Array<{ query: string; byDoc?: string[] }> = [];
    await rank({ env: { RAG_RERANKER: 'local_bm25' }, identifiers: { askedNorms: ['xr5100'] }, reranker: capturing('relative', relative) });
    expect(relative[0]?.query).toBe(QUERY);
    const calibrated: Array<{ query: string; byDoc?: string[] }> = [];
    await rank({
      env: { RAG_RERANKER: 'cohere', COHERE_API_KEY: 'cohere-test-placeholder-key' },
      identifiers: { askedNorms: ['xr5100'], filteredBy: { norms: ['xr5100'], spellings: ['XR-5100'] } },
      reranker: capturing('calibrated', calibrated),
    });
    expect(calibrated[0]?.query).toBe(QUERY);
  });
});
