import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeQueryLlm } from '../../../eval/harness/fake-query-llm.mts';
import { runRetrieval } from '@/lib/rag';
import { resetRetrievalBackendForTests, setRetrievalBackendForTests } from '@/lib/rag/backend/registry';
import type { BackendLegs, RetrievalBackend } from '@/lib/rag/backend/types';
import { systemPromptHashWithBlocks } from '@/lib/rag/cache/keys';
import type { CacheQuery, SemanticCache } from '@/lib/rag/cache/types';
import { resetActiveChunkingProfilesForTests } from '@/lib/rag/chunking/active';
import { resetRagConfigForTests } from '@/lib/rag/config';
import { decomposedAnswerTemplate } from '@/lib/rag/generation/decomposed-answer';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { createTraceCollector } from '@/lib/rag/trace/collector';
import type { RetrievalCacheContext } from '@/lib/rag/types';
import { resetV2StartupForTests, verifyV2Startup } from '@/lib/rag/v2/startup';
import { hit } from '../fusion/helpers';
import { adminWithRpc, fakeAssemblyAdmin, fakeRpcClient, installDeps, uninstallDeps } from '../helpers/pipeline-fakes';
import { SCOPE_SINGLE } from './fixtures';

const COMPOUND = 'What colour is the sample widget? How heavy is the sample gadget?';
const PARTS = ['What colour is the sample widget?', 'How heavy is the sample gadget?'];
const SINGLE = 'What does the sample widget report to the operator?';
const DOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BASE_HASH = 'b'.repeat(64);
const CONTEXT: RetrievalCacheContext = {
  generatorModel: 'provider/model-a',
  systemPromptHash: BASE_HASH,
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

let decomposeCalls = 0;

/** The systemPromptHash the semantic_cache stage looked up for one chat turn. */
async function lookedUpPromptHash(query: string, context: RetrievalCacheContext, envOver: Record<string, string> = {}): Promise<string | undefined> {
  uninstallDeps();
  resetV2StartupForTests();
  resetRagConfigForTests();
  resetActiveChunkingProfilesForTests();
  const { cache, checks } = recordingCache();
  const fake = createFakeQueryLlm({
    table: { version: 1, entries: [{ transform: 'decompose', query: COMPOUND, output: { questions: PARTS } }] },
  });
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
    query,
    profile: 'chat',
    options: { ragMode: 'strict', webSearchEnabled: false, maxResults: 25 },
    signal: new AbortController().signal,
    trace: collector,
    cacheContext: context,
  });
  decomposeCalls = fake.calls.filter((call) => call.transform === 'decompose').length;
  return checks[0]?.systemPromptHash;
}

describe('the decomposed-answer block enters systemPromptHash only while it is in the prompt (06.2 G2)', () => {
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

  it('an entry point that passes no block keeps the caller hash for a decomposed question', async () => {
    expect(await lookedUpPromptHash(COMPOUND, CONTEXT)).toBe(BASE_HASH);
    expect(decomposeCalls).toBe(1);
  });

  it('decomposedAnswer: false keeps the caller hash', async () => {
    expect(await lookedUpPromptHash(COMPOUND, { ...CONTEXT, decomposedAnswer: false })).toBe(BASE_HASH);
  });

  it('a question that is not decomposed keeps the caller hash even when the entry point passes the block', async () => {
    expect(await lookedUpPromptHash(SINGLE, { ...CONTEXT, decomposedAnswer: true })).toBe(BASE_HASH);
    expect(decomposeCalls).toBe(0);
  });

  it('RAG_DECOMPOSED_ANSWER=false keeps the caller hash', async () => {
    expect(await lookedUpPromptHash(COMPOUND, { ...CONTEXT, decomposedAnswer: true }, { RAG_DECOMPOSED_ANSWER: 'false' })).toBe(BASE_HASH);
  });

  it('a decomposed question whose prompt carries the block looks up its own hash', async () => {
    const withBlock = await lookedUpPromptHash(COMPOUND, { ...CONTEXT, decomposedAnswer: true });
    expect(withBlock).toMatch(/^[a-f0-9]{64}$/);
    expect(withBlock).not.toBe(BASE_HASH);
    expect(await lookedUpPromptHash(COMPOUND, { ...CONTEXT, decomposedAnswer: true })).toBe(withBlock);
  });
});

describe('systemPromptHashWithBlocks and the block template (06.2 G2, key level)', () => {
  it('without a block the caller hash is returned byte for byte', () => {
    expect(systemPromptHashWithBlocks(BASE_HASH, {})).toBe(BASE_HASH);
    expect(systemPromptHashWithBlocks(BASE_HASH, { decomposedAnswer: null })).toBe(BASE_HASH);
    expect(systemPromptHashWithBlocks(BASE_HASH, { decomposedAnswer: undefined })).toBe(BASE_HASH);
  });

  it('a block, and a change in its text, each give a new hash', () => {
    const one = systemPromptHashWithBlocks(BASE_HASH, { decomposedAnswer: 'template one' });
    const two = systemPromptHashWithBlocks(BASE_HASH, { decomposedAnswer: 'template two' });
    expect(one).toMatch(/^[a-f0-9]{64}$/);
    expect(one).not.toBe(BASE_HASH);
    expect(two).not.toBe(one);
    expect(systemPromptHashWithBlocks('c'.repeat(64), { decomposedAnswer: 'template one' })).not.toBe(one);
  });

  it('the template is null where buildDecomposedAnswerBlock builds nothing', () => {
    expect(decomposedAnswerTemplate(0, 'en')).toBeNull();
    expect(decomposedAnswerTemplate(1, 'en')).toBeNull();
    expect(decomposedAnswerTemplate(2, 'en')).toEqual(expect.any(String));
    expect(decomposedAnswerTemplate(3, 'en')).toBe(decomposedAnswerTemplate(2, 'en'));
  });
});

/** Each entry point with its prompt-side files; an entry point that passes the block must say so in its cacheContext. */
const ENTRY_POINTS: ReadonlyArray<{ name: string; cacheFile: string; promptFiles: readonly string[] }> = [
  { name: 'chat', cacheFile: 'src/app/api/chat/route.ts', promptFiles: ['src/app/api/chat/route.ts'] },
  { name: 'embed', cacheFile: 'src/app/api/embed/chat/route.ts', promptFiles: ['src/app/api/embed/chat/route.ts'] },
  {
    name: 'eval',
    cacheFile: 'src/app/api/internal/rag/run/route.ts',
    promptFiles: ['src/app/api/internal/rag/run/route.ts', 'src/lib/rag-eval/answer.ts'],
  },
];

describe('an entry point that passes the decomposed-answer block marks its cacheContext (06.2 G2 tripwire for 06.2-23)', () => {
  it.each(ENTRY_POINTS)('$name', ({ cacheFile, promptFiles }) => {
    const passesBlock = promptFiles.some((file) => /buildDecomposedAnswerBlock|decomposedAnswer\s*:/.test(readFileSync(file, 'utf8')));
    if (!passesBlock) return;
    const source = readFileSync(cacheFile, 'utf8');
    const start = source.indexOf('const cacheContext');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(source.slice(start, start + 1200)).toMatch(/decomposedAnswer/);
  });
});
