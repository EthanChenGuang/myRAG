import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../../eval/harness/fake-query-llm.mts';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import type { CacheKeyParts, CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { loadRagConfig, resetRagConfigForTests } from '@/lib/rag/config';
import { queryLayerHashComponent } from '@/lib/rag/query/hash-part';
import { effectiveQueryParams } from '@/lib/rag/query/query-params';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { RetrievalCacheContext } from '@/lib/rag/types';
import { computeRetrievalConfigHash, type RetrievalConfigHashInput } from '@/lib/rag/v2/config-hash';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';
import { SCOPE_SINGLE } from './fixtures';

const DEFAULTS = { completeness: true, historyFallback: true, langidSidecar: false, scopeGate: false } as const;
type Name = keyof typeof DEFAULTS;
const NAMES = Object.keys(DEFAULTS) as Name[];

const KEY_BASE: Omit<CacheKeyParts, 'retrievalConfigHash'> = {
  accessGroupSetHash: 'off',
  answerLanguage: 'en',
  ragMode: 'strict',
  generatorModel: 'provider/model-a',
  queryFramework: 'llamaindex',
  entryProfile: 'chat',
  systemPromptHash: 'b'.repeat(64),
};

function literalHashInput(): RetrievalConfigHashInput {
  return {
    backendId: 'pgvector',
    embeddingProfileId: 'openai-3-small-1536',
    lexicalVersion: 1,
    rerankTextVersion: 1,
    params: { candidate_pool_size: 75, final_top_k: 8, rrf_k: 60, schema_version: 1 } as RetrievalConfigHashInput['params'],
    reranker: { id: 'none', model: 'none' },
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

function keyFor(additions?: Partial<Record<Name, boolean>>): string {
  resetRagConfigForTests();
  const layer = loadRagConfig({ RAG_PIPELINE: 'v2', RAG_QUERY_LAYER: 'true' }).queryLayer;
  const gated = additions === undefined ? {} : ({ additions } as Parameters<typeof queryLayerHashComponent>[2]);
  const queryLayer = queryLayerHashComponent(layer, effectiveQueryParams('chat'), gated);
  resetRagConfigForTests();
  return computeCacheKeyHash({ ...KEY_BASE, retrievalConfigHash: computeRetrievalConfigHash({ ...literalHashInput(), queryLayer }) });
}

describe('the semantic-cache key follows the query-addition switches (06.2 G5, key level)', () => {
  it('every switch at its default gives the key without the switches', () => {
    expect(keyFor({ ...DEFAULTS })).toBe(keyFor());
  });

  it.each(NAMES)('%s at its non-default value changes the key', (name) => {
    expect(keyFor({ ...DEFAULTS, [name]: !DEFAULTS[name] })).not.toBe(keyFor({ ...DEFAULTS }));
  });
});

const QUESTION = 'What does the sample widget report to the operator?';
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTEXT: RetrievalCacheContext = {
  generatorModel: 'provider/model-a',
  systemPromptHash: 'b'.repeat(64),
  webSearch: false,
  mcpTools: false,
  chatId: null,
};

function recordingCache() {
  const checks: CacheQuery[] = [];
  const cache: SemanticCache = {
    async check(q) {
      checks.push(q);
      return null;
    },
    async store() {},
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, checks };
}

/** The retrievalConfigHash the semantic_cache stage looked up for one chat turn under these extra variables. */
async function lookedUpHash(envOver: Record<string, string>): Promise<string | undefined> {
  uninstallDeps();
  resetV2StartupForTests();
  resetRagConfigForTests();
  resetActiveChunkingProfilesForTests();
  const { cache, checks } = recordingCache();
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  installDeps({
    embedder: async () => [0.1, 0.2, 0.3],
    adminClient: adminWithRpc(fakeRpcClient().client, fakeAssemblyAdmin()),
    queryLlm: () => fake,
    semanticCache: () => cache,
    ragEnv: () => ({
      RAG_PIPELINE: 'v2',
      RAG_LEXICAL_SEARCH: 'false',
      RAG_RERANKER: 'none',
      RAG_QUERY_LAYER: 'true',
      RAG_SEMANTIC_CACHE: 'pgvector',
      ...envOver,
    }),
  });
  const backend: RetrievalBackend = {
    id: 'pgvector',
    async search() {
      return { dense: [hit('chunk-1', { rank: 1, similarity: 0.9, documentId: DOC, chunkIndex: 0 })], lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
  setRetrievalBackendForTests(backend);
  await verifyV2Startup();
  const collector = createTraceCollector({ profile: 'chat', tenantKey: scopeKey(SCOPE_SINGLE) });
  await runRetrieval({
    scope: SCOPE_SINGLE,
    query: QUESTION,
    profile: 'chat',
    options: { ragMode: 'strict', webSearchEnabled: false, maxResults: 25 },
    signal: new AbortController().signal,
    trace: collector,
    cacheContext: CONTEXT,
  });
  return checks[0]?.retrievalConfigHash;
}

describe('the semantic_cache stage looks up a new key after a query-addition flip (06.2 G5, stage level)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    uninstallDeps();
    resetRetrievalBackendForTests();
    resetRagConfigForTests();
    vi.restoreAllMocks();
  });

  it('explicit defaults look up the same key as unset variables; each flip looks up its own key', async () => {
    const base = await lookedUpHash({});
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    const explicitDefaults = await lookedUpHash({
      RAG_QUERY_DECOMPOSE_COMPLETENESS: 'true',
      RAG_QUERY_HISTORY_FALLBACK: 'true',
      RAG_LANGID_SIDECAR: 'false',
      RAG_SCOPE_GATE: 'false',
    });
    expect(explicitDefaults).toBe(base);
    const flipped = [
      await lookedUpHash({ RAG_QUERY_DECOMPOSE_COMPLETENESS: 'false' }),
      await lookedUpHash({ RAG_QUERY_HISTORY_FALLBACK: 'false' }),
      await lookedUpHash({ RAG_LANGID_SIDECAR: 'true' }),
    ];
    for (const hash of flipped) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hash).not.toBe(base);
    }
    expect(new Set(flipped).size).toBe(flipped.length);
  });
});
