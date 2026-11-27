import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest } from '@/lib/rag/backend/supabase-rpc';
import type { BackendSearchRequest, RetrievalBackend } from '@/lib/rag/backend/types';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import { effectiveLexicalVersion, loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { runRetrieval } from '@/lib/rag';
import { QUANTITY_TOKEN_PREFIX } from '@/lib/rag/lexical/options';
import { resetLexicalOptionsForTests, setLexicalOptionsResolverForTests, type ResolvedLexicalOptions } from '@/lib/rag/lexical/resolve-options';
import { MAX_ADDITIVE_QUERY_TOKENS, queryLexicalTokens } from '@/lib/rag/lexical/tokenize';
import { decideRefusal, type GateInput, type ThresholdCell } from '@/lib/rag/refusal/gate';
import { mintScope } from '@/lib/rag/tenant/scope';
import * as searchStages from '@/lib/rag/v2/stages/search';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeEmbedder, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';

// Numbers, general symbols and invented words only.
const ORG = '00000000-0000-4000-8000-00000000003a';
const scope = mintScope('org', '00000000-0000-4000-8000-0000000000ab', ORG);
const QUESTION = 'quanto vale 2,5 kg nel quorvo';
const Q_TOKEN = `${QUANTITY_TOKEN_PREFIX}2.5kg`;

function quietRpc(): RpcClient {
  return {
    rpc(): RpcRequest {
      const request: RpcRequest = {
        abortSignal: () => request,
        then: (onFulfilled, onRejected) => Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

function install(env: Record<string, string>): BackendSearchRequest[] {
  resetActiveChunkingProfilesForTests();
  const requests: BackendSearchRequest[] = [];
  const { embedder } = fakeEmbedder();
  installDeps({
    embedder,
    adminClient: adminWithRpc(quietRpc(), fakeAssemblyAdmin()),
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

function countingResolver(result: () => Promise<ResolvedLexicalOptions>) {
  const calls: Array<string | null> = [];
  setLexicalOptionsResolverForTests(async (_scope, _config, input) => {
    calls.push(input.language);
    return result();
  });
  return calls;
}

async function retrieve(query: string) {
  await verifyV2Startup();
  return runRetrieval({ scope, query, profile: 'eval', signal: new AbortController().signal });
}

const QUANTITY_ONLY: ResolvedLexicalOptions = { options: { quantity: true }, stamp: { dictVersion: null, patterns: null }, warnings: [] };

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

describe('query side with RAG_LEXICAL_QUANTITY (D-31, D-33)', () => {
  it('every switch off: the resolver is not called and the tokens are the defaults', async () => {
    const calls = countingResolver(async () => QUANTITY_ONLY);
    const requests = install({});
    await retrieve(QUESTION);
    expect(calls).toHaveLength(0);
    expect(requests.map((req) => req.lexicalTokens)).toEqual([queryLexicalTokens(QUESTION)]);
    expect(requests[0]!.lexicalTokens.some((token) => token.startsWith(QUANTITY_TOKEN_PREFIX))).toBe(false);
  });

  it('quantity alone: one resolve per request and the quantity token leads the variant', async () => {
    const calls = countingResolver(async () => QUANTITY_ONLY);
    const requests = install({ RAG_LEXICAL_QUANTITY: 'true' });
    await retrieve(QUESTION);
    expect(calls).toHaveLength(1);
    expect(requests[0]!.lexicalTokens[0]).toBe(Q_TOKEN);
  });

  it('a question of more than 64 natural tokens keeps the quantity token; additive tokens stay capped', async () => {
    countingResolver(async () => QUANTITY_ONLY);
    const requests = install({ RAG_LEXICAL_QUANTITY: 'true' });
    const filler = Array.from({ length: 70 }, (_, index) => `zorb${index}`).join(' ');
    const many = Array.from({ length: 20 }, (_, index) => `${index + 1} kg`).join(' ');
    await retrieve(`${QUESTION} ${filler}`);
    expect(requests[0]!.lexicalTokens).toContain(Q_TOKEN);
    requests.length = 0;
    await retrieve(`${many} ${filler}`);
    const additive = requests[0]!.lexicalTokens.filter((token) => token.startsWith(QUANTITY_TOKEN_PREFIX));
    expect(additive.length).toBeGreaterThan(0);
    expect(additive.length).toBeLessThanOrEqual(MAX_ADDITIVE_QUERY_TOKENS);
  });

  it('a resolver failure keeps default tokens and the request continues', async () => {
    countingResolver(async () => {
      throw new Error('resolver down');
    });
    const requests = install({ RAG_LEXICAL_QUANTITY: 'true' });
    const result = await retrieve(QUESTION);
    expect(result.status).not.toBe('error');
    expect(requests[0]!.lexicalTokens).toEqual(queryLexicalTokens(QUESTION));
  });

  it('the config hash carries the effective version: on differs from off, and off equals an explicit false', async () => {
    countingResolver(async () => QUANTITY_ONLY);
    install({});
    const offDefault = (await retrieve(QUESTION)).retrievalConfigHash;
    install({ RAG_LEXICAL_QUANTITY: 'false' });
    const offExplicit = (await retrieve(QUESTION)).retrievalConfigHash;
    install({ RAG_LEXICAL_QUANTITY: 'true' });
    const on = (await retrieve(QUESTION)).retrievalConfigHash;
    expect(offDefault).toBeTruthy();
    expect(offExplicit).toBe(offDefault);
    expect(on).toBeTruthy();
    expect(on).not.toBe(offDefault);
  });
});

describe('refusal cells across the quantity bit (D-33)', () => {
  const cell: ThresholdCell = {
    key: 'cohere|rerank-v5.0-pro|it|same',
    provider: 'cohere',
    model: 'rerank-v5.0-pro',
    query_language: 'it',
    pairing: 'same',
    threshold: 0.3,
    status: 'calibrated',
    source: 'live',
    tokenizer_version: 2,
    rerank_text_version: 1,
  };
  const input = (lexical: number): GateInput => ({
    enabled: true,
    profile: 'chat',
    reranker: { id: 'cohere', model: 'rerank-v5.0-pro', scoreSemantics: 'calibrated' },
    rerankStatus: 'ok',
    reranked: [{ score: 0.5, language: 'it' }],
    queryLanguage: 'it',
    cells: new Map([[cell.key, cell]]),
    versions: { lexical, rerankText: 1 },
  });

  it('the effective version is 6 to 9 with the switch on, and a cell recorded for version 2 is not applied', () => {
    expect(effectiveLexicalVersion(loadRagConfig({ RAG_LEXICAL_QUANTITY: 'true' }))).toBe(6);
    expect(effectiveLexicalVersion(loadRagConfig({ RAG_LEXICAL_QUANTITY: 'true', RAG_LEXICAL_DICTIONARY: 'true', RAG_LEXICAL_STEM_IT: 'true' }))).toBe(9);
    expect(effectiveLexicalVersion(loadRagConfig({}))).toBe(2);
    const on = effectiveLexicalVersion(loadRagConfig({ RAG_LEXICAL_QUANTITY: 'true' }));
    expect(decideRefusal(input(on)).reason).toBe('cell_stale');
    expect(decideRefusal(input(2)).decision).not.toBe('not_applied');
  });
});
