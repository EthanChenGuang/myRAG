import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { LEGACY_PROFILE } from '@/lib/rag/embeddings/active-profile';
import { hit } from '../fusion/helpers';
import { runRetrieval } from '@/lib/rag';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { runQueryStages } from '@/lib/rag/v2/stages/query';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { verifyV2Startup, resetV2StartupForTests } from '@/lib/rag/v2/startup';
import { NO_CONTEXT_TEXT } from '@/lib/rag/context/assemble';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { buildRetrievalFilters } from '@/lib/rag/query/filters';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const DOC_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function v2Config(over: Record<string, string> = {}) {
  resetRagConfigForTests();
  return loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', ...over });
}

function fakeBackend(similarity: number, seen: { filters: unknown[] } = { filters: [] }): RetrievalBackend {
  return {
    id: 'pgvector',
    async search(req) {
      seen.filters.push(req.filters);
      return {
        dense: [hit('chunk-1', { similarity, documentId: 'doc-1' })],
        lexical: [],
      } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

function installV2(similarity = 0.4, env: Record<string, string> = {}) {
  resetActiveChunkingProfilesForTests();
  const { embedder } = fakeEmbedder();
  const rpc = fakeRpcClient();
  installDeps({
    embedder,
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', ...env }),
  });
  setRetrievalBackendForTests(fakeBackend(similarity));
}

describe('runQueryStages', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    vi.restoreAllMocks();
  });

  it('passes explicit docTypes and currentOnly to backend search', async () => {
    const cfg = v2Config();
    const params = effectiveRetrievalParams('eval', cfg, null);
    const seen = { filters: [] as unknown[] };
  setRetrievalBackendForTests(fakeBackend(0.9, seen));
    const { embedder } = fakeEmbedder();
    installDeps({ embedder, adminClient: fakeAssemblyAdmin(), ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false' }) });

    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const query = await runQueryStages({
      input: {
        scope,
        query: 'contract terms',
        profile: 'eval',
        signal: new AbortController().signal,
        retrievalFilters: { docTypes: ['contract_legal'] },
      },
      scope,
      config: cfg,
      profile: 'eval',
      signal: new AbortController().signal,
      collector,
    });

    expect(query.filters).toMatchObject({ currentOnly: true, docTypes: ['contract_legal'] });

    await runSearchStages({
      input: { scope, query: 'contract terms', profile: 'eval', signal: new AbortController().signal, retrievalFilters: { docTypes: ['contract_legal'] } },
      scope,
      config: cfg,
      profile: 'eval',
      params,
      embedding: { vector: [0.1], profile: null },
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: 's:default' }),
      filters: query.filters,
    });

    expect(seen.filters[0]).toMatchObject({ currentOnly: true, docTypes: ['contract_legal'] });
  });

  it('narrows documentIds to the intersection of explicit ids and referenced documents', async () => {
    expect(
      buildRetrievalFilters({
        explicit: { documentIds: [DOC_A, DOC_B] },
        referencedDocumentIds: [DOC_A],
      }).documentIds,
    ).toEqual([DOC_A]);
    const cfg = v2Config();
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const query = await runQueryStages({
      input: {
        scope,
        query: 'policy',
        profile: 'eval',
        signal: new AbortController().signal,
        retrievalFilters: { documentIds: [DOC_A] },
      },
      scope,
      config: cfg,
      profile: 'eval',
      signal: new AbortController().signal,
      collector,
    });
    expect(query.filters.documentIds).toEqual([DOC_A]);
  });

  it('records derived_date_range trace detail without applying a date filter', async () => {
    const cfg = v2Config();
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    await runQueryStages({
      input: {
        scope,
        query: 'Summarize revenue FY2024',
        profile: 'eval',
        signal: new AbortController().signal,
      },
      scope,
      config: cfg,
      profile: 'eval',
      signal: new AbortController().signal,
      collector,
    });
    const analyze = collector.stages().find((row) => row.name === 'analyze');
    expect(analyze?.detail).toBe('derived_date_range=2024-01-01..2024-12-31 applied=false');
  });

  it('uses default query context when analyze fails and keeps query language', async () => {
    const legacy = await import('@/lib/rag/legacy/enhanced-retrieval');
    vi.spyOn(legacy, 'legacyAnalyze').mockImplementation(() => {
      throw new Error('analyze down');
    });
    const cfg = v2Config();
    const collector = createTraceCollector({ profile: 'eval', tenantKey: 's:default' });
    const output = await runQueryStages({
      input: { scope, query: '退款流程是怎样的？', profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      signal: new AbortController().signal,
      collector,
    });
    expect(collector.stages().find((row) => row.name === 'analyze')?.status).toBe('skipped');
    expect(output.queryContext.reasoningText).toContain('skipped');
    expect(output.queryLanguage).toBe('zh');
  });
});

describe('v2 refusal routing', () => {
  beforeEach(() => {
    uninstallDeps();
    resetRagConfigForTests();
    resetRetrievalBackendForTests();
    resetV2StartupForTests();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    vi.restoreAllMocks();
  });

  it('refuses strict chat with similarity floor when best dense similarity is 0.40', async () => {
    installV2(0.4);
    await verifyV2Startup();
    const result = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
    });
    expect(result.refusal).toMatchObject({ decision: 'refuse', basis: 'similarity_floor', threshold: 0.65 });
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('below_similarity_floor');
    expect(result.context).toBe(NO_CONTEXT_TEXT);
    expect(result.refusalCandidate).toBe(true);
    expect(result.candidates).toEqual([]);
  });

  it('answers when best similarity is 0.80', async () => {
    installV2(0.8);
    await verifyV2Startup();
    const result = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
    });
    expect(result.refusal?.decision).toBe('answer');
    expect(result.status).toBe('ok');
  });

  it('balanced mode does not mark a refusal candidate when below the floor', async () => {
    installV2(0.4);
    await verifyV2Startup();
    const result = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'chat',
      options: { ragMode: 'balanced', webSearchEnabled: false },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('empty');
    expect(result.refusalCandidate).toBe(false);
  });

  it('keeps referenced documents on refuse with low similarity', async () => {
    resetActiveChunkingProfilesForTests();
    const admin = () => ({
      from(table: string) {
        const builder: Record<string, unknown> = {};
        const record = () => builder;
        builder.select = record;
        builder.eq = record;
        builder.is = record;
        builder.limit = record;
        builder.abortSignal = record;
        builder.single = record;
        builder.then = (resolve: (value: unknown) => unknown) => {
          if (table === 'documents') {
            return Promise.resolve({
              data: { id: DOC_A, filename: 'policy.md', created_at: '2026-01-01', content: 'policy body', metadata: {} },
              error: null,
            }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        };
        return builder;
      },
    });
    const { embedder } = fakeEmbedder();
    const rpc = fakeRpcClient();
    installDeps({
      embedder,
      adminClient: adminWithRpc(rpc.client, admin as never),
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' }),
    });
    setRetrievalBackendForTests(fakeBackend(0.4));
    await verifyV2Startup();
    const result = await runRetrieval({
      scope,
      query: 'policy',
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      documentRefs: { mentions: [], documentParts: [{ id: DOC_A, name: 'Policy' }] },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('empty');
    expect(result.reason).toBe('below_similarity_floor');
    expect(result.usedDocuments.some((doc) => doc.id === DOC_A)).toBe(true);
    expect(result.refusalCandidate).toBe(false);
  });

  it('refuse beats degraded when analyze was skipped', async () => {
    installV2(0.4);
    await verifyV2Startup();
    const result = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      stageOverrides: { disabledStages: ['analyze'] },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('empty');
    expect(result.status).not.toBe('degraded');
    expect(result.reason).toBe('below_similarity_floor');
  });

  it('returns not_applied with null similarities and derives empty without a false refuse', async () => {
    setRetrievalBackendForTests({
      id: 'pgvector',
      search: async () => ({ dense: [hit('chunk-1', { similarity: null })], lexical: [] }),
      health: async () => ({ ok: true }),
      isReady: async () => true,
    });
    const { embedder } = fakeEmbedder();
    installDeps({
      embedder,
      adminClient: fakeAssemblyAdmin(),
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' }),
    });
    await verifyV2Startup();
    const result = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
    });
    expect(result.refusal).toMatchObject({ decision: 'not_applied', reason: 'no_dense_similarity' });
    expect(result.refusal?.decision).not.toBe('refuse');
  });

  it('keeps pre-refusal candidates on eval profile refuse', async () => {
    installV2(0.4);
    await verifyV2Startup();
    const result = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'eval',
      signal: new AbortController().signal,
    });
    expect(result.refusal?.decision).toBe('refuse');
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.context).toBe(NO_CONTEXT_TEXT);
  });

  it.each([
    { similarity: 0.45, expectDecision: 'refuse' as const },
    { similarity: 0.55, expectDecision: 'answer' as const },
  ])('profile text floor 0.5 refuses at $similarity -> $expectDecision', async ({ similarity, expectDecision }) => {
    setRetrievalBackendForTests(fakeBackend(similarity));
    const { embedder } = fakeEmbedder();
    installDeps({
      embedder,
      adminClient: fakeAssemblyAdmin(),
      ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none' }),
    });
    await verifyV2Startup();
    const embeddingProfile = {
      ...LEGACY_PROFILE,
      scoreCalibration: {
        ...LEGACY_PROFILE.scoreCalibration,
        context_threshold: 0.5,
      },
    };
    const embed = await import('@/lib/rag/embeddings/query-embedding');
    vi.spyOn(embed, 'embedQuery').mockResolvedValue({ vector: [0.1], profile: embeddingProfile });
    const result = await runRetrieval({
      scope,
      query: 'refund policy',
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
    });
    expect(result.refusal?.decision).toBe(expectDecision);
    if (expectDecision === 'refuse') {
      expect(result.status).toBe('empty');
    } else {
      expect(result.status).toBe('ok');
    }
  });
});