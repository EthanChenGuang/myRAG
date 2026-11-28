import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createFakeQueryLlm } from '../eval/harness/fake-query-llm.mts';
import type { CachedAnswer } from '@/lib/rag-eval/contracts.generated';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import type { CacheHit, CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import type { RetrievalResult } from '@/lib/rag/types';
import { fakeRpc } from './rag/cache/fake-rpc';
import { hit } from './rag/fusion/helpers';

const SECRET = 'c'.repeat(48);
const QUESTION = 'What does the sample widget report to the operator?';
const PROTECTED = 'What does the code ERR_SAMPLE_4031 mean for the widget?';
const SEED = 'The sample widget reports its status to the operator.';
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VECTOR = [0.1, 0.2, 0.3];
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'NODE_ENV',
  'RAG_PIPELINE',
  'RAG_QUERY_LAYER',
  'RAG_SEMANTIC_CACHE',
] as const;
const env = process.env as Record<string, string | undefined>;

function ragEnv() {
  return { RAG_PIPELINE: 'v2', RAG_LEXICAL_SEARCH: 'false', RAG_RERANKER: 'none', RAG_QUERY_LAYER: 'true', RAG_SEMANTIC_CACHE: 'pgvector' };
}

interface MemoryEntry {
  tenant: string;
  keyHash: string;
  profile: string;
  answer: CachedAnswer;
}

/** In-memory backend: any vector within the same tenant, key hash and embedding profile matches at distance 0.01. */
async function memoryCache() {
  const { computeCacheKeyHash } = await import('@/lib/rag/cache/keys');
  const { scopeKey } = await import('@/lib/rag/tenant/scope');
  const entries: MemoryEntry[] = [];
  const checks: CacheQuery[] = [];
  const stores: CacheQuery[] = [];
  const cache: SemanticCache = {
    async check(q) {
      checks.push(q);
      const keyHash = computeCacheKeyHash(q);
      const entry = entries.find((row) => row.tenant === scopeKey(q.scope) && row.keyHash === keyHash && row.profile === q.embeddingProfileId);
      return entry ? ({ entryId: 'entry-1', distance: 0.01, answer: entry.answer } satisfies CacheHit) : null;
    },
    async store(q, answer) {
      stores.push(q);
      entries.push({ tenant: scopeKey(q.scope), keyHash: computeCacheKeyHash(q), profile: q.embeddingProfileId, answer });
    },
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, checks, stores, entries };
}

function backend(): RetrievalBackend {
  return {
    id: 'pgvector',
    async search() {
      const dense = Array.from({ length: 3 }, (_, index) =>
        hit(`chunk-${index + 1}`, { rank: index + 1, similarity: 0.9 - index * 0.01, documentId: DOC, chunkIndex: index }),
      );
      return { dense, lexical: [] } satisfies BackendLegs;
    },
    health: async () => ({ ok: true }),
    isReady: async () => true,
  };
}

/** Loads the route and the real pipeline on fakes: fixed backend legs, a fixed embedder, the in-memory cache. */
async function setup() {
  vi.resetModules();
  const memory = await memoryCache();
  const fakes = await import('./rag/helpers/pipeline-fakes');
  const registry = await import('@/lib/rag/backend/registry');
  const startup = await import('@/lib/rag/v2/startup');
  const chunking = await import('@/lib/rag/chunking/active');
  const rpc = fakeRpc((fn, args) => {
    if (fn === 'rag_cache_resolve_sources') {
      const ids = (args.p_document_ids as string[]) ?? [];
      return { data: ids.map((id) => ({ document_id: id, name: `${id}.md`, version: 1 })), error: null };
    }
    return { data: [], error: null };
  });
  const fake = createFakeQueryLlm({ table: { version: 1, entries: [] } });
  chunking.resetActiveChunkingProfilesForTests();
  fakes.installDeps({
    embedder: async () => VECTOR,
    adminClient: fakes.adminWithRpc(rpc.client, fakes.fakeAssemblyAdmin()),
    queryLlm: () => fake,
    semanticCache: () => memory.cache,
    ragEnv,
  });
  registry.setRetrievalBackendForTests(backend());
  startup.resetV2StartupForTests();
  await startup.verifyV2Startup();
  const route = await import('@/app/api/internal/rag/run/route');
  const rag = await import('@/lib/rag');
  return { route, rag, memory, rpc };
}

function evalRequest(query: string, options: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/internal/rag/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
    body: JSON.stringify({ schema_version: 1, query, rag_mode: 'strict', options }),
  });
}

interface TraceBody {
  cache?: string;
  stage_status?: Record<string, string>;
  stage_counts?: Record<string, Record<string, number>>;
  answer: string | null;
}

const CACHE_ON = { semantic_cache: 'pgvector', generator_model: 'provider/model-a' };

describe('eval route semantic cache store and probe (D-37, D-38, plan-check B2)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.NODE_ENV = 'test';
    env.RAG_PIPELINE = 'v2';
    env.RAG_QUERY_LAYER = 'true';
    env.RAG_SEMANTIC_CACHE = 'pgvector';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    const fakes = await import('./rag/helpers/pipeline-fakes');
    const registry = await import('@/lib/rag/backend/registry');
    fakes.uninstallDeps();
    registry.resetRetrievalBackendForTests();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('stores the seed answer once before responding; the identical second request is a hit with its distance', async () => {
    const { route, memory } = await setup();
    const first = await route.POST(evalRequest(QUESTION, { ...CACHE_ON, cache_seed_answer: SEED }));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as TraceBody;
    expect(firstBody.cache).toBe('miss');
    expect(firstBody.stage_counts?.semantic_cache).toMatchObject({ hit: 0 });
    expect(memory.stores).toHaveLength(1);
    expect(memory.stores[0]!.entryProfile).toBe('eval');
    expect(memory.entries[0]!.answer.answer_text).toBe(SEED);

    const second = await route.POST(evalRequest(QUESTION, { ...CACHE_ON, cache_seed_answer: SEED }));
    expect(second.status).toBe(200);
    const body = (await second.json()) as TraceBody;
    expect(body.cache).toBe('hit');
    expect(body.stage_status?.semantic_cache).toBe('ok');
    expect(body.stage_counts?.semantic_cache).toMatchObject({ hit: 1, distance: 0.01 });
    expect(memory.stores).toHaveLength(1);
  });

  it('single tenant: an eval-seeded entry is a miss for a chat lookup with the same scope, text, vector and key parts; the eval re-check hits', async () => {
    const { route, rag, memory } = await setup();
    const seeded = await route.POST(evalRequest(QUESTION, { ...CACHE_ON, cache_seed_answer: SEED }));
    expect(seeded.status).toBe(200);
    expect(memory.stores).toHaveLength(1);
    const evalCheck = memory.checks[0]!;

    const collector = rag.createTraceCollector({ profile: 'chat', tenantKey: rag.scopeKey(evalCheck.scope) });
    const chat: RetrievalResult = await rag.runRetrieval({
      scope: evalCheck.scope,
      query: QUESTION,
      profile: 'chat',
      options: { ragMode: 'strict', webSearchEnabled: false },
      signal: new AbortController().signal,
      trace: collector,
      cacheContext: {
        generatorModel: evalCheck.generatorModel,
        systemPromptHash: evalCheck.systemPromptHash,
        webSearch: false,
        mcpTools: false,
        chatId: null,
      },
    });
    const chatCheck = memory.checks[1]!;
    expect(chatCheck.entryProfile).toBe('chat');
    expect(chatCheck.scope).toEqual(evalCheck.scope);
    expect(chatCheck.vector).toEqual(evalCheck.vector);
    expect(chatCheck.retrievalConfigHash).toBe(evalCheck.retrievalConfigHash);
    expect(rag.isCacheHitResult(chat)).toBe(false);

    const again = await route.POST(evalRequest(QUESTION, CACHE_ON));
    expect(((await again.json()) as TraceBody).cache).toBe('hit');
  });

  it('production: a request carrying cache_seed_answer gets 403 cache_seed_answer_not_allowed before any check or store; without the seed it is answered', async () => {
    env.NODE_ENV = 'production';
    const { route, memory } = await setup();
    const refused = await route.POST(evalRequest(QUESTION, { ...CACHE_ON, cache_seed_answer: SEED }));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'cache_seed_answer_not_allowed' });
    expect(memory.checks).toEqual([]);
    expect(memory.stores).toEqual([]);

    const plain = await route.POST(evalRequest(QUESTION, CACHE_ON));
    expect(plain.status).toBe(200);
    expect(memory.checks).toHaveLength(1);
    expect(memory.stores).toEqual([]);
  });

  it('a protected-token query records bypass protected_tokens and stores nothing', async () => {
    const { route, memory } = await setup();
    const response = await route.POST(evalRequest(PROTECTED, { ...CACHE_ON, cache_seed_answer: SEED }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as TraceBody;
    expect(body.cache).toBe('bypass');
    expect(body.stage_counts?.semantic_cache).toEqual({ bypass_protected_tokens: 1 });
    expect(memory.checks).toEqual([]);
    expect(memory.stores).toEqual([]);
  });

  it('without the override nothing is checked or stored and the trace has no cache field or cache counts', async () => {
    const { route, memory } = await setup();
    const response = await route.POST(evalRequest(QUESTION, { generator_model: 'provider/model-a' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as TraceBody;
    expect(body.cache).toBeUndefined();
    expect(body.stage_counts?.semantic_cache).toBeUndefined();
    expect(body.stage_status?.semantic_cache).toBe('disabled');
    expect(memory.checks).toEqual([]);
    expect(memory.stores).toEqual([]);
  });
});
