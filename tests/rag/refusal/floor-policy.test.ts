import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { RankedHit } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { legacyQueryTerms } from '@/lib/rag/context/relevance';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { LEGACY_IMAGE_FLOOR, LEGACY_TEXT_FLOOR, legacyRuleFloor } from '@/lib/rag/refusal/floor';
import { cellKey, type ThresholdCells } from '@/lib/rag/refusal/gate';
import * as thresholds from '@/lib/rag/refusal/thresholds';
import { resetRerankerFactoryForTests, setRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import { RERANK_TEXT_VERSION, type Reranker } from '@/lib/rag/rerank/types';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { Profile, StageOverrides } from '@/lib/rag/types';
import { runRankStages } from '@/lib/rag/v2/stages/rank';
import { hit } from '../fusion/helpers';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const floors = { text: LEGACY_TEXT_FLOOR, image: LEGACY_IMAGE_FLOOR };

function configWarnings(warn: MockInstance<(...args: unknown[]) => void>): string[] {
  return warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('[RAG Config]'));
}

describe('RAG_REFUSAL_FLOOR parse', () => {
  let warn: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    resetRagConfigForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('defaults to similarity and accepts legacy_rule in any case and spacing', () => {
    expect(loadRagConfig({}).v2.refusalFloor).toBe('similarity');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: '' }).v2.refusalFloor).toBe('similarity');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'similarity' }).v2.refusalFloor).toBe('similarity');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'legacy_rule' }).v2.refusalFloor).toBe('legacy_rule');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'LEGACY_RULE ' }).v2.refusalFloor).toBe('legacy_rule');
    expect(configWarnings(warn)).toEqual([]);
  });

  it('an unknown value gives similarity with one warning', () => {
    for (let i = 0; i < 3; i += 1) expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'bogus' }).v2.refusalFloor).toBe('similarity');
    const lines = configWarnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('RAG_REFUSAL_FLOOR');
    expect(loadRagConfig({ RAG_REFUSAL_FLOOR: 'bogus' }).warnings).toHaveLength(1);
  });

  it('is part of the memo key', () => {
    const a = loadRagConfig({ RAG_PIPELINE: 'v2' });
    const b = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_REFUSAL_FLOOR: 'legacy_rule' });
    expect(a).not.toBe(b);
    expect(a.v2.refusalFloor).toBe('similarity');
    expect(b.v2.refusalFloor).toBe('legacy_rule');
  });
});

describe('legacyRuleFloor', () => {
  const terms = legacyQueryTerms('where is the widget manual');

  it('is not applied without candidates', () => {
    expect(legacyRuleFloor({ candidates: [], terms, floors })).toMatchObject({ decision: 'not_applied', reason: 'no_candidates' });
  });

  it('answers on a filename term match below both floors', () => {
    const record = legacyRuleFloor({
      candidates: [{ similarity: 0.2, hasImage: false, filename: 'Widget-Guide.pdf', text: 'unrelated sample text' }],
      terms,
      floors,
    });
    expect(record).toMatchObject({ decision: 'answer', basis: 'none', reason: 'query_term_match', topScore: 0.2, threshold: 0.65 });
  });

  it('answers by similarity or image with the similarity reason', () => {
    const bySimilarity = legacyRuleFloor({
      candidates: [{ similarity: 0.7, hasImage: false, filename: 'a.txt', text: 'none' }],
      terms,
      floors,
    });
    expect(bySimilarity).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor', topScore: 0.7 });
    const byImage = legacyRuleFloor({
      candidates: [{ similarity: 0.3, hasImage: true, filename: 'a.png', text: '' }],
      terms,
      floors,
    });
    expect(byImage).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor', topScore: 0.3 });
  });

  it('refuses when nothing passes, with the best similarity and the text floor', () => {
    const record = legacyRuleFloor({
      candidates: [
        { similarity: 0.4, hasImage: false, filename: 'a.txt', text: 'first sample passage' },
        { similarity: 0.5, hasImage: false, filename: 'b.txt', text: 'second sample passage' },
        { similarity: null, hasImage: false, filename: 'c.txt', text: 'third sample passage' },
      ],
      terms,
      floors,
    });
    expect(record).toEqual({
      decision: 'refuse',
      basis: 'similarity_floor',
      reason: 'below_similarity_floor',
      topScore: 0.5,
      threshold: 0.65,
      cellKey: null,
    });
  });

  it('refuses with a null top score when no candidate is dense', () => {
    const record = legacyRuleFloor({
      candidates: [{ similarity: null, hasImage: false, filename: 'a.txt', text: 'sample passage' }],
      terms,
      floors,
    });
    expect(record).toMatchObject({ decision: 'refuse', reason: 'below_similarity_floor', topScore: null, threshold: 0.65 });
  });

  it('answers a lexical-only candidate on a term match in its text', () => {
    const record = legacyRuleFloor({
      candidates: [{ similarity: null, hasImage: false, filename: 'a.txt', text: 'The Widget manual covers setup.' }],
      terms,
      floors,
    });
    expect(record).toMatchObject({ decision: 'answer', reason: 'query_term_match', topScore: null });
  });

  it('uses the floors it is given', () => {
    const record = legacyRuleFloor({
      candidates: [{ similarity: 0.2, hasImage: false, filename: 'a.txt', text: 'sample' }],
      terms: [],
      floors: { text: 0.15, image: 0.1 },
    });
    expect(record).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor', threshold: 0.15 });
  });
});

const scope = mintScope('single', null, null);
const QUERY = 'where is the widget manual';

function pool(rows: Array<Partial<RankedHit>>): FusedHit[] {
  return rows.map((over, index) => ({
    hit: hit(`c${index}`, { rank: index + 1, documentId: `d${index}`, similarity: 0.3, content: `sample passage ${index}`, ...over }),
    score: 1 / (60 + index + 1),
    ranks: { 'dense:0': index + 1 },
  }));
}

function doc(filename: string, contentPreview = ''): RankedHit['document'] {
  return { filename, createdAt: null, metadata: {}, contentPreview };
}

async function rank(
  env: Record<string, string>,
  hits: FusedHit[],
  options: { profile?: Profile; stageOverrides?: StageOverrides } = {},
) {
  installDeps({ ragEnv: () => env });
  const profile = options.profile ?? 'chat';
  const signal = new AbortController().signal;
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const out = await runRankStages({
    input: { scope, query: QUERY, profile, signal },
    config: loadRagConfig(env),
    profile,
    embedding: { vector: [0.1], profile: null },
    queryLanguage: 'en',
    fusedHits: hits,
    referenced: null,
    signal,
    collector,
    stageOverrides: options.stageOverrides,
  });
  return { out, refusalStage: collector.stages().find((row) => row.name === 'refusal') };
}

const V2 = { RAG_PIPELINE: 'v2', RAG_RERANKER: 'none', RAG_LEXICAL_SEARCH: 'false' };
const LEGACY_RULE = { ...V2, RAG_REFUSAL_FLOOR: 'legacy_rule' };

describe('v2 refusal stage floor policy', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRerankerFactoryForTests();
    vi.restoreAllMocks();
  });

  it('legacy rule answers on a term match', async () => {
    const inText = pool([{ similarity: 0.2 }, { similarity: 0.25, content: 'The widget arrives in two parts.' }]);
    const a = await rank(LEGACY_RULE, inText);
    expect(a.out.decision).toMatchObject({ decision: 'answer', reason: 'query_term_match', topScore: 0.25, threshold: 0.65 });
    expect(a.out.survivors).toHaveLength(2);
    expect(a.refusalStage?.detail).toContain('floor=legacy_rule');

    const inName = pool([{ similarity: 0.2, document: doc('Widget-Notes.md') }]);
    expect((await rank(LEGACY_RULE, inName)).out.decision).toMatchObject({ decision: 'answer', reason: 'query_term_match' });

    const inPreview = pool([{ similarity: 0.2, document: doc('notes.md', 'Overview of the manual layout') }]);
    expect((await rank(LEGACY_RULE, inPreview)).out.decision).toMatchObject({ decision: 'answer', reason: 'query_term_match' });

    const lexicalOnly = pool([{ similarity: null, lexicalScore: 3, content: 'widget sample' }]);
    expect((await rank(LEGACY_RULE, lexicalOnly)).out.decision).toMatchObject({ decision: 'answer', topScore: null });
  });

  it('legacy rule refuses a near miss', async () => {
    const nearMiss = pool([{ similarity: 0.6 }, { similarity: 0.5, document: doc('other.md', 'unrelated sample preview') }]);
    const a = await rank(LEGACY_RULE, nearMiss);
    expect(a.out.decision).toEqual({
      decision: 'refuse',
      basis: 'similarity_floor',
      reason: 'below_similarity_floor',
      topScore: 0.6,
      threshold: 0.65,
      cellKey: null,
    });
    expect(a.out.survivors).toEqual([]);
    expect(a.refusalStage?.detail).toBe('similarity_floor floor=legacy_rule');
  });

  it('similarity policy is unchanged and its stage detail names no policy', async () => {
    const termHits = pool([{ similarity: 0.2, content: 'The widget arrives in two parts.' }]);
    const a = await rank(V2, termHits);
    expect(a.out.decision).toEqual({
      decision: 'refuse',
      basis: 'similarity_floor',
      reason: 'below_similarity_floor',
      topScore: 0.2,
      threshold: 0.65,
      cellKey: null,
    });
    expect(a.refusalStage?.detail).toBe('similarity_floor');
    const b = await rank({ ...V2, RAG_REFUSAL_FLOOR: 'similarity' }, pool([{ similarity: 0.7 }]));
    expect(b.out.decision).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor' });
    expect(b.refusalStage?.detail).toBe('above_similarity_floor');
  });

  it('calibrated gate overrides the floor', async () => {
    const key = cellKey('cohere', 'fake-quality-v1', 'en', 'same');
    const cells: ThresholdCells = new Map([
      [
        key,
        {
          key,
          provider: 'cohere',
          model: 'fake-quality-v1',
          query_language: 'en',
          pairing: 'same',
          threshold: 0.6,
          status: 'calibrated',
          source: 'fixture',
          tokenizer_version: LEXICAL_VERSION,
          rerank_text_version: RERANK_TEXT_VERSION,
        },
      ],
    ]);
    vi.spyOn(thresholds, 'loadThresholds').mockReturnValue({ cells, configHash: null });
    const reranker: Reranker = {
      id: 'cohere',
      model: 'fake-quality-v1',
      scoreSemantics: 'calibrated',
      async rerank(_query, docs) {
        return { scores: docs.map((_, index) => ({ index, score: 0.3 })) };
      },
    };
    setRerankerFactoryForTests(() => reranker);
    const env = {
      ...LEGACY_RULE,
      RAG_RERANKER: 'cohere',
      RAG_REFUSAL_THRESHOLD: 'true',
      COHERE_API_KEY: 'cohere-test-placeholder-key',
    };
    const termHits = pool([{ similarity: 0.9, content: 'The widget arrives in two parts.' }]);
    const a = await rank(env, termHits, {
      profile: 'eval',
      stageOverrides: { retrievalOverrides: { rerankModel: 'fake-quality-v1' } },
    });
    expect(a.out.decision).toMatchObject({ decision: 'refuse', basis: 'rerank_threshold', threshold: 0.6 });
    expect(a.out.survivors).toEqual([]);
    expect(a.refusalStage?.detail).toBe('rerank_threshold');
  });
});
