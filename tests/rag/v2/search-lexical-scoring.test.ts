import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type {
  BackendLegs,
  BackendSearchRequest,
  BackendTranslationSearchRequest,
  LexicalScoringOutcome,
  RetrievalBackend,
} from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests, type RagConfig } from '@/lib/rag/config';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import { mintScope } from '@/lib/rag/tenant/scope';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { LEXICAL_BM25_FAILED, LEXICAL_SCORING_BM25, LEXICAL_STATS_UNAVAILABLE, lexicalScoringArg, runSearchStages } from '@/lib/rag/v2/stages/search';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const scope = mintScope('single', null, null);
const BASE = { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_SUPPORTED_LANGUAGES: 'en', RAG_PRIMARY_LANGUAGE: 'en' };
const BM25 = { ...BASE, RAG_LEXICAL_SCORING: 'bm25', RAG_LEXICAL_BM25_K1: '1.4', RAG_LEXICAL_BM25_B: '0.6' };

function config(env: Record<string, string>): RagConfig {
  resetRagConfigForTests();
  return loadRagConfig(env);
}

interface Harness {
  requests: BackendSearchRequest[];
  translationRequests: BackendTranslationSearchRequest[];
}

/** outcome(req) is what the backend reports for a request that carries lexicalScoring. */
function harness(env: Record<string, string>, outcome: (req: BackendSearchRequest) => LexicalScoringOutcome | undefined = () => 'bm25'): Harness {
  const requests: BackendSearchRequest[] = [];
  const translationRequests: BackendTranslationSearchRequest[] = [];
  const backend: RetrievalBackend = {
    id: 'pgvector',
    capabilities: { versionScope: true, identifierFilter: true },
    search: async (req) => {
      requests.push(req);
      const legs: BackendLegs = {
        dense: req.denseLimit > 0 ? [hit('a', { rank: 1, similarity: 0.8 })] : [],
        lexical: req.lexicalLimit > 0 && req.lexicalTokens.length > 0 ? [hit('b', { rank: 1, lexicalScore: 1 })] : [],
      };
      const reported = req.lexicalScoring && req.lexicalLimit > 0 && req.lexicalTokens.length > 0 ? outcome(req) : undefined;
      return reported ? { ...legs, meta: { denseMode: null, lexicalScoring: reported } } : legs;
    },
    searchTranslations: async (req) => {
      translationRequests.push(req);
      return [];
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  const rpc: RpcClient = {
    rpc(): RpcRequest {
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve({ data: [], error: null } as RpcResponse).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
  installDeps({ embedder: fakeEmbedder().embedder, adminClient: adminWithRpc(rpc, fakeAssemblyAdmin()), ragEnv: () => env });
  setRetrievalBackendForTests(backend);
  return { requests, translationRequests };
}

async function run(env: Record<string, string>, extra: { terminology?: boolean; bindings?: boolean; translations?: boolean } = {}) {
  const cfg = config(env);
  await verifyV2Startup();
  const collector = createTraceCollector({ profile: 'chat', tenantKey: 's:default' });
  const output = await runSearchStages({
    input: { scope, query: 'synthetic question about w1 and w2', profile: 'chat', signal: new AbortController().signal },
    scope,
    config: cfg,
    profile: 'chat',
    params: effectiveRetrievalParams('chat', cfg, null),
    embedding: { vector: [0.1, 0.2], profile: null },
    signal: new AbortController().signal,
    collector,
    variants: [
      { text: 'synthetic question about w1 and w2', language: null, kind: 'original' },
      { text: 'synthetic rewrite about w3', language: null, kind: 'expanded' as const },
    ],
    ...(extra.terminology ? { terminology: { tokens: ['w7', 'w8'], expansionWeight: 0.5 } } : {}),
    ...(extra.bindings ? { bindings: { plan: { legs: [], controlLeg: 'general', failures: [] }, embeds: [] } } : {}),
    ...(extra.translations ? { translations: { languages: ['en'], stale: [], failures: [] } } : {}),
  });
  const search = collector.stages().find((row) => row.name === 'search');
  return { output, search };
}

describe('search stage lexical scoring (D-28, D-40)', () => {
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

  it('lexicalScoringArg is empty for ts_rank_cd and carries mode, k1 and b from config for bm25', () => {
    expect(lexicalScoringArg(config(BASE))).toEqual({});
    expect(lexicalScoringArg(config(BM25))).toEqual({ lexicalScoring: { mode: 'bm25', k1: 1.4, b: 0.6 } });
  });

  it('ts_rank_cd: no request carries lexicalScoring and the stage detail and output are unchanged', async () => {
    const h = harness(BASE);
    const { output, search } = await run(BASE, { terminology: true, bindings: true });
    expect(h.requests.length).toBeGreaterThan(2);
    for (const req of h.requests) expect('lexicalScoring' in req).toBe(false);
    expect(search?.detail).toBeUndefined();
    expect(search?.status).toBe('ok');

    const again = harness(BASE);
    const second = await run(BASE, { terminology: true, bindings: true });
    expect(again.requests).toHaveLength(h.requests.length);
    expect(JSON.stringify(second.output)).toBe(JSON.stringify(output));
  });

  it('bm25: every search request (variants, terminology leg, binding legs) carries the config values; the translation request does not', async () => {
    const h = harness(BM25);
    const { search } = await run(BM25, { terminology: true, bindings: true, translations: true });
    const termLeg = h.requests.filter((req) => req.denseVector === null && req.lexicalTokens.includes('w7'));
    const bindingLeg = h.requests.filter((req) => req.lexicalLimit === 0 && req.filters.docTypes?.[0] === 'general');
    expect(termLeg).toHaveLength(1);
    expect(bindingLeg).toHaveLength(1);
    expect(h.requests.length).toBeGreaterThanOrEqual(4);
    for (const req of h.requests) expect(req.lexicalScoring).toEqual({ mode: 'bm25', k1: 1.4, b: 0.6 });
    expect(h.translationRequests.length).toBeGreaterThan(0);
    for (const req of h.translationRequests) expect('lexicalScoring' in req).toBe(false);
    expect(search?.detail?.split(';')).toContain(LEXICAL_SCORING_BM25);
  });

  it('bm25 served everywhere: lexical_scoring_bm25 once, status ok', async () => {
    harness(BM25, () => 'bm25');
    const { search } = await run(BM25, { terminology: true });
    expect(search?.detail).toBe(LEXICAL_SCORING_BM25);
    expect(search?.status).toBe('ok');
  });

  it('any stats_unavailable gives lexical_stats_unavailable; the stage status stays ok and the hits are still returned', async () => {
    harness(BM25, (req) => (req.denseVector === null ? 'stats_unavailable' : 'bm25'));
    const { search, output } = await run(BM25, { terminology: true });
    expect(search?.detail).toBe(LEXICAL_STATS_UNAVAILABLE);
    expect(search?.status).toBe('ok');
    expect(output.fusedHits.some((row) => row.hit.chunkId === 'b')).toBe(true);
  });

  it('any bm25_failed gives lexical_bm25_failed (the worst of the calls), never an error status', async () => {
    let call = 0;
    harness(BM25, () => (['bm25', 'stats_unavailable', 'bm25_failed'] as const)[call++ % 3]);
    const { search } = await run(BM25, { terminology: true });
    expect(search?.detail).toBe(LEXICAL_BM25_FAILED);
    expect(search?.status).toBe('ok');
  });

  it('the code joins the other detail codes without changing the status', async () => {
    harness(BM25, () => 'stats_unavailable');
    const { search } = await run(BM25, { translations: true });
    expect(search?.detail?.split(';')).toContain(LEXICAL_STATS_UNAVAILABLE);
    expect(search?.detail?.split(';').filter((code) => code.startsWith('lexical_')).length).toBe(1);
  });
});

describe('v2 startup lexical scoring line', () => {
  function countingAdmin(count: number) {
    const tables: string[] = [];
    const admin = {
      from(table: string) {
        tables.push(table);
        return {
          select: () => ({ eq: () => Promise.resolve({ count, error: null }) }),
        };
      },
    };
    return { admin, tables };
  }

  beforeEach(() => {
    resetV2StartupForTests();
    resetRagConfigForTests();
  });

  afterEach(() => {
    resetV2StartupForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  const startup = (env: Record<string, string>, admin: unknown) =>
    verifyV2Startup({
      ragEnv: () => env,
      adminClient: () => admin as never,
      icuSegmentsChinese: () => true,
      pgvectorVersion: async () => '0.8.0',
      chunkingCoverage: async () => [],
    });

  it('bm25: logs one [RAG Config] warning with the count of ready tenants and never a tenant key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin, tables } = countingAdmin(3);
    await startup(BM25, admin);
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('RAG_LEXICAL_SCORING=bm25'));
    expect(lines).toEqual(['[RAG Config] RAG_LEXICAL_SCORING=bm25: tenants with ready lexical statistics: 3; any other tenant is served by ts_rank_cd until npm run rag:lexstats rebuilds it']);
    expect(tables).toEqual(['rag_lexical_stats_state']);
    expect(lines.join('')).not.toMatch(/\b[su]:[0-9a-z-]/);
  });

  it('bm25 with an unreadable count says unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const admin = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ count: null, error: { code: '42P01' } }) }) }) };
    await startup(BM25, admin);
    expect(warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('RAG_LEXICAL_SCORING=bm25'))).toEqual([
      '[RAG Config] RAG_LEXICAL_SCORING=bm25: tenants with ready lexical statistics: unknown; any other tenant is served by ts_rank_cd until npm run rag:lexstats rebuilds it',
    ]);
  });

  it('ts_rank_cd: no line and no read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin, tables } = countingAdmin(3);
    await startup(BASE, admin);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('RAG_LEXICAL_SCORING'))).toBe(false);
    expect(tables).toEqual([]);
  });
});
