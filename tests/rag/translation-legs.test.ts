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
import {
  planTranslationLegs,
  preferOriginalHits,
  runTranslationLegs,
  translationHashFields,
  translationLists,
  type TranslationLegsPlan,
  type TranslationQueryState,
} from '@/lib/rag/v2/translation-legs';
import { createPgvectorBackend, TranslationRowInvalidError } from '@/lib/rag/backend/pgvector';
import type { RpcClient } from '@/lib/rag/backend/supabase-rpc';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';
import { registryOrder } from '@/lib/rag/lang/registry';
import { LEXICAL_VERSION } from '@/lib/rag/lexical/chunk-text';
import { RERANK_TEXT_VERSION } from '@/lib/rag/rerank/types';
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

function noPlanBackend(): RetrievalBackend & BackendRecord {
  return translatingBackend(async () => {
    throw new Error('no translation search expected');
  });
}

describe('translation legs never fail a request (D-28, D-30)', () => {
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

  it('a translation search that throws leaves the main result intact and records translation_leg_error', async () => {
    const off = await runWith(noPlanBackend(), undefined);
    const failing = await runWith(
      translatingBackend(async () => {
        throw new Error('boom');
      }),
      PLAN_EN,
    );
    expect(failing.fused).toEqual(off.fused);
    expect(failing.search?.status).toBe('degraded');
    expect(failing.search?.detail).toBe('translation_leg_error');
  });

  it('a translation search past the stage budget is dropped as translation_leg_timeout', async () => {
    const off = await runWith(noPlanBackend(), undefined);
    const hanging = await runWith(
      translatingBackend((req) => new Promise((_resolve, reject) => req.signal.addEventListener('abort', () => reject(req.signal.reason)))),
      PLAN_EN,
      { stageOverrides: { timeouts: { search: 80 } } },
    );
    expect(hanging.fused).toEqual(off.fused);
    expect(hanging.search?.status).toBe('degraded');
    expect(hanging.search?.detail).toBe('translation_leg_timeout');
  });

  it('an invalid translation row is dropped as translation_leg_invalid', async () => {
    const off = await runWith(noPlanBackend(), undefined);
    const invalid = await runWith(
      translatingBackend(async () => {
        throw new TranslationRowInvalidError();
      }),
      PLAN_EN,
    );
    expect(invalid.fused).toEqual(off.fused);
    expect(invalid.search?.detail).toBe('translation_leg_invalid');
  });

  it('a stale plan makes no translation search and records translation_stale on an ok stage', async () => {
    const off = await runWith(noPlanBackend(), undefined);
    const backend = noPlanBackend();
    const stale = await runWith(backend, { languages: [], stale: ['en'], failures: [] });
    expect(backend.translationRequests).toHaveLength(0);
    expect(stale.fused).toEqual(off.fused);
    expect(stale.search?.status).toBe('ok');
    expect(stale.search?.detail).toBe('translation_stale');
  });

  it('without a plan the search stage record equals today (no translation count, no detail)', async () => {
    const backend = noPlanBackend();
    const off = await runWith(backend, undefined);
    const empty = await runWith(backend, { languages: [], stale: [], failures: [] });
    expect(backend.translationRequests).toHaveLength(0);
    expect(empty.fused).toEqual(off.fused);
    expect(off.search?.counts).toEqual({ dense: 2, lexical: 0 });
    expect(empty.search?.counts).toEqual({ dense: 2, lexical: 0 });
    expect(empty.search?.detail).toBeUndefined();
  });

  it('a scopes filter and an effective date reach the translation search unchanged', async () => {
    const backend = translatingBackend(async () => []);
    await runWith(backend, PLAN_EN, { filters: { scopes: ['region:r1'], scopesIncludeUntagged: true, effectiveOn: '2026-01-02', docTypes: ['general'] } });
    expect(backend.translationRequests[0]!.filters).toEqual({
      currentOnly: true,
      scopes: ['region:r1'],
      scopesIncludeUntagged: true,
      effectiveOn: '2026-01-02',
      docTypes: ['general'],
    });
  });

  it('two runs give identical fused orders; translation lists come in registry order of languages', async () => {
    const make = () =>
      translatingBackend(async (req) => [
        trHit(`t-${req.language}`, 'dense', 1, req.language, { language: 'zh' }),
        trHit('b', 'dense', 2, req.language, { language: 'zh' }),
      ]);
    const plan: TranslationLegsPlan = { languages: ['it', 'en'], stale: [], failures: [] };
    const first = await runWith(make(), plan);
    const second = await runWith(make(), plan);
    expect(first.fused).toEqual(second.fused);
    const output = await runTranslationLegs({
      backend: make(),
      scope,
      plan,
      queryText: QUERY,
      queryEmbedding: { vector: [0.1, 0.2, 0.3], profile: null },
      embeddingProfileId: 'openai-3-small-1536',
      filters: { currentOnly: true },
      params: first.params,
      lexicalEnabled: false,
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    expect(output.lists.map((list) => list.id)).toEqual(registryOrder(['it', 'en']).map((language) => `dense_tr:${language}`));
  });
});

describe('pgvector searchTranslations (0810)', () => {
  function rpcReturning(data: unknown, seen: Array<{ fn: string; args: Record<string, unknown> }>): RpcClient {
    return {
      rpc(fn: string, args: Record<string, unknown>) {
        seen.push({ fn, args });
        return { abortSignal: async () => ({ data, error: null }) };
      },
    } as unknown as RpcClient;
  }

  const row = {
    leg: 'dense',
    rank: 1,
    chunk_id: 'c1',
    document_id: 'd1',
    translation_id: 't1',
    translation_language: 'en',
    content: 'original text',
    metadata: {},
    chunk_index: 0,
    translation_similarity: 0.9,
    lexical_score: null,
    doc_type: 'general',
    language: 'it',
    parent_id: null,
    section_path: [],
    chunk_kind: 'text',
    document_filename: 'f.md',
    document_created_at: null,
    document_metadata: {},
    document_content_preview: '',
  };

  it('passes the request filters, scopes and effective date and maps rows to the source chunk', async () => {
    const seen: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const backend = createPgvectorBackend({ adminClient: () => rpcReturning([row], seen), getConfig: () => config() });
    const hits = await backend.searchTranslations!({
      scope,
      embeddingProfileId: 'openai-3-small-1536',
      language: 'en',
      denseVector: [0.1],
      lexicalTokens: [],
      filters: { currentOnly: true, scopes: ['region:r1'], effectiveOn: '2026-01-02' },
      denseLimit: 10,
      lexicalLimit: 10,
      signal: new AbortController().signal,
    });
    expect(seen[0]!.fn).toBe('hybrid_search_translations');
    expect(seen[0]!.args).toMatchObject({ p_language: 'en', p_scopes: ['region:r1'], p_effective_on: '2026-01-02', p_lexical_limit: 0, p_dense_limit: 10 });
    expect(hits).toEqual([expect.objectContaining({ leg: 'dense', translationLanguage: 'en' })]);
    expect(hits[0]!.hit).toMatchObject({ chunkId: 'c1', content: 'original text', language: 'it' });
  });

  it('an invalid row throws TranslationRowInvalidError', async () => {
    const backend = createPgvectorBackend({ adminClient: () => rpcReturning([{ ...row, chunk_id: null }], []), getConfig: () => config() });
    await expect(
      backend.searchTranslations!({
        scope,
        embeddingProfileId: 'openai-3-small-1536',
        language: 'en',
        denseVector: [0.1],
        lexicalTokens: [],
        filters: { currentOnly: true },
        denseLimit: 10,
        lexicalLimit: 10,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(TranslationRowInvalidError);
  });
});

describe('planTranslationLegs: never on by accident (D-30)', () => {
  const state = (over: Partial<TranslationQueryState> = {}): TranslationQueryState => ({
    language: 'en',
    enabled: true,
    targeted: true,
    hasTranslations: true,
    hasProfileVectors: true,
    ...over,
  });

  const plan = async (cfgOver: Record<string, string>, rows: TranslationQueryState[] | Error, over: Partial<Parameters<typeof planTranslationLegs>[0]> = {}) => {
    const reader = vi.fn(async () => {
      if (rows instanceof Error) throw rows;
      return rows;
    });
    const result = await planTranslationLegs(
      { profile: 'chat', config: config(cfgOver), scope, queryLanguage: 'en', embeddingProfileId: 'openai-3-small-1536', signal: new AbortController().signal, ...over },
      reader,
    );
    return { result, reader };
  };

  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('switch off, voice, legacy-only profiles or no query language: no lookup', async () => {
    for (const run of [
      await plan({ RAG_DOC_TRANSLATION: 'off' }, [state()]),
      await plan({}, [state()], { profile: 'voice' }),
      await plan({}, [state()], { queryLanguage: null }),
    ]) {
      expect(run.reader).not.toHaveBeenCalled();
      expect(run.result).toEqual({ languages: [], stale: [], failures: [] });
    }
  });

  it('monolingual mode: no lookup', async () => {
    const cfg = { ...config(), monolingual: true };
    const reader = vi.fn(async () => [state()]);
    const result = await planTranslationLegs(
      { profile: 'chat', config: cfg, scope, queryLanguage: 'en', embeddingProfileId: 'p', signal: new AbortController().signal },
      reader,
    );
    expect(reader).not.toHaveBeenCalled();
    expect(result.languages).toEqual([]);
  });

  it('chat, embed and eval look up once; a disabled, untargeted or empty tenant gets no leg', async () => {
    for (const profile of ['chat', 'embed', 'eval'] as const) {
      const run = await plan({}, [state()], { profile });
      expect(run.reader).toHaveBeenCalledTimes(1);
      expect(run.result).toEqual({ languages: ['en'], stale: [], failures: [] });
    }
    for (const over of [{ enabled: false }, { targeted: false }, { hasTranslations: false }]) {
      expect((await plan({}, [state(over)])).result).toEqual({ languages: [], stale: [], failures: [] });
    }
    expect((await plan({}, [])).result).toEqual({ languages: [], stale: [], failures: [] });
  });

  it('translations without a vector under the active profile are stale; a failed lookup is one error failure', async () => {
    expect((await plan({}, [state({ hasProfileVectors: false })])).result).toEqual({ languages: [], stale: ['en'], failures: [] });
    expect((await plan({}, new Error('down'))).result).toEqual({ languages: [], stale: [], failures: [{ language: 'en', reason: 'error' }] });
  });
});

describe('retrievalConfigHash with translation legs', () => {
  function baseInput(): RetrievalConfigHashInput {
    const cfg = config({ RAG_DOC_TRANSLATION: 'off' });
    return {
      backendId: 'pgvector',
      embeddingProfileId: 'openai-3-small-1536',
      lexicalVersion: LEXICAL_VERSION,
      rerankTextVersion: RERANK_TEXT_VERSION,
      params: effectiveRetrievalParams('chat', cfg, null),
      reranker: { id: 'none', model: '' },
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

  it('is unchanged when no leg runs and includes the switch, languages and weight when one does', () => {
    const base = baseInput();
    const today = computeRetrievalConfigHash(base);
    expect(computeRetrievalConfigHash({ ...base, ...translationHashFields({ languages: [], stale: ['en'], failures: [] }, base.params) })).toBe(today);
    expect(computeRetrievalConfigHash({ ...base, ...translationHashFields(null, base.params) })).toBe(today);
    const on = translationHashFields(PLAN_EN, base.params);
    expect(on).toEqual({ docTranslation: { switch: 'on', languages: ['en'], weight: 1 } });
    const onHash = computeRetrievalConfigHash({ ...base, ...on });
    expect(onHash).not.toBe(today);
    const weighted = { ...base.params, leg_weights: { ...(base.params.leg_weights ?? { dense: 1, lexical: 1, exact_id: 1 }), translation: 0.5 } };
    expect(computeRetrievalConfigHash({ ...base, ...translationHashFields(PLAN_EN, weighted) })).not.toBe(onHash);
  });
});
