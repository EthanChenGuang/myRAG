import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RankedHit } from '@/lib/rag/backend/types';
import type { RawChunk, RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import { loadRagConfig } from '@/lib/rag/config';
import { filterCandidates, type AssemblyDocumentRow } from '@/lib/rag/context/assemble';
import type { EmbeddingProfile } from '@/lib/rag/embeddings/active-profile';
import type { FusedHit } from '@/lib/rag/fusion/rrf';
import { legacySearch, resetCalibrationWarningsForTests } from '@/lib/rag/legacy/enhanced-retrieval';
import type { TemporalQueryContext } from '@/lib/rag/query/temporal-query-detector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { runRankStages } from '@/lib/rag/v2/stages/rank';
import { hit } from '../fusion/helpers';
import { installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const LEGACY_RULE = { RAG_PIPELINE: 'v2', RAG_RERANKER: 'none', RAG_LEXICAL_SEARCH: 'false', RAG_REFUSAL_FLOOR: 'legacy_rule' };

interface Row {
  id: string;
  similarity: number;
  filename?: string;
  docText?: string;
  image?: boolean;
  metadata?: Record<string, unknown>;
}

function context(over: Partial<TemporalQueryContext> = {}): TemporalQueryContext {
  return {
    isTemporalQuery: false,
    isFinancialQuery: false,
    isSpecificDataQuery: false,
    timeframe: null,
    financialMetrics: [],
    requiredPrecision: 'low',
    suggestedThreshold: 0.35,
    searchStrategy: 'semantic_only',
    requireTemporalMatch: false,
    reasoningText: 'test context',
    ...over,
  };
}

function rawChunk(row: Row): RawChunk {
  return {
    chunk_id: row.id,
    document_id: `d-${row.id}`,
    content: `sample passage ${row.id}`,
    similarity: row.similarity,
    metadata: { ...(row.metadata ?? {}), ...(row.image ? { image_url: `https://storage.example.test/${row.id}.png` } : {}) },
  };
}

interface RpcCall {
  fn: string;
  matchCount: number;
  threshold: number;
}

/** A vector RPC over a fixed table: rows strictly above the threshold, best similarity first, at most match_count. */
function fakeVectorRpc(rows: Row[]): { client: RpcClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      const matchCount = Number(args.match_count ?? args.p_match_count);
      const threshold = Number(args.similarity_threshold ?? args.p_min_similarity);
      calls.push({ fn, matchCount, threshold });
      const data = rows
        .filter((row) => row.similarity > threshold)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, matchCount)
        .map((row) => {
          const chunk = rawChunk(row);
          return fn === 'match_document_chunks' ? chunk : { ...chunk, id: chunk.chunk_id };
        });
      const response: RpcResponse = { data, error: null };
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onfulfilled, onrejected) => Promise.resolve(response).then(onfulfilled, onrejected),
      };
      return request;
    },
  };
  return { client, calls };
}

function documents(rows: Row[]): Map<string, AssemblyDocumentRow> {
  return new Map(
    rows.map((row) => [
      `d-${row.id}`,
      { id: `d-${row.id}`, filename: row.filename ?? `${row.id}.txt`, content: row.docText ?? 'neutral sample body' },
    ]),
  );
}

interface Case {
  name: string;
  query: string;
  rows: Row[];
  context?: TemporalQueryContext;
  maxResults?: number;
  fallbackToLowerThreshold?: boolean;
  profile?: EmbeddingProfile | null;
  expected: 'answer' | 'refuse';
}

async function legacyDecision(c: Case): Promise<'answer' | 'refuse'> {
  const { client } = fakeVectorRpc(c.rows);
  const searched = await legacySearch({
    query: c.query,
    embedding: [0.1],
    profile: c.profile ?? null,
    queryContext: c.context ?? context(),
    maxResults: c.maxResults ?? 25,
    fallbackToLowerThreshold: c.fallbackToLowerThreshold ?? true,
    scope,
    client,
    signal: new AbortController().signal,
  });
  const filtered = filterCandidates({
    queryText: c.query,
    candidates: searched.results,
    documents: documents(c.rows),
    chunkMetadata: new Map(),
    referenced: null,
    isGPTModel: false,
    ragMode: 'strict',
    webSearchEnabled: false,
    applyRelevanceFilter: true,
  });
  return filtered.relevantChunks.length > 0 ? 'answer' : 'refuse';
}

function fusedFromRows(rows: Row[]): FusedHit[] {
  const ordered = [...rows].sort((a, b) => b.similarity - a.similarity);
  return ordered.map((row, index) => {
    const chunk = rawChunk(row);
    const ranked: RankedHit = hit(row.id, {
      rank: index + 1,
      documentId: chunk.document_id,
      content: chunk.content,
      metadata: chunk.metadata ?? {},
      similarity: row.similarity,
      document: { filename: row.filename ?? `${row.id}.txt`, createdAt: null, metadata: {}, contentPreview: row.docText ?? 'neutral sample body' },
    });
    return { hit: ranked, score: 1 / (60 + index + 1), ranks: { 'dense:0': index + 1 } };
  });
}

async function v2Decision(
  c: Pick<Case, 'query' | 'context' | 'maxResults' | 'fallbackToLowerThreshold' | 'profile'> & { hits: FusedHit[] },
  env: Record<string, string> = LEGACY_RULE,
) {
  installDeps({ ragEnv: () => env });
  const signal = new AbortController().signal;
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const extra = { queryContext: c.context ?? context() };
  const out = await runRankStages({
    input: {
      scope,
      query: c.query,
      profile: 'chat',
      signal,
      options: {
        ...(c.maxResults !== undefined ? { maxResults: c.maxResults } : {}),
        ...(c.fallbackToLowerThreshold !== undefined ? { fallbackToLowerThreshold: c.fallbackToLowerThreshold } : {}),
      },
    },
    config: loadRagConfig(env),
    profile: 'chat',
    embedding: { vector: [0.1], profile: c.profile ?? null },
    queryLanguage: 'en',
    fusedHits: c.hits,
    referenced: null,
    signal,
    collector,
    ...extra,
  });
  return { out, refusalStage: collector.stages().find((row) => row.name === 'refusal') };
}

function profileWith(scoreCalibration: Record<string, number>): EmbeddingProfile {
  return {
    id: 'parity-profile',
    provider: 'openai',
    model: 'parity-model',
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

const QUERY = 'where is the gadget catalogue';

const CASES: Case[] = [
  { name: 'pool member above the text floor', query: QUERY, rows: [{ id: 'a', similarity: 0.7 }], expected: 'answer' },
  { name: 'pool members below the text floor, no term', query: QUERY, rows: [{ id: 'a', similarity: 0.6 }, { id: 'b', similarity: 0.5 }], expected: 'refuse' },
  { name: 'term in the filename of a pool member', query: QUERY, rows: [{ id: 'a', similarity: 0.4, filename: 'gadget-notes.md' }], expected: 'answer' },
  { name: 'term in the document text of a pool member', query: QUERY, rows: [{ id: 'a', similarity: 0.4, docText: 'The catalogue lists every item.' }], expected: 'answer' },
  {
    name: 'term only below the semantic threshold',
    query: QUERY,
    rows: [{ id: 'a', similarity: 0.5 }, { id: 'b', similarity: 0.3, filename: 'gadget-notes.md' }],
    expected: 'refuse',
  },
  {
    name: 'fallback pass reaches a term below the analyser threshold',
    query: QUERY,
    context: context({ suggestedThreshold: 0.45 }),
    rows: [{ id: 'a', similarity: 0.5 }, { id: 'b', similarity: 0.3, filename: 'gadget-notes.md' }],
    expected: 'answer',
  },
  {
    name: 'fallback off: one first-pass result stops the fallback',
    query: QUERY,
    context: context({ suggestedThreshold: 0.45 }),
    fallbackToLowerThreshold: false,
    rows: [{ id: 'a', similarity: 0.5 }, { id: 'b', similarity: 0.3, filename: 'gadget-notes.md' }],
    expected: 'refuse',
  },
  {
    name: 'below the fallback threshold',
    query: QUERY,
    context: context({ suggestedThreshold: 0.45 }),
    rows: [{ id: 'a', similarity: 0.27, filename: 'gadget-notes.md' }],
    expected: 'refuse',
  },
  {
    name: 'term beyond the match count',
    query: QUERY,
    maxResults: 2,
    rows: [{ id: 'a', similarity: 0.6 }, { id: 'b', similarity: 0.55 }, { id: 'c', similarity: 0.5, filename: 'gadget-notes.md' }],
    expected: 'refuse',
  },
  {
    name: 'image pool member above the image floor',
    query: QUERY,
    rows: [{ id: 'a', similarity: 0.4, filename: 'figure.png', image: true }],
    expected: 'answer',
  },
  {
    name: 'exact match: an empty first pass falls back',
    query: QUERY,
    context: context({ requiredPrecision: 'exact', suggestedThreshold: 0.6, searchStrategy: 'exact_match' }),
    rows: [{ id: 'a', similarity: 0.68, filename: 'gadget-notes.md' }],
    expected: 'answer',
  },
  {
    name: 'exact match: below the fallback threshold',
    query: QUERY,
    context: context({ requiredPrecision: 'exact', suggestedThreshold: 0.6, searchStrategy: 'exact_match' }),
    rows: [{ id: 'a', similarity: 0.25, filename: 'gadget-notes.md' }],
    expected: 'refuse',
  },
  {
    name: 'temporal boost keeps the first match count',
    query: QUERY,
    maxResults: 1,
    context: context({ isTemporalQuery: true, requiredPrecision: 'medium', suggestedThreshold: 0.55, searchStrategy: 'temporal_boost' }),
    rows: [{ id: 'a', similarity: 0.62 }, { id: 'b', similarity: 0.6, filename: 'gadget-notes.md' }],
    expected: 'refuse',
  },
  {
    name: 'calibrated profile scales the pool threshold',
    query: QUERY,
    profile: profileWith({ retrieval_threshold: 0.35, fallback_threshold: 0.14 }),
    rows: [{ id: 'a', similarity: 0.18, filename: 'gadget-notes.md' }],
    expected: 'answer',
  },
  {
    name: 'calibrated profile: below the scaled threshold',
    query: QUERY,
    profile: profileWith({ retrieval_threshold: 0.35, fallback_threshold: 0.14 }),
    rows: [{ id: 'a', similarity: 0.17, filename: 'gadget-notes.md' }],
    expected: 'refuse',
  },
  {
    name: 'profile without calibration keeps the legacy threshold',
    query: QUERY,
    profile: profileWith({}),
    rows: [{ id: 'a', similarity: 0.18, filename: 'gadget-notes.md' }],
    expected: 'refuse',
  },
  {
    name: 'empty legacy term from a long non-Latin word matches a pool member',
    query: '\u5c0f\u90e8\u4ef6\u76ee\u5f55\u5728\u54ea\u91cc',
    rows: [{ id: 'a', similarity: 0.4 }],
    expected: 'answer',
  },
  {
    name: 'empty legacy term does not reach below the pool threshold',
    query: '\u5c0f\u90e8\u4ef6\u76ee\u5f55\u5728\u54ea\u91cc',
    rows: [{ id: 'a', similarity: 0.3 }],
    expected: 'refuse',
  },
];

describe('legacy parity', () => {
  beforeEach(() => {
    resetCalibrationWarningsForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    vi.restoreAllMocks();
  });

  for (const c of CASES) {
    it(`legacy parity: ${c.name}`, async () => {
      const legacy = await legacyDecision(c);
      expect(legacy, 'legacy side').toBe(c.expected);
      const { out } = await v2Decision({ ...c, hits: fusedFromRows(c.rows) });
      const v2 = out.decision.decision === 'refuse' ? 'refuse' : 'answer';
      expect(v2, 'legacy_rule side').toBe(legacy);
    });
  }
});

describe('legacy search unchanged', () => {
  const rows: Row[] = [
    { id: 'a', similarity: 0.9 },
    { id: 'b', similarity: 0.72 },
    { id: 'c', similarity: 0.6 },
    { id: 'd', similarity: 0.5 },
    { id: 'e', similarity: 0.4 },
    { id: 'f', similarity: 0.3 },
  ];

  async function run(ctx: TemporalQueryContext, maxResults: number, fallback: boolean, profile: EmbeddingProfile | null = null) {
    const { client, calls } = fakeVectorRpc(rows);
    const result = await legacySearch({
      query: QUERY,
      embedding: [0.1],
      profile,
      queryContext: ctx,
      maxResults,
      fallbackToLowerThreshold: fallback,
      scope,
      client,
      signal: new AbortController().signal,
    });
    return { ids: result.results.map((row) => row.chunk_id), strategy: result.retrievalStrategy, calls };
  }

  beforeEach(() => {
    resetCalibrationWarningsForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the same rows, thresholds and fallback decisions per strategy', async () => {
    const table = [
      { ctx: context(), max: 3, fallback: true },
      { ctx: context({ suggestedThreshold: 0.65 }), max: 3, fallback: true },
      { ctx: context({ suggestedThreshold: 0.65 }), max: 3, fallback: false },
      { ctx: context({ suggestedThreshold: 0.95 }), max: 3, fallback: false },
      { ctx: context({ requiredPrecision: 'exact', suggestedThreshold: 0.6, searchStrategy: 'exact_match' }), max: 30, fallback: true },
      { ctx: context({ requiredPrecision: 'high', suggestedThreshold: 0.45, searchStrategy: 'multi_stage' }), max: 2, fallback: true },
      { ctx: context({ requiredPrecision: 'medium', suggestedThreshold: 0.55, searchStrategy: 'temporal_boost' }), max: 1, fallback: true },
    ];
    const results = [];
    for (const row of table) results.push(await run(row.ctx, row.max, row.fallback));
    expect(results).toEqual([
      { ids: ['a', 'b', 'c'], strategy: 'Semantic Only', calls: [{ fn: 'match_document_chunks', matchCount: 3, threshold: 0.35 }] },
      {
        ids: ['a', 'b', 'c'],
        strategy: 'Semantic Only + Fallback',
        calls: [
          { fn: 'match_document_chunks', matchCount: 3, threshold: 0.65 },
          { fn: 'match_document_chunks', matchCount: 3, threshold: 0.28 },
        ],
      },
      { ids: ['a', 'b'], strategy: 'Semantic Only', calls: [{ fn: 'match_document_chunks', matchCount: 3, threshold: 0.65 }] },
      {
        ids: ['a', 'b', 'c'],
        strategy: 'Semantic Only + Fallback',
        calls: [
          { fn: 'match_document_chunks', matchCount: 3, threshold: 0.95 },
          { fn: 'match_document_chunks', matchCount: 3, threshold: 0.28 },
        ],
      },
      {
        ids: ['a', 'b', 'c', 'd', 'e', 'f'],
        strategy: 'Exact Match (Temporal/Financial Precision) + Fallback',
        calls: [
          { fn: 'match_document_chunks', matchCount: 50, threshold: 0.7 },
          { fn: 'match_document_chunks', matchCount: 30, threshold: 0.28 },
        ],
      },
      {
        ids: ['a', 'b'],
        strategy: 'Multi-Stage (Temporal + Financial) + Fallback',
        calls: [
          { fn: 'match_document_chunks', matchCount: 4, threshold: 0.45 },
          { fn: 'match_document_chunks', matchCount: 2, threshold: 0.28 },
        ],
      },
      {
        ids: ['a'],
        strategy: 'Temporal Boosted + Fallback',
        calls: [
          { fn: 'match_document_chunks', matchCount: 2, threshold: 0.55 },
          { fn: 'match_document_chunks', matchCount: 1, threshold: 0.28 },
        ],
      },
    ]);
  });

  it('a calibrated profile scales the thresholds and replaces the fallback', async () => {
    const profile = profileWith({ retrieval_threshold: 0.35, fallback_threshold: 0.14 });
    const result = await run(context({ suggestedThreshold: 1.6 }), 3, true, profile);
    expect(result.calls.map((call) => [call.fn, call.matchCount])).toEqual([
      ['match_chunks_by_profile', 3],
      ['match_chunks_by_profile', 3],
    ]);
    expect(result.calls[0]!.threshold).toBeCloseTo(0.8, 10);
    expect(result.calls[1]!.threshold).toBe(0.14);
    expect(result.ids).toEqual(['a', 'b', 'c']);
  });
});
