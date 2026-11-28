import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgvectorSemanticCache } from '@/lib/rag/cache/pgvector';
import type { ResolvedSource } from '@/lib/rag/cache/sources';
import { scheduleCacheStore, type CacheStoreDeps } from '@/lib/rag/cache/store-after';
import type { CacheTicket } from '@/lib/rag/cache/types';
import { NO_ANSWER_SENTINEL } from '@/lib/rag/generation/sentinel';
import { runAnswerChain } from '../../helpers/answer-chain';
import { CONFIG, DOC_1, SCOPE_A } from '../cache/fixtures';
import { fakeRpc } from '../cache/fake-rpc';

/**
 * GEN-15 (D-16), gaps G1/G2 of 05.2-VALIDATION.md. The route-level proof lives in two existing files, which this one does not repeat:
 * - tests/rag/chat-cache-hit.test.ts: the chat route stores a model-relevance refusal as a refusal (G1);
 * - tests/rag/embed-cache.test.ts: the embed route does the same and logs refused_no_context (G2).
 * This file fills the seam between them and the backend: the refusal flag the routes read (`refusedByModel()`) comes from the
 * real sentinel stream, and the pgvector backend then writes the row with the refusal TTL and no sources.
 */

const QUESTION = 'what does the placeholder section describe';

const ROUTE_TESTS: Array<{ file: string; title: string }> = [
  { file: 'tests/rag/chat-cache-hit.test.ts', title: 'relevance rule on: a model-relevance refusal is stored as a refusal' },
  { file: 'tests/rag/embed-cache.test.ts', title: 'relevance rule on: a model-relevance refusal is stored as a refusal and logged as refused_no_context' },
  { file: 'tests/rag/embed-cache.test.ts', title: 'relevance rule on, plain answer: stored as an answer and logged as answered' },
];

function ticket(): CacheTicket {
  return {
    key: {
      accessGroupSetHash: 'off',
      answerLanguage: 'en',
      ragMode: 'strict',
      generatorModel: 'provider/model-a',
      retrievalConfigHash: 'a'.repeat(64),
      queryFramework: 'llamaindex',
      entryProfile: 'chat',
      systemPromptHash: 'b'.repeat(64),
    },
    embeddingProfileId: 'p1',
    standalone: QUESTION,
    vector: [1, 0, 0, 0],
    turn: {
      profile: 'chat',
      evalCacheOverride: false,
      ragMode: 'strict',
      gate: { transforms: [], reasons: [], protectedTokens: [], skipRetrieval: false },
      rawQuery: QUESTION,
      standalone: QUESTION,
      historyLength: 0,
      condenseOk: true,
      webSearch: false,
      mcpTools: false,
      documentRefCount: 0,
      defaultMaxResults: 25,
    },
  };
}

/** Streams `pieces` through the real answer chain, then stores the turn the way the chat route's onFinish does. */
async function streamAndStore(pieces: string[]) {
  const out = await runAnswerChain({ pieces, sentinel: true, citations: true });
  const rpc = fakeRpc(() => ({ data: null, error: null }));
  const cache = createPgvectorSemanticCache({ adminClient: () => rpc.client, config: CONFIG });
  const tasks: Array<() => Promise<void>> = [];
  const deps: Partial<CacheStoreDeps> = {
    cache: () => cache,
    schedule: (task) => {
      tasks.push(task);
    },
    resolveSources: async (_scope, ids) => {
      const map = new Map<string, ResolvedSource>();
      for (const id of ids) map.set(id, { name: 'placeholder-current.md', version: 2 });
      return map;
    },
    readConfig: () => ({ groundedness: false, embedStore: false }),
    now: () => new Date('2026-11-28T00:00:00.000Z'),
  };
  const isRefusal = out.collector.refusedByModel();
  scheduleCacheStore(
    {
      scope: SCOPE_A,
      ticket: ticket(),
      traceId: 'trace-sentinel',
      facts: { chatId: null, sourceImages: false, retrievalStatus: 'ok', answerText: out.collector.finalText(), isRefusal },
      citations: [],
      sources: isRefusal ? [] : [{ documentId: DOC_1, name: 'placeholder.md', version: null }],
    },
    deps,
  );
  while (tasks.length > 0) await tasks.shift()!();
  const store = rpc.calls.find((call) => call.fn === 'rag_cache_store');
  return { out, isRefusal, store };
}

describe('sentinel refusal reaches the semantic cache as a refusal (GEN-15, G1/G2)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('the route tests for G1 and G2 are still in the tree (this file builds on them)', () => {
    for (const { file, title } of ROUTE_TESTS) {
      const source = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source, `${file} lost "${title}"`).toContain(title);
    }
  });

  it('a sentinel split across tokens: refusedByModel is true and the pgvector row is a refusal with the refusal TTL and no sources', async () => {
    const { out, isRefusal, store } = await streamAndStore([NO_ANSWER_SENTINEL.slice(0, 5), NO_ANSWER_SENTINEL.slice(5)]);
    expect(out.text).not.toContain(NO_ANSWER_SENTINEL);
    expect(isRefusal).toBe(true);
    expect(store?.args).toMatchObject({ p_is_refusal: true, p_ttl_seconds: CONFIG.refusalTtl, p_source_versions: [] });
    const answer = store?.args.p_answer as Record<string, unknown>;
    expect(answer).toMatchObject({ is_refusal: true, citations: [], sources: [], answer_text: out.collector.finalText() });
    expect(answer.groundedness).toMatchObject({ status: 'not_checked', reason: 'refusal' });
  });

  it('positive control: a plain answer is not a refusal and gets the answer TTL with its sources', async () => {
    const { isRefusal, store } = await streamAndStore(['Alpha is one [S1].']);
    expect(isRefusal).toBe(false);
    expect(store?.args).toMatchObject({ p_is_refusal: false, p_ttl_seconds: CONFIG.ttl });
    expect((store?.args.p_answer as { sources: unknown[] }).sources).toHaveLength(1);
  });
});
