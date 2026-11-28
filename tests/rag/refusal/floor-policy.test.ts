import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { RankedHit } from '@/lib/rag/backend/types';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { legacyQueryTerms } from '@/lib/rag/context/relevance';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import {
  LEGACY_IMAGE_FLOOR,
  LEGACY_TEXT_FLOOR,
  legacyRuleFloor,
  resetEvalScoreCalibration,
  setEvalScoreCalibration,
} from '@/lib/rag/refusal/floor';
import { cellKey, type ThresholdCells } from '@/lib/rag/refusal/gate';
import * as thresholds from '@/lib/rag/refusal/thresholds';
import { rerankerSupportedLanguages } from '@/lib/rag/rerank/languages';
import { resetRerankerFactoryForTests, setRerankerFactoryForTests } from '@/lib/rag/rerank/select';
import { RERANK_TEXT_VERSION, type Reranker } from '@/lib/rag/rerank/types';
import { EXACT_ID_LIMIT } from '@/lib/rag/retrieval/exact-id';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { Profile, RetrievalOptions, StageOverrides } from '@/lib/rag/types';
import type { EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import { resetCalibrationWarningsForTests } from '@/lib/rag/legacy/enhanced-retrieval';
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
  options: {
    profile?: Profile;
    stageOverrides?: StageOverrides;
    embeddingProfile?: EmbeddingProfile | null;
    inputOptions?: RetrievalOptions;
  } = {},
) {
  installDeps({ ragEnv: () => env });
  const profile = options.profile ?? 'chat';
  const signal = new AbortController().signal;
  const collector = createTraceCollector({ profile, tenantKey: 's:default' });
  const out = await runRankStages({
    input: { scope, query: QUERY, profile, signal, ...(options.inputOptions ? { options: options.inputOptions } : {}) },
    config: loadRagConfig(env),
    profile,
    embedding: { vector: [0.1], profile: options.embeddingProfile ?? null },
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
    const inText = pool([{ similarity: 0.4 }, { similarity: 0.45, content: 'The widget arrives in two parts.' }]);
    const a = await rank(LEGACY_RULE, inText);
    expect(a.out.decision).toMatchObject({ decision: 'answer', reason: 'query_term_match', topScore: 0.45, threshold: 0.65 });
    expect(a.out.survivors).toHaveLength(2);
    expect(a.refusalStage?.detail).toContain('floor=legacy_rule');

    const inName = pool([{ similarity: 0.4, document: doc('Widget-Notes.md') }]);
    expect((await rank(LEGACY_RULE, inName)).out.decision).toMatchObject({ decision: 'answer', reason: 'query_term_match' });

    const inPreview = pool([{ similarity: 0.4, document: doc('notes.md', 'Overview of the manual layout') }]);
    expect((await rank(LEGACY_RULE, inPreview)).out.decision).toMatchObject({ decision: 'answer', reason: 'query_term_match' });
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
    expect(a.refusalStage?.detail).toBe('similarity_floor floor=legacy_rule pool=2');
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
      supportedLanguages: rerankerSupportedLanguages('cohere'),
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

    const exactOnly: FusedHit = { hit: hit('x0', { rank: 1, documentId: 'dx', similarity: 1, content: 'sample passage' }), score: 1 / 61, ranks: { exact_id: 1 } };
    const b = await rank(env, [exactOnly], {
      profile: 'eval',
      stageOverrides: { retrievalOverrides: { rerankModel: 'fake-quality-v1' } },
    });
    expect(b.out.decision).toMatchObject({ decision: 'refuse', basis: 'rerank_threshold', threshold: 0.6 });
    expect(b.refusalStage?.detail).toBe('rerank_threshold');
  });
});

function profileWith(scoreCalibration: Record<string, number>): EmbeddingProfile {
  return {
    id: 'floor-test-profile',
    provider: 'openai',
    model: 'floor-test-model',
    dims: 1,
    storage: 'halfvec',
    status: 'active',
    queryInstruction: null,
    scoreCalibration,
    activatedAt: null,
    activatedBy: null,
    previousActiveId: null,
    hasEvidence: false,
  };
}

function only(ranks: Record<string, number>, over: Partial<RankedHit>): FusedHit {
  return { hit: hit('x0', { rank: 1, documentId: 'dx', content: 'sample passage', ...over }), score: 1 / 61, ranks };
}

describe('legacy rule pool', () => {
  beforeEach(() => {
    resetCalibrationWarningsForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetEvalScoreCalibration();
    delete process.env.RAG_EVAL_RETRIEVAL_MIN_SIMILARITY;
    vi.restoreAllMocks();
  });

  it('legacy rule uses the legacy keep floors', async () => {
    setEvalScoreCalibration({ context_threshold: 0.2 });
    const between = pool([{ similarity: 0.5 }]);
    expect((await rank(LEGACY_RULE, between, { profile: 'eval' })).out.decision).toMatchObject({
      decision: 'refuse',
      threshold: 0.65,
      topScore: 0.5,
    });
    expect((await rank(V2, between, { profile: 'eval' })).out.decision).toMatchObject({ decision: 'answer', threshold: 0.2 });

    resetEvalScoreCalibration();
    const calibrated = profileWith({ context_threshold: 0.2 });
    expect((await rank(LEGACY_RULE, between, { embeddingProfile: calibrated })).out.decision).toMatchObject({
      decision: 'refuse',
      threshold: 0.65,
    });
    expect((await rank(V2, between, { embeddingProfile: calibrated })).out.decision).toMatchObject({ decision: 'answer', threshold: 0.2 });
  });

  it('lexical-only candidate cannot answer', async () => {
    const lexicalOnly = only({ 'lexical:0': 1 }, { similarity: null, lexicalScore: 3, content: 'widget sample' });
    const a = await rank(LEGACY_RULE, [lexicalOnly]);
    expect(a.out.decision).toMatchObject({ decision: 'refuse', reason: 'below_similarity_floor' });
    expect(a.refusalStage?.detail).toBe('similarity_floor floor=legacy_rule pool=0');

    const scored = only({ 'lexical:0': 1 }, { similarity: 0.5, lexicalScore: 3, document: doc('Widget-Notes.md') });
    expect((await rank(LEGACY_RULE, [scored])).out.decision).toMatchObject({ decision: 'refuse' });
  });

  it('exact_id rows are pool members judged with the legacy keep rule', async () => {
    const exactOnly = only({ exact_id: 1 }, { similarity: 1, content: 'sample passage' });
    const a = await rank(LEGACY_RULE, [exactOnly]);
    expect(a.out.decision).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor', topScore: 1 });
    expect(a.refusalStage?.detail).toBe('above_similarity_floor floor=legacy_rule pool=1 exact=1');

    const exactAndLowDense = only({ 'dense:0': 1, exact_id: 1 }, { similarity: 0.24, content: 'sample passage' });
    const b = await rank(LEGACY_RULE, [exactAndLowDense]);
    expect(b.out.decision).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor', topScore: 1 });
    expect(b.refusalStage?.detail).toBe('above_similarity_floor floor=legacy_rule pool=1 exact=1');

    const syntheticNotExact = only({ 'lexical:0': 1 }, { similarity: 1, lexicalScore: 3, content: 'sample passage' });
    const c = await rank(LEGACY_RULE, [syntheticNotExact]);
    expect(c.out.decision).toMatchObject({ decision: 'refuse' });
    expect(c.refusalStage?.detail).toBe('similarity_floor floor=legacy_rule pool=0');

    const lexicalOnly = only({ 'lexical:0': 1 }, { similarity: null, lexicalScore: 3, content: 'widget sample' });
    expect((await rank(LEGACY_RULE, [lexicalOnly])).out.decision).toMatchObject({ decision: 'refuse' });
  });

  it('exact_id rows merge as legacy merges them', async () => {
    const rows = (count: number, ranks: (index: number) => Record<string, number>, similarity: number | null): FusedHit[] =>
      Array.from({ length: count }, (_, index) => ({
        hit: hit(`e${index}`, { rank: index + 1, documentId: `de${index}`, similarity, content: `sample passage e${index}` }),
        score: 1 / (60 + index + 1),
        ranks: ranks(index),
      }));
    const dense = pool([{ similarity: 0.6 }, { similarity: 0.55 }, { similarity: 0.5 }]);
    const oneExact = rows(1, () => ({ exact_id: 1 }), 1);
    const capped = await rank(LEGACY_RULE, [...dense, ...oneExact], { inputOptions: { maxResults: 2 } });
    expect(capped.out.decision).toMatchObject({ decision: 'answer' });
    expect(capped.refusalStage?.detail).toBe('above_similarity_floor floor=legacy_rule pool=2 exact=1');

    const threeExact = rows(3, (index) => ({ exact_id: index + 1 }), 1);
    const beyond = await rank(LEGACY_RULE, [...dense, ...threeExact], { inputOptions: { maxResults: 2 } });
    expect(beyond.refusalStage?.detail).toBe('above_similarity_floor floor=legacy_rule pool=3 exact=3');

    const many = rows(EXACT_ID_LIMIT + 2, (index) => ({ exact_id: index + 1 }), 1);
    const limited = await rank(LEGACY_RULE, many);
    expect(limited.refusalStage?.detail).toBe(`above_similarity_floor floor=legacy_rule pool=${EXACT_ID_LIMIT} exact=${EXACT_ID_LIMIT}`);
  });

  it('no exact_id list: pool, decision and detail unchanged', async () => {
    const beyondCount = pool([{ similarity: 0.6 }, { similarity: 0.55 }, { similarity: 0.5 }]);
    const capped = await rank(LEGACY_RULE, beyondCount, { inputOptions: { maxResults: 2 } });
    expect(capped.out.decision).toEqual({
      decision: 'refuse',
      basis: 'similarity_floor',
      reason: 'below_similarity_floor',
      topScore: 0.6,
      threshold: 0.65,
      cellKey: null,
    });
    expect(capped.refusalStage?.detail).toBe('similarity_floor floor=legacy_rule pool=2');
  });

  it('voice admits no exact_id row: the legacy voice search has no exact lookup', async () => {
    const exactOnly = only({ exact_id: 1 }, { similarity: 1, content: 'sample passage' });
    const voice = await rank(LEGACY_RULE, [exactOnly], { profile: 'voice' });
    expect(voice.out.decision).toMatchObject({ decision: 'refuse' });
    expect(voice.refusalStage?.detail).toBe('similarity_floor floor=legacy_rule pool=0');
  });

  it('similarity floor and an applied threshold gate are unchanged by exact_id rows', async () => {
    const exactAndLowDense = only({ 'dense:0': 1, exact_id: 1 }, { similarity: 0.24, content: 'sample passage' });
    const a = await rank(V2, [exactAndLowDense]);
    expect(a.out.decision).toMatchObject({ decision: 'refuse', topScore: 0.24 });
    expect(a.refusalStage?.detail).toBe('similarity_floor');
  });

  it('outside the legacy pool', async () => {
    const below = pool([{ similarity: 0.3, content: 'The widget arrives in two parts.' }]);
    expect((await rank(LEGACY_RULE, below)).out.decision).toMatchObject({ decision: 'refuse', topScore: 0.3 });
    const above = pool([{ similarity: 0.36, content: 'The widget arrives in two parts.' }]);
    expect((await rank(LEGACY_RULE, above)).out.decision).toMatchObject({ decision: 'answer', reason: 'query_term_match' });

    const beyondCount = pool([
      { similarity: 0.6 },
      { similarity: 0.55 },
      { similarity: 0.5, content: 'The widget arrives in two parts.' },
    ]);
    const capped = await rank(LEGACY_RULE, beyondCount, { inputOptions: { maxResults: 2 } });
    expect(capped.out.decision).toMatchObject({ decision: 'refuse' });
    expect(capped.refusalStage?.detail).toBe('similarity_floor floor=legacy_rule pool=2');
  });

  it('non-legacy profile scales the pool', async () => {
    const termHit = (similarity: number) => pool([{ similarity, content: 'The widget arrives in two parts.' }]);
    const scaled = profileWith({ retrieval_threshold: 0.35, fallback_threshold: 0.14 });
    expect((await rank(LEGACY_RULE, termHit(0.18), { embeddingProfile: scaled })).out.decision).toMatchObject({ decision: 'answer' });
    expect((await rank(LEGACY_RULE, termHit(0.17), { embeddingProfile: scaled })).out.decision).toMatchObject({ decision: 'refuse' });
    const missing = profileWith({});
    expect((await rank(LEGACY_RULE, termHit(0.18), { embeddingProfile: missing })).out.decision).toMatchObject({ decision: 'refuse' });
  });

  it('eval RPC threshold override applies as in legacy', async () => {
    process.env.RAG_EVAL_RETRIEVAL_MIN_SIMILARITY = '0.1';
    const termHit = pool([{ similarity: 0.2, content: 'The widget arrives in two parts.' }]);
    const withProfile = await rank(LEGACY_RULE, termHit, { profile: 'eval', inputOptions: { embeddingProfile: 'eval-profile' } });
    expect(withProfile.out.decision).toMatchObject({ decision: 'answer' });
    expect((await rank(LEGACY_RULE, termHit, { profile: 'eval' })).out.decision).toMatchObject({ decision: 'refuse' });
  });

  it('voice replays the legacy voice search', async () => {
    const termHit = (similarity: number) => pool([{ similarity, content: 'The widget arrives in two parts.' }]);
    expect((await rank(LEGACY_RULE, termHit(0.2), { profile: 'voice' })).out.decision).toMatchObject({ decision: 'answer' });
    expect((await rank(LEGACY_RULE, termHit(0.2))).out.decision).toMatchObject({ decision: 'refuse' });
    expect((await rank(LEGACY_RULE, termHit(0.14), { profile: 'voice' })).out.decision).toMatchObject({ decision: 'refuse' });
    const sixth = pool([
      { similarity: 0.6 },
      { similarity: 0.59 },
      { similarity: 0.58 },
      { similarity: 0.57 },
      { similarity: 0.56 },
      { similarity: 0.55, content: 'The widget arrives in two parts.' },
    ]);
    const voice = await rank(LEGACY_RULE, sixth, { profile: 'voice', inputOptions: { maxResults: 1 } });
    expect(voice.out.decision).toMatchObject({ decision: 'refuse' });
    expect(voice.refusalStage?.detail).toBe('similarity_floor floor=legacy_rule pool=5');
  });

  it('default unchanged: the similarity floor judges every fused hit', async () => {
    const lexicalOnly = only({ 'lexical:0': 1 }, { similarity: 0.7 });
    const a = await rank(V2, [lexicalOnly]);
    expect(a.out.decision).toEqual({
      decision: 'answer',
      basis: 'none',
      reason: 'above_similarity_floor',
      topScore: 0.7,
      threshold: 0.65,
      cellKey: null,
    });
    expect(a.refusalStage?.detail).toBe('above_similarity_floor');
  });
});

interface DocumentRead {
  table: string;
  ids: string[];
}

/** An admin client whose documents table holds the given full texts; every read is recorded, and `fail` makes the documents read error. */
function documentsAdmin(contents: Record<string, string>, options: { fail?: boolean } = {}) {
  const reads: DocumentRead[] = [];
  const client = {
    from(table: string) {
      const read: DocumentRead = { table, ids: [] };
      const builder = {
        select() {
          return builder;
        },
        in(_column: string, values: string[]) {
          read.ids = values;
          return builder;
        },
        abortSignal() {
          return builder;
        },
        then(onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) {
          reads.push(read);
          if (options.fail && table === 'documents') {
            return Promise.resolve({ data: null, error: { message: 'sample failure' } }).then(onFulfilled, onRejected);
          }
          const data =
            table === 'documents'
              ? read.ids
                  .filter((id) => id in contents)
                  .map((id) => ({ id, filename: `${id}.md`, created_at: null, content: contents[id], metadata: null }))
              : read.ids.map((id) => ({ id, metadata: null }));
          return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  return { adminClient: () => client as never, reads, documentReads: () => reads.filter((row) => row.table === 'documents') };
}

async function rankWith(
  env: Record<string, string>,
  hits: FusedHit[],
  admin: ReturnType<typeof documentsAdmin>,
  options: { profile?: Profile; stageOverrides?: StageOverrides } = {},
) {
  installDeps({ ragEnv: () => env, adminClient: admin.adminClient });
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

const FILLER = 'neutral sample sentence about nothing in particular. '.repeat(6);
const LONG_WITH_TERM = `${FILLER}The manual is kept in the second section.`;

describe('legacy rule evidence read', () => {
  beforeEach(() => {
    resetCalibrationWarningsForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRerankerFactoryForTests();
    vi.restoreAllMocks();
  });

  it('a term found only beyond the preview of a pool member document answers, as legacy does', async () => {
    expect(LONG_WITH_TERM.slice(0, 200)).not.toContain('manual');
    const admin = documentsAdmin({ d0: LONG_WITH_TERM });
    const hits = pool([{ similarity: 0.4, document: doc('notes.md', LONG_WITH_TERM.slice(0, 200)) }]);
    const a = await rankWith(LEGACY_RULE, hits, admin);
    expect(a.out.decision).toMatchObject({ decision: 'answer', reason: 'query_term_match', topScore: 0.4, threshold: 0.65 });
    expect(admin.documentReads()).toHaveLength(1);
    expect(admin.documentReads()[0]!.ids).toEqual(['d0']);
    expect(a.refusalStage?.status).toBe('ok');
    expect(a.refusalStage?.counts).toMatchObject({ answered: 1, evidence_documents: 1 });
  });

  it('a document without the term still refuses after the read', async () => {
    const admin = documentsAdmin({ d0: `${FILLER}${FILLER}` });
    const a = await rankWith(LEGACY_RULE, pool([{ similarity: 0.4, document: doc('notes.md', FILLER.slice(0, 200)) }]), admin);
    expect(a.out.decision).toMatchObject({ decision: 'refuse', basis: 'similarity_floor' });
    expect(admin.documentReads()).toHaveLength(1);
  });

  it('no read when a pool member already passes on similarity, image, filename or chunk text', async () => {
    const admin = documentsAdmin({ d0: LONG_WITH_TERM, d1: LONG_WITH_TERM });
    const cases: FusedHit[][] = [
      pool([{ similarity: 0.7 }]),
      pool([{ similarity: 0.4, document: doc('figure.png'), metadata: { image_url: 'https://storage.example.test/x.png' } }]),
      pool([{ similarity: 0.4, document: doc('Manual-Notes.md') }]),
      pool([{ similarity: 0.4 }, { similarity: 0.45, content: 'The manual arrives in two parts.' }]),
    ];
    for (const hits of cases) {
      const a = await rankWith(LEGACY_RULE, hits, admin);
      expect(a.out.decision.decision).toBe('answer');
      expect(a.refusalStage?.counts?.evidence_documents).toBeUndefined();
    }
    expect(admin.documentReads()).toEqual([]);
  });

  it('no read under the similarity floor', async () => {
    const admin = documentsAdmin({ d0: LONG_WITH_TERM });
    const a = await rankWith(V2, pool([{ similarity: 0.4, document: doc('notes.md', LONG_WITH_TERM.slice(0, 200)) }]), admin);
    expect(a.out.decision).toMatchObject({ decision: 'refuse' });
    expect(admin.reads).toEqual([]);
  });

  it('no read when the rerank threshold gate applied', async () => {
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
      supportedLanguages: rerankerSupportedLanguages('cohere'),
      async rerank(_query, docs) {
        return { scores: docs.map((_, index) => ({ index, score: 0.3 })) };
      },
    };
    setRerankerFactoryForTests(() => reranker);
    const env = { ...LEGACY_RULE, RAG_RERANKER: 'cohere', RAG_REFUSAL_THRESHOLD: 'true', COHERE_API_KEY: 'cohere-test-placeholder-key' };
    const admin = documentsAdmin({ d0: LONG_WITH_TERM });
    const a = await rankWith(env, pool([{ similarity: 0.4, document: doc('notes.md', LONG_WITH_TERM.slice(0, 200)) }]), admin, {
      profile: 'eval',
      stageOverrides: { retrievalOverrides: { rerankModel: 'fake-quality-v1' } },
    });
    expect(a.out.decision).toMatchObject({ decision: 'refuse', basis: 'rerank_threshold' });
    expect(admin.documentReads()).toEqual([]);
  });

  it('a candidate outside the legacy pool is not judged on its document text', async () => {
    const admin = documentsAdmin({ d0: LONG_WITH_TERM });
    const below = pool([{ similarity: 0.3, document: doc('notes.md', LONG_WITH_TERM.slice(0, 200)) }]);
    expect((await rankWith(LEGACY_RULE, below, admin)).out.decision).toMatchObject({ decision: 'refuse' });
    const lexicalOnly = only({ 'lexical:0': 1 }, { similarity: 0.5, documentId: 'd0', document: doc('notes.md', LONG_WITH_TERM.slice(0, 200)) });
    expect((await rankWith(LEGACY_RULE, [lexicalOnly], admin)).out.decision).toMatchObject({ decision: 'refuse' });
    expect(admin.documentReads()).toEqual([]);
  });

  it('reads only the pool members documents, and answers only from them', async () => {
    const admin = documentsAdmin({ d0: `${FILLER}${FILLER}`, d1: LONG_WITH_TERM });
    const hits = pool([{ similarity: 0.4, document: doc('a.md', FILLER.slice(0, 200)) }, { similarity: 0.3, document: doc('b.md', LONG_WITH_TERM.slice(0, 200)) }]);
    const a = await rankWith(LEGACY_RULE, hits, admin);
    expect(a.out.decision).toMatchObject({ decision: 'refuse' });
    expect(admin.documentReads().map((row) => row.ids)).toEqual([['d0']]);
  });

  it('a pool that holds an exact_id member reads nothing', async () => {
    const admin = documentsAdmin({ d0: LONG_WITH_TERM, dx: LONG_WITH_TERM });
    const hits = [
      ...pool([{ similarity: 0.4, document: doc('notes.md', LONG_WITH_TERM.slice(0, 200)) }]),
      only({ exact_id: 1 }, { similarity: 1, content: 'sample passage', document: doc('other.md', FILLER.slice(0, 200)) }),
    ];
    const a = await rankWith(LEGACY_RULE, hits, admin);
    expect(a.out.decision).toMatchObject({ decision: 'answer', reason: 'above_similarity_floor' });
    expect(a.refusalStage?.counts?.evidence_documents).toBeUndefined();
    expect(admin.documentReads()).toEqual([]);
  });

  it('a failed read skips the stage and decides on the hits text, never answering from the read', async () => {
    const admin = documentsAdmin({ d0: LONG_WITH_TERM }, { fail: true });
    const a = await rankWith(LEGACY_RULE, pool([{ similarity: 0.4, document: doc('notes.md', LONG_WITH_TERM.slice(0, 200)) }]), admin);
    expect(a.refusalStage).toMatchObject({ status: 'skipped', reason: 'failed' });
    expect(a.out.decision).toMatchObject({ decision: 'refuse', basis: 'similarity_floor' });
    expect(admin.documentReads()).toHaveLength(1);
  });
});
