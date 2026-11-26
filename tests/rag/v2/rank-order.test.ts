import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankedHit } from '@/lib/rag/backend/types';
import { loadRagConfig } from '@/lib/rag/config';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { resetRerankerFactoryForTests, setRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import type { Reranker } from '@/lib/rag/rerank/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryVariant } from '@/lib/rag/types';
import type { QueryPlan } from '@/lib/rag-eval/contracts.generated';
import { runRankStages } from '@/lib/rag/v2/stages/rank';
import { hit } from '../fusion/helpers';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/rag/refusal/gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/refusal/gate')>();
  return {
    ...actual,
    decideRefusal: (...args: Parameters<typeof actual.decideRefusal>) => {
      calls.push('refusal');
      return actual.decideRefusal(...args);
    },
  };
});

vi.mock('@/lib/rag/v2/diversify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/v2/diversify')>();
  return {
    ...actual,
    diversify: (...args: Parameters<typeof actual.diversify>) => {
      calls.push('diversify');
      return actual.diversify(...args);
    },
  };
});

vi.mock('@/lib/rag/retrieval/identifiers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/retrieval/identifiers')>();
  return {
    ...actual,
    guardNearMisses: (...args: Parameters<typeof actual.guardNearMisses>) => {
      calls.push('identifier_guard');
      return actual.guardNearMisses(...args);
    },
  };
});

vi.mock('@/lib/rag/v2/subq-coverage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/v2/subq-coverage')>();
  return {
    ...actual,
    reserveSubQuestionCoverage: (...args: Parameters<typeof actual.reserveSubQuestionCoverage>) => {
      calls.push('reservation');
      return actual.reserveSubQuestionCoverage(...args);
    },
  };
});

const scope = mintScope('single', null, null);

const BASE_ENV: Record<string, string> = {
  RAG_PIPELINE: 'v2',
  RAG_LEXICAL_SEARCH: 'false',
  RAG_RERANKER: 'cohere',
  RAG_REFUSAL_THRESHOLD: 'true',
  RAG_DUP_CLUSTERS: 'true',
  COHERE_API_KEY: 'cohere-test-placeholder-key',
};

const VARIANTS: QueryVariant[] = [
  { text: 'compound question', language: 'en', kind: 'original' },
  { text: 'part zero', language: 'en', kind: 'sub_question', subQuestionIndex: 0 },
  { text: 'part one', language: 'en', kind: 'sub_question', subQuestionIndex: 1 },
];

const PLAN = { standalone: 'compound question', sub_questions: ['part zero', 'part one'] } as unknown as QueryPlan;

function row(index: number, over: Partial<RankedHit>, ranks: Record<string, number>): FusedHit {
  return {
    hit: hit(`c${index}`, {
      rank: index + 1,
      documentId: `d${index}`,
      similarity: 0.9,
      content: `vorpel ${index} quandry ${index}`,
      ...over,
    }),
    score: 1 / (60 + index + 1),
    ranks,
    standaloneSimilarity: 0.9,
  };
}

/** c0..c3 are copies of one passage (cluster X) for sub-question 0; c5 is the only chunk of sub-question 1. */
function flood(): FusedHit[] {
  return [
    row(0, { dupClusterId: 'X' }, { 'dense:0': 1, 'dense:1': 1 }),
    row(1, { dupClusterId: 'X' }, { 'dense:0': 2, 'dense:1': 2 }),
    row(2, { dupClusterId: 'X' }, { 'dense:0': 3, 'dense:1': 3 }),
    row(3, { dupClusterId: 'X' }, { 'dense:0': 4, 'dense:1': 4 }),
    row(4, {}, { 'dense:0': 5 }),
    row(5, {}, { 'dense:2': 1 }),
  ];
}

function orderedReranker(): Reranker {
  return {
    id: 'cohere',
    model: 'fake-quality-v1',
    scoreSemantics: 'calibrated',
    supportedLanguages: [],
    async rerank(_query, docs) {
      calls.push('rerank');
      return { scores: docs.map((_, index) => ({ index, score: 1 - index / (docs.length + 1) })) };
    },
  };
}

async function run(diversity: string, options: { coverage?: boolean; finalTopK?: number; identifiers?: boolean } = {}) {
  const env: Record<string, string> = {
    ...BASE_ENV,
    RAG_RESULT_DIVERSITY: diversity,
    ...(options.identifiers ? { RAG_IDENTIFIER_INDEX: 'true', RAG_IDENTIFIER_FILTER: 'true' } : {}),
  };
  uninstallDeps();
  installDeps({ ragEnv: () => env });
  setRerankerFactoryForTests(() => orderedReranker());
  const signal = new AbortController().signal;
  const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
  const coverage = options.coverage ?? true;
  const out = await runRankStages({
    input: { scope, query: 'compound question', profile: 'eval', signal },
    config: loadRagConfig(env),
    profile: 'eval',
    embedding: { vector: [0.1], profile: null },
    queryLanguage: 'en',
    fusedHits: flood(),
    referenced: null,
    signal,
    collector,
    stageOverrides: { retrievalOverrides: { rerankModel: 'fake-quality-v1' } },
    variants: VARIANTS,
    finalTopK: options.finalTopK ?? 2,
    ...(coverage ? { queryPlan: PLAN, coverage: { enabled: true, topK: options.finalTopK ?? 2 } } : {}),
    ...(options.identifiers ? { identifiers: { askedNorms: ['vorpel4'], patterns: [] } } : {}),
  });
  return { out, collector };
}

function ids(rows: FusedHit[]): string[] {
  return rows.map((entry) => entry.hit.chunkId);
}

describe('rank stage order with diversify (D-21, D-48, D-38 h)', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRerankerFactoryForTests();
    vi.restoreAllMocks();
  });

  it('runs rerank, then refusal, then diversify, then the sub-question reservation', async () => {
    const { out, collector } = await run('collapse');
    expect(calls).toEqual(['rerank', 'refusal', 'diversify', 'reservation']);
    const names = collector.stages().map((stage) => stage.name);
    expect(names.indexOf('refusal')).toBeLessThan(names.indexOf('diversify'));
    expect(ids(out.survivors).slice(0, 2)).toEqual(['c0', 'c5']);
    expect(ids(out.survivors)).not.toContain('c1');
    expect(out.alsoIn?.get('c0')?.map((entry) => entry.documentId)).toEqual(['d1', 'd2', 'd3']);
  });

  it('runs the identifier guard between refusal and diversify while the filter is on (D-31, D-51)', async () => {
    const { out, collector } = await run('collapse', { identifiers: true });
    expect(calls).toEqual(['rerank', 'refusal', 'identifier_guard', 'diversify', 'reservation']);
    const names = collector.stages().map((stage) => stage.name);
    expect(names.indexOf('refusal')).toBeLessThan(names.indexOf('identifier_guard'));
    expect(names.indexOf('identifier_guard')).toBeLessThan(names.indexOf('diversify'));
    const guard = collector.stages().find((stage) => stage.name === 'identifier_guard');
    expect(guard?.status).toBe('ok');
    expect(guard?.counts).toEqual({ dropped: 0 });
    expect(out.identifierGuard).toEqual({ dropped: 0 });
  });

  it('records no identifier guard while the filter is off', async () => {
    const { collector } = await run('collapse');
    expect(calls).not.toContain('identifier_guard');
    expect(collector.stages().some((stage) => stage.name === 'identifier_guard')).toBe(false);
  });

  it('keeps the reservation inside the refusal stage while diversity is off', async () => {
    const { out, collector } = await run('off');
    expect(calls).toEqual(['rerank', 'refusal', 'reservation']);
    expect(out.alsoIn).toBeUndefined();
    const record = collector.stages().find((stage) => stage.name === 'diversify');
    expect(record?.status).toBe('disabled');
    expect(collector.stages().find((stage) => stage.name === 'refusal')?.counts).toHaveProperty('subq_reserved');
  });

  it('records counts and the mode, and the reservation count moves to the diversify stage', async () => {
    const { collector } = await run('mmr');
    const record = collector.stages().find((stage) => stage.name === 'diversify');
    expect(record?.status).toBe('ok');
    expect(record?.detail).toBe('mode=mmr');
    expect(record?.counts).toMatchObject({ in: 6, kept: 3, collapsed: 3 });
    expect(record?.counts).toHaveProperty('subq_reserved');
    expect(collector.stages().find((stage) => stage.name === 'refusal')?.counts).not.toHaveProperty('subq_reserved');
  });

  it('gives the same refusal record with diversity off, collapse and mmr', async () => {
    const off = await run('off');
    const collapse = await run('collapse');
    const mmr = await run('mmr');
    expect(collapse.out.decision).toEqual(off.out.decision);
    expect(mmr.out.decision).toEqual(off.out.decision);
    expect(collapse.out.gate).toEqual(off.out.gate);
    expect(ids(collapse.out.preRefusalHits)).toEqual(ids(off.out.preRefusalHits));
  });

  it('with diversity off the survivors equal the input order', async () => {
    const { out } = await run('off', { coverage: false });
    expect(ids(out.survivors)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('keeps the input list when the diversify stage fails', async () => {
    const env = { ...BASE_ENV, RAG_RESULT_DIVERSITY: 'collapse' };
    uninstallDeps();
    installDeps({ ragEnv: () => env });
    setRerankerFactoryForTests(() => orderedReranker());
    const broken = flood();
    Object.defineProperty(broken[1]!.hit, 'dupClusterId', {
      get() {
        throw new Error('boom');
      },
    });
    const signal = new AbortController().signal;
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const out = await runRankStages({
      input: { scope, query: 'compound question', profile: 'eval', signal },
      config: loadRagConfig(env),
      profile: 'eval',
      embedding: { vector: [0.1], profile: null },
      queryLanguage: 'en',
      fusedHits: broken,
      referenced: null,
      signal,
      collector,
      stageOverrides: { retrievalOverrides: { rerankModel: 'fake-quality-v1' } },
      variants: VARIANTS,
      finalTopK: 2,
    });
    expect(collector.stages().find((stage) => stage.name === 'diversify')?.status).toBe('skipped');
    expect(ids(out.survivors)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5']);
    expect(out.alsoIn).toBeUndefined();
  });
});
