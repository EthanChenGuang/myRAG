import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';
import type { BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { QueryVariant } from '@/lib/rag/types';
import { effectiveRetrievalParams } from '@/lib/rag/v2/retrieval-params';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { runRetrieval } from '@/lib/rag';
import type { LexicalOptions } from '@/lib/rag/lexical/options';
import {
  resetLexicalOptionsForTests,
  setLexicalOptionsResolverForTests,
  type LexicalOptionsResolver,
  type ResolvedLexicalOptions,
} from '@/lib/rag/lexical/resolve-options';
import { MAX_ADDITIVE_QUERY_TOKENS, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { mintScope } from '@/lib/rag/tenant/scope';
import * as searchStages from '@/lib/rag/v2/stages/search';
import { runSearchStages } from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const scope = mintScope('org', '00000000-0000-4000-8000-0000000000aa', ORG_A);
const TERM = '样例术语';
const DICT_VERSION = 's3.w7';

interface StaleRpc {
  client: RpcClient;
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
}

function staleRpc(answer: () => Promise<RpcResponse>): StaleRpc {
  const calls: StaleRpc['calls'] = [];
  const client: RpcClient = {
    rpc(fn: string, args: Record<string, unknown>): RpcRequest {
      const request: RpcRequest = {
        abortSignal() {
          return request;
        },
        then(onFulfilled, onRejected) {
          calls.push({ fn, args });
          const response = fn === 'rag_lexical_stale_count' ? answer() : Promise.resolve({ data: [], error: null });
          return response.then(onFulfilled, onRejected);
        },
      };
      return request;
    },
  };
  return { client, calls };
}

function stubDictionary(): NonNullable<LexicalOptions['dictionary']> {
  return {
    version: DICT_VERSION,
    match: (normalized: string) => (normalized.includes(TERM) ? [{ term: TERM }] : []),
  };
}

function resolverReturning(result: ResolvedLexicalOptions): { resolver: LexicalOptionsResolver; calls: Array<{ language: string | null }> } {
  const calls: Array<{ language: string | null }> = [];
  const resolver: LexicalOptionsResolver = async (_scope, _config, input) => {
    calls.push({ language: input.language });
    return result;
  };
  return { resolver, calls };
}

function install(env: Record<string, string>, rpc: StaleRpc): BackendSearchRequest[] {
  resetActiveChunkingProfilesForTests();
  const requests: BackendSearchRequest[] = [];
  const { embedder } = fakeEmbedder();
  installDeps({
    embedder,
    adminClient: adminWithRpc(rpc.client, fakeAssemblyAdmin()),
    ragEnv: () => ({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_RERANKER: 'none', ...env }),
  });
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search(req) {
      requests.push(req);
      return { dense: [hit('a', { rank: 1, similarity: 0.9, documentId: 'doc-a' })], lexical: [] };
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  setRetrievalBackendForTests(backend);
  return requests;
}

async function retrieve(query: string, options: Record<string, unknown> = {}) {
  await verifyV2Startup();
  return runRetrieval({ scope, query, profile: 'eval', options, signal: new AbortController().signal });
}

function searchDetail(result: Awaited<ReturnType<typeof retrieve>>): string | undefined {
  return result.stages.find((stage) => stage.name === 'search')?.detail;
}

const okStale = () => Promise.resolve<RpcResponse>({ data: 4, error: null });

beforeEach(() => {
  uninstallDeps();
  resetRagConfigForTests();
  resetV2StartupForTests();
  resetLexicalOptionsForTests();
  searchStages.resetLexicalStaleCountForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  uninstallDeps();
  resetRetrievalBackendForTests();
  resetRagConfigForTests();
  resetV2StartupForTests();
  resetLexicalOptionsForTests();
  vi.restoreAllMocks();
});

describe('query-side lexical options (04.2-22, D-08, D-09, D-55)', () => {
  it('with the three switches off the resolver is not called and tokens and detail equal the defaults', async () => {
    const { resolver, calls } = resolverReturning({ options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: [] });
    setLexicalOptionsResolverForTests(resolver);
    const rpc = staleRpc(okStale);
    const requests = install({}, rpc);
    const query = `neutral sample question about ${TERM}`;
    const result = await retrieve(query);
    expect(calls).toHaveLength(0);
    expect(requests.map((req) => req.lexicalTokens)).toEqual([queryLexicalTokens(query)]);
    expect(searchDetail(result) ?? '').not.toContain('dict=');
    expect(rpc.calls.filter((call) => call.fn === 'rag_lexical_stale_count')).toHaveLength(0);
  });

  it('dictionary on: the _t_ token leads, survives a long question and the additive part stays capped', async () => {
    const { resolver, calls } = resolverReturning({
      options: { dictionary: stubDictionary() },
      stamp: { dictVersion: DICT_VERSION, patterns: null },
      warnings: [],
    });
    setLexicalOptionsResolverForTests(resolver);
    const requests = install({ RAG_LEXICAL_DICTIONARY: 'true' }, staleRpc(okStale));
    const filler = Array.from({ length: 80 }, (_unused, index) => `word${index}`).join(' ');
    await retrieve(`${filler} ${TERM}`);
    expect(calls).toHaveLength(1);
    const tokens = requests[0]!.lexicalTokens;
    expect(tokens[0]).toBe(`_t_${TERM}`);
    expect(tokens.filter((token) => token.startsWith('_')).length).toBeLessThanOrEqual(MAX_ADDITIVE_QUERY_TOKENS);
  });

  it('stem on: an Italian question gets _s_ tokens, an English one none', async () => {
    const stemResolver: LexicalOptionsResolver = async (_scope, _config, input) => ({
      options: { stemIt: true, language: input.language },
      stamp: { dictVersion: null, patterns: null },
      warnings: [],
    });
    setLexicalOptionsResolverForTests(stemResolver);
    let requests = install({ RAG_LEXICAL_STEM_IT: 'true', RAG_SUPPORTED_LANGUAGES: 'en,it', RAG_PRIMARY_LANGUAGE: 'en' }, staleRpc(okStale));
    await retrieve('quali sono le regole delle domande frequenti nella documentazione');
    expect(requests[0]!.lexicalTokens.some((token) => token.startsWith('_s_'))).toBe(true);

    requests = install({ RAG_LEXICAL_STEM_IT: 'true', RAG_SUPPORTED_LANGUAGES: 'en,it', RAG_PRIMARY_LANGUAGE: 'en' }, staleRpc(okStale));
    await retrieve('which rules apply to the questions in the documentation');
    expect(requests[0]!.lexicalTokens.some((token) => token.startsWith('_s_'))).toBe(false);
  });

  it('identifier index on: a tenant-pattern identifier yields its normalized form among the first tokens', async () => {
    const pattern = /\bab \d{2} cd\b/giu;
    const { resolver } = resolverReturning({
      options: { identifierPatterns: [pattern] },
      stamp: { dictVersion: null, patterns: 'p000000000000' },
      warnings: [],
    });
    setLexicalOptionsResolverForTests(resolver);
    const requests = install({ RAG_IDENTIFIER_INDEX: 'true' }, staleRpc(okStale));
    const query = 'what does the record ab 12 cd say about the sample';
    await retrieve(query);
    const tokens = requests[0]!.lexicalTokens;
    const expected = queryLexicalTokens(query, { identifierPatterns: [pattern] });
    expect(tokens).toEqual(expected);
    expect(tokens).not.toEqual(queryLexicalTokens(query));
    expect(tokens[0]).toBe('ab12cd');
  });

  it('the search detail carries the dictionary version and the stale count, never the term', async () => {
    const { resolver } = resolverReturning({ options: { dictionary: stubDictionary() }, stamp: { dictVersion: DICT_VERSION, patterns: null }, warnings: [] });
    setLexicalOptionsResolverForTests(resolver);
    const rpc = staleRpc(okStale);
    install({ RAG_LEXICAL_DICTIONARY: 'true' }, rpc);
    const result = await retrieve(`neutral sample question about ${TERM}`);
    const detail = searchDetail(result) ?? '';
    expect(detail).toContain(`dict=${DICT_VERSION} stale_chunks=4`);
    expect(JSON.stringify(result.stages)).not.toContain(TERM);
    expect(rpc.calls.find((call) => call.fn === 'rag_lexical_stale_count')?.args).toEqual({ p_tenant_key: `o:${ORG_A}`, p_dict_version: DICT_VERSION });
  });

  it('a failed stale count reads unknown, and the count is cached per tenant and version (one call for two requests)', async () => {
    const { resolver } = resolverReturning({ options: { dictionary: stubDictionary() }, stamp: { dictVersion: DICT_VERSION, patterns: null }, warnings: [] });
    setLexicalOptionsResolverForTests(resolver);
    const failing = staleRpc(() => Promise.resolve<RpcResponse>({ data: null, error: { message: 'boom' } }));
    install({ RAG_LEXICAL_DICTIONARY: 'true' }, failing);
    expect(searchDetail(await retrieve('neutral sample question')) ?? '').toContain(`dict=${DICT_VERSION} stale_chunks=unknown`);

    searchStages.resetLexicalStaleCountForTests();
    const counting = staleRpc(okStale);
    install({ RAG_LEXICAL_DICTIONARY: 'true' }, counting);
    await retrieve('neutral sample question');
    const second = await retrieve('another neutral sample question');
    expect(searchDetail(second) ?? '').toContain('stale_chunks=4');
    expect(counting.calls.filter((call) => call.fn === 'rag_lexical_stale_count')).toHaveLength(1);
  });

  it('reads the stale count from a one-row result as well as from a scalar (bigint as text)', async () => {
    const { resolver } = resolverReturning({ options: { dictionary: stubDictionary() }, stamp: { dictVersion: DICT_VERSION, patterns: null }, warnings: [] });
    setLexicalOptionsResolverForTests(resolver);
    install({ RAG_LEXICAL_DICTIONARY: 'true' }, staleRpc(() => Promise.resolve<RpcResponse>({ data: [{ rag_lexical_stale_count: '5' }], error: null })));
    expect(searchDetail(await retrieve('neutral sample question')) ?? '').toContain('stale_chunks=5');
    searchStages.resetLexicalStaleCountForTests();
    install({ RAG_LEXICAL_DICTIONARY: 'true' }, staleRpc(() => Promise.resolve<RpcResponse>({ data: '6', error: null })));
    expect(searchDetail(await retrieve('neutral sample question')) ?? '').toContain('stale_chunks=6');
  });

  it('a stale count that never answers reads unknown within the stage budget', async () => {
    const { resolver } = resolverReturning({ options: { dictionary: stubDictionary() }, stamp: { dictVersion: DICT_VERSION, patterns: null }, warnings: [] });
    setLexicalOptionsResolverForTests(resolver);
    install({ RAG_LEXICAL_DICTIONARY: 'true' }, staleRpc(() => new Promise<RpcResponse>(() => undefined)));
    const result = await retrieve('neutral sample question');
    expect(result.status).not.toBe('error');
    expect(searchDetail(result) ?? '').toContain('stale_chunks=unknown');
  });

  it('a resolver failure keeps default tokens and shows dict=unavailable', async () => {
    setLexicalOptionsResolverForTests(async () => {
      throw new Error('resolver down');
    });
    const requests = install({ RAG_LEXICAL_DICTIONARY: 'true' }, staleRpc(okStale));
    const query = `neutral sample question about ${TERM}`;
    const result = await retrieve(query);
    expect(result.status).not.toBe('error');
    expect(requests[0]!.lexicalTokens).toEqual(queryLexicalTokens(query));
    expect(searchDetail(result) ?? '').toContain('dict=unavailable');
  });

  it('a dictionary load warning shows dict=unavailable', async () => {
    const { resolver } = resolverReturning({ options: undefined, stamp: { dictVersion: null, patterns: null }, warnings: ['lexical_dictionary_unavailable'] });
    setLexicalOptionsResolverForTests(resolver);
    install({ RAG_LEXICAL_DICTIONARY: 'true' }, staleRpc(okStale));
    expect(searchDetail(await retrieve('neutral sample question')) ?? '').toContain('dict=unavailable');
  });

  it('every variant of one request is tokenized with the options the pipeline resolved once', async () => {
    const { resolver, calls } = resolverReturning({ options: { dictionary: stubDictionary() }, stamp: { dictVersion: DICT_VERSION, patterns: null }, warnings: [] });
    setLexicalOptionsResolverForTests(resolver);
    const requests = install({ RAG_LEXICAL_DICTIONARY: 'true' }, staleRpc(okStale));
    await verifyV2Startup();
    const cfg = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'true', RAG_LEXICAL_DICTIONARY: 'true' });
    const variants: QueryVariant[] = [
      { text: `neutral sample question about ${TERM}`, language: null, kind: 'original' },
      { text: `condensed ${TERM} question`, language: null, kind: 'condensed' },
    ];
    await runSearchStages({
      input: { scope, query: variants[0]!.text, profile: 'eval', signal: new AbortController().signal },
      scope,
      config: cfg,
      profile: 'eval',
      params: effectiveRetrievalParams('eval', cfg, null),
      embedding: { vector: [0.1, 0.2, 0.3], profile: null },
      signal: new AbortController().signal,
      collector: createTraceCollector({ profile: 'eval', tenantKey: `o:${ORG_A}` }),
      variants,
      lexical: { options: { dictionary: stubDictionary() }, stamp: { dictVersion: DICT_VERSION, patterns: null }, unavailable: false },
    } as Parameters<typeof runSearchStages>[0]);
    expect(calls).toHaveLength(0);
    expect(requests.map((req) => req.lexicalTokens[0])).toEqual([`_t_${TERM}`, `_t_${TERM}`]);
  });
});
