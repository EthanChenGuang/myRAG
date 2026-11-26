import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, BackendTranslationSearchRequest, RetrievalBackend, TranslationHit } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { rrf } from '@/lib/rag/fusion/rrf';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { preferOriginalHits, translationLists, type TranslationLegsPlan } from '@/lib/rag/v2/translation-legs';
import type { StageOverrides } from '@/lib/rag/types';
import { hit } from './fusion/helpers';
import { fakeEmbedder, installDeps, uninstallDeps } from './helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const QUERY = 'neutral sample question about the widget';

function trHit(chunkId: string, leg: 'dense' | 'lexical', rank: number, language = 'en', overrides: Partial<TranslationHit['hit']> = {}): TranslationHit {
  return {
    leg,
    translationLanguage: language,
    hit: hit(chunkId, { rank, similarity: leg === 'dense' ? 0.97 : null, lexicalScore: leg === 'lexical' ? 3.5 : null, language: 'it', ...overrides }),
  };
}

function config(over: Record<string, string> = {}): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_DOC_TRANSLATION: 'on', ...over });
}

function mainLegs(): BackendLegs {
  return {
    dense: ['a', 'b'].map((chunkId, index) => hit(chunkId, { rank: index + 1, similarity: 0.8 - index * 0.1, language: 'it' })),
    lexical: [],
  };
}

interface BackendRecord {
  translationRequests: BackendTranslationSearchRequest[];
}

function translatingBackend(
  translate: (req: BackendTranslationSearchRequest) => Promise<TranslationHit[]>,
  main: () => BackendLegs = mainLegs,
): RetrievalBackend & BackendRecord {
  const record: BackendRecord = { translationRequests: [] };
  return Object.assign(record, {
    id: 'pgvector' as const,
    search: async () => main(),
    searchTranslations: async (req: BackendTranslationSearchRequest) => {
      record.translationRequests.push(req);
      return translate(req);
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  });
}

async function runWith(
  backend: RetrievalBackend,
  plan: TranslationLegsPlan | undefined,
  options: { cfg?: RagConfig; stageOverrides?: StageOverrides; filters?: Record<string, unknown> } = {},
) {
  const cfg = options.cfg ?? config();
  const params = effectiveRetrievalParams('eval', cfg, null);
  setRetrievalBackendForTests(backend);
  const { embedder } = fakeEmbedder();
  installDeps({ embedder, ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true' }) });
  await verifyV2Startup();
  const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
  const output = await runSearchStages({
    input: { scope, query: QUERY, profile: 'eval', signal: new AbortController().signal },
    scope,
    config: cfg,
    profile: 'eval',
    params,
    embedding: { vector: [0.1, 0.2, 0.3], profile: null },
    signal: new AbortController().signal,
    collector,
    ...(options.stageOverrides ? { stageOverrides: options.stageOverrides } : {}),
    ...(options.filters ? { filters: { currentOnly: true as const, ...options.filters } } : {}),
    ...(plan ? { translations: plan } : {}),
  });
  return {
    fused: output.fusedHits.map((row) => ({ id: row.hit.chunkId, similarity: row.hit.similarity, content: row.hit.content, ranks: row.ranks })),
    search: collector.stages().find((row) => row.name === 'search'),
    params,
  };
}

const PLAN_EN: TranslationLegsPlan = { languages: ['en'], stale: [], failures: [] };

describe('translationLists (XLG-04, D-30)', () => {
  it('builds dense_tr:<lang> and lexical_tr:<lang> of source chunk ids with similarity null', () => {
    const lists = translationLists([trHit('c', 'dense', 1), trHit('b', 'dense', 2), trHit('d', 'lexical', 1)], 'en');
    expect(lists.map((list) => list.id)).toEqual(['dense_tr:en', 'lexical_tr:en']);
    expect(lists[0]!.hits.map((entry) => [entry.chunkId, entry.rank, entry.similarity, entry.lexicalScore])).toEqual([
      ['c', 1, null, null],
      ['b', 2, null, null],
    ]);
    expect(lists[1]!.hits.map((entry) => [entry.chunkId, entry.similarity, entry.lexicalScore])).toEqual([['d', null, null]]);
  });

  it('a chunk already written in the query language is never taken from a translation', () => {
    const lists = translationLists([trHit('x', 'dense', 1, 'en', { language: 'en' }), trHit('y', 'dense', 2)], 'en');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.hits.map((entry) => [entry.chunkId, entry.rank])).toEqual([['y', 1]]);
  });

  it('fused with the main lists, a chunk in both is one entry with the original similarity; a translation-only chunk has null', () => {
    const main = mainLegs();
    const known = new Map(main.dense.map((entry) => [entry.chunkId, entry]));
    const lists = preferOriginalHits(translationLists([trHit('b', 'dense', 1), trHit('c', 'dense', 2)], 'en'), known);
    const fused = rrf([{ id: 'dense:0', weight: 1, hits: main.dense }, ...lists], 60);
    expect(fused.filter((row) => row.hit.chunkId === 'b')).toHaveLength(1);
    expect(fused.find((row) => row.hit.chunkId === 'b')?.hit.similarity).toBeCloseTo(0.7);
    expect(fused.find((row) => row.hit.chunkId === 'b')?.ranks).toEqual({ 'dense:0': 2, 'dense_tr:en': 1 });
    expect(fused.find((row) => row.hit.chunkId === 'c')?.hit.similarity).toBeNull();
  });

  it('a lexical original leg read after the translation list still wins the hit object', () => {
    const lexicalOriginal = hit('b', { rank: 1, lexicalScore: 2, similarity: null, content: 'original text' });
    const lists = preferOriginalHits(translationLists([trHit('b', 'dense', 1, 'en', { content: 'original text' })], 'en'), new Map([['b', lexicalOriginal]]));
    const fused = rrf([{ id: 'lexical:0', weight: 1, hits: [lexicalOriginal] }, ...lists], 60);
    expect(fused[0]!.hit.lexicalScore).toBe(2);
  });
});

describe('translation legs in the search stage (XLG-04, D-30)', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.restoreAllMocks();
  });

  it('runs one translation search in parallel with the main search and adds its lists to RRF', async () => {
    const backend = translatingBackend(async () => [trHit('b', 'dense', 1), trHit('c', 'dense', 2), trHit('c', 'lexical', 1)]);
    const on = await runWith(backend, PLAN_EN);
    expect(backend.translationRequests).toHaveLength(1);
    expect(backend.translationRequests[0]).toMatchObject({ language: 'en', denseVector: [0.1, 0.2, 0.3] });
    expect(backend.translationRequests[0]!.scope).toBe(scope);
    expect(on.fused.map((row) => row.id).sort()).toEqual(['a', 'b', 'c']);
    const c = on.fused.find((row) => row.id === 'c');
    expect(c?.similarity).toBeNull();
    expect(c?.ranks).toEqual({ 'dense_tr:en': 2, 'lexical_tr:en': 1 });
    const b = on.fused.find((row) => row.id === 'b');
    expect(b?.similarity).toBeCloseTo(0.7);
    expect(b?.content).toBe('content-b');
    expect(on.search?.status).toBe('ok');
    expect(on.search?.counts).toMatchObject({ translation: 3 });
  });
});
