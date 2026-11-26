import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedAnswer, CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { CheckBypassReason, TurnFacts } from '@/lib/rag/cache/bypass';
import { createPgvectorSemanticCache } from '@/lib/rag/cache/pgvector';
import type { ResolvedSource } from '@/lib/rag/cache/sources';
import {
  CACHE_STORE_GROUNDEDNESS_WAIT_MS,
  cacheSourcesFromResult,
  scheduleCacheStore,
  type CacheStoreDeps,
  type ScheduleCacheStoreInput,
} from '@/lib/rag/cache/store-after';
import type { CacheQuery, CacheTicket, SemanticCache } from '@/lib/rag/cache/types';
import type { AnswerGroundedness } from '@/lib/rag/generation/groundedness';
import { scopeKey } from '@/lib/rag/tenant/scope';
import { CONFIG, DOC_1, SCOPE_A, SCOPE_B } from './fixtures';
import { fakeRpc } from './fake-rpc';

const QUESTION = 'what does the placeholder section describe';

function turn(overrides: Partial<TurnFacts> = {}): TurnFacts {
  return {
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
    ...overrides,
  };
}

function ticket(overrides: Partial<TurnFacts> = {}): CacheTicket {
  return {
    key: {
      answerLanguage: 'en',
      ragMode: 'strict',
      generatorModel: 'provider/model-a',
      retrievalConfigHash: 'a'.repeat(64),
      queryFramework: 'llamaindex',
      entryProfile: overrides.profile === 'embed' ? 'embed' : 'chat',
      systemPromptHash: 'b'.repeat(64),
    },
    embeddingProfileId: 'p1',
    standalone: QUESTION,
    vector: [1, 0, 0, 0],
    turn: turn(overrides),
  };
}

function citation(): CitationRecord {
  return {
    alias: 'S1',
    chunkIds: ['chunk-1'],
    documentId: DOC_1,
    documentName: 'placeholder.md',
    documentVersion: null,
    n: 1,
    page: null,
    quote: 'A neutral placeholder sentence.',
    quoteHash: 'c'.repeat(64),
    sectionPath: null,
    strategy: 'chunk-alias',
  };
}

function scored(label: 'verified' | 'possibly_unreliable'): AnswerGroundedness {
  return {
    status: 'scored',
    label,
    scorer: 'hhem_2_1_open',
    score: label === 'verified' ? 0.91 : 0.12,
    threshold: 0.5,
    thresholdSource: 'default',
    reason: null,
    truncated: false,
    latencyMs: 40,
    checkedAt: '2026-11-25T00:00:01.000Z',
  } as AnswerGroundedness;
}

function notChecked(reason: string): AnswerGroundedness {
  return {
    status: 'not_checked',
    label: 'not_checked',
    scorer: 'none',
    score: null,
    threshold: null,
    thresholdSource: null,
    reason,
    truncated: false,
    latencyMs: 0,
    checkedAt: '2026-11-25T00:00:01.000Z',
  } as AnswerGroundedness;
}

function recordingCache() {
  const stored: Array<{ q: CacheQuery; answer: CachedAnswer }> = [];
  const cache: SemanticCache = {
    async check() {
      return null;
    },
    async store(q, answer) {
      stored.push({ q, answer });
    },
    async invalidateTenant() {
      return 0;
    },
  };
  return { cache, stored };
}

function harness(config: { groundedness?: boolean; embedStore?: boolean } = {}, cache: SemanticCache | null = recordingCache().cache) {
  const tasks: Array<() => Promise<void>> = [];
  const resolve = vi.fn(async (_scope: unknown, ids: readonly string[]) => {
    const map = new Map<string, ResolvedSource>();
    for (const id of ids) map.set(id, { name: 'placeholder-current.md', version: 3 });
    return map;
  });
  const deps: Partial<CacheStoreDeps> = {
    cache: () => cache,
    schedule: (task) => {
      tasks.push(task);
    },
    resolveSources: resolve,
    readConfig: () => ({ groundedness: config.groundedness ?? false, embedStore: config.embedStore ?? false }),
    now: () => new Date('2026-11-25T00:00:02.000Z'),
  };
  const drain = async () => {
    while (tasks.length > 0) await tasks.shift()!();
  };
  return { deps, tasks, drain, resolve };
}

function input(overrides: Partial<ScheduleCacheStoreInput> = {}): ScheduleCacheStoreInput {
  return {
    scope: SCOPE_A,
    ticket: ticket(),
    traceId: 'trace-original',
    facts: { chatId: null, sourceImages: false, retrievalStatus: 'ok', answerText: 'A neutral placeholder answer [S1].', isRefusal: false },
    citations: [citation()],
    sources: [{ documentId: DOC_1, name: 'placeholder.md', version: null }],
    ...overrides,
  };
}

describe('scheduleCacheStore (D-32, D-33, D-36, A-3)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs only inside the scheduled after-response task, never on the calling path', async () => {
    const { cache, stored } = recordingCache();
    const h = harness({}, cache);
    scheduleCacheStore(input(), h.deps);
    expect(h.tasks).toHaveLength(1);
    await Promise.resolve();
    expect(stored).toEqual([]);
    await h.drain();
    expect(stored).toHaveLength(1);
  });

  it('groundedness off: stores right after the response with a not_checked label and the request scope', async () => {
    const { cache, stored } = recordingCache();
    const h = harness({ groundedness: false }, cache);
    scheduleCacheStore(input({ groundedness: null }), h.deps);
    await h.drain();
    expect(stored).toHaveLength(1);
    const [{ q, answer }] = stored;
    expect(scopeKey(q.scope)).toBe(scopeKey(SCOPE_A));
    expect(q).toMatchObject({ standalone: QUESTION, vector: [1, 0, 0, 0], embeddingProfileId: 'p1', entryProfile: 'chat', systemPromptHash: 'b'.repeat(64) });
    expect(answer.groundedness).toMatchObject({ status: 'not_checked', label: 'not_checked', reason: 'disabled' });
    expect(answer).toMatchObject({
      answer_text: 'A neutral placeholder answer [S1].',
      answer_language: 'en',
      rag_mode: 'strict',
      is_refusal: false,
      trace_id: 'trace-original',
      created_at: '2026-11-25T00:00:02.000Z',
      source_versions: [{ document_id: DOC_1, version: 3 }],
      sources: [{ document_id: DOC_1, name: 'placeholder-current.md', version: 3 }],
    });
    expect(answer.citations?.[0]).toMatchObject({ documentId: DOC_1, documentVersion: 3, quote: 'A neutral placeholder sentence.' });
  });

  it('groundedness on: waits for the label; verified and not_checked are stored with the whole object, possibly_unreliable is not', async () => {
    for (const [groundedness, expected] of [
      [scored('verified'), true],
      [notChecked('not_eligible'), true],
      [scored('possibly_unreliable'), false],
    ] as const) {
      const { cache, stored } = recordingCache();
      const h = harness({ groundedness: true }, cache);
      let settle: (value: AnswerGroundedness) => void = () => undefined;
      const promise = new Promise<AnswerGroundedness>((resolve) => {
        settle = resolve;
      });
      scheduleCacheStore(input({ groundedness: promise }), h.deps);
      const running = h.drain();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(stored).toEqual([]);
      settle(groundedness);
      await running;
      expect(stored.length === 1).toBe(expected);
      if (expected) expect(stored[0].answer.groundedness).toEqual(groundedness);
    }
  });

  it('groundedness on: a rejected, null or unsettled label promise stores nothing; no promise at all stores nothing either', async () => {
    vi.useFakeTimers();
    const promises: Array<() => Promise<AnswerGroundedness | null> | undefined> = [
      () => {
        const rejected = Promise.reject(new Error('scoring failed'));
        rejected.catch(() => undefined);
        return rejected;
      },
      () => Promise.resolve(null),
      () => new Promise<AnswerGroundedness>(() => undefined),
      () => undefined,
    ];
    for (const make of promises) {
      const { cache, stored } = recordingCache();
      const h = harness({ groundedness: true }, cache);
      scheduleCacheStore(input({ groundedness: make() }), h.deps);
      const running = h.drain();
      await vi.advanceTimersByTimeAsync(CACHE_STORE_GROUNDEDNESS_WAIT_MS + 10);
      await running;
      expect(stored).toEqual([]);
    }
    expect(CACHE_STORE_GROUNDEDNESS_WAIT_MS).toBe(25_000);
  });

  it('a pending groundedness object is never stored', async () => {
    const { cache, stored } = recordingCache();
    const h = harness({ groundedness: true }, cache);
    scheduleCacheStore(input({ groundedness: Promise.resolve({ status: 'pending' } as AnswerGroundedness) }), h.deps);
    await h.drain();
    expect(stored).toEqual([]);
  });

  it('every storeBypassReason case prevents the store call', async () => {
    const cases: Array<[string, Partial<ScheduleCacheStoreInput>]> = [
      ['ghost_chat', { facts: { ...input().facts, chatId: 'ghost-1234' } }],
      ['history_dependent', { ticket: ticket({ historyLength: 2 }) }],
      ['history_dependent (rewritten)', { ticket: ticket({ standalone: 'a different standalone question' }) }],
      ['source_images', { facts: { ...input().facts, sourceImages: true } }],
      ['retrieval_status degraded', { facts: { ...input().facts, retrievalStatus: 'degraded' } }],
      ['retrieval_status error', { facts: { ...input().facts, retrievalStatus: 'error' } }],
      ['empty_answer', { facts: { ...input().facts, answerText: '   ' } }],
      ['tools (webSearch)', { ticket: ticket({ webSearch: true }) }],
      ['tools (mcp)', { ticket: ticket({ mcpTools: true }) }],
      ['tools (used in the turn)', { facts: { ...input().facts, toolsUsed: true } }],
      ['document_refs' satisfies CheckBypassReason, { ticket: ticket({ documentRefCount: 1 }) }],
      ['retrieval_options generalOverview' , { ticket: ticket({ retrievalOptions: { generalOverview: true } }) }],
      ['retrieval_options maxResults', { ticket: ticket({ retrievalOptions: { maxResults: 7 } }) }],
      ['personal_data', { ticket: ticket({ rawQuery: 'what is my placeholder setting', standalone: 'what is my placeholder setting' }) }],
      ['embed_check_only', { ticket: ticket({ profile: 'embed' }) }],
      ['no scope', { scope: null }],
      ['no ticket', { ticket: undefined }],
    ];
    for (const [label, overrides] of cases) {
      const { cache, stored } = recordingCache();
      const h = harness({}, cache);
      scheduleCacheStore(input(overrides), h.deps);
      await h.drain();
      expect(stored, label).toEqual([]);
    }
  });

  it('embed with RAG_SEMANTIC_CACHE_EMBED_STORE=true stores under the embed entry profile', async () => {
    const { cache, stored } = recordingCache();
    const h = harness({ embedStore: true }, cache);
    scheduleCacheStore(input({ ticket: ticket({ profile: 'embed' }) }), h.deps);
    await h.drain();
    expect(stored).toHaveLength(1);
    expect(stored[0].q.entryProfile).toBe('embed');
  });

  it('a refusal is passed to the backend as a refusal with no citations or sources, and the pgvector backend gives it the refusal TTL', async () => {
    const { cache, stored } = recordingCache();
    const h = harness({ groundedness: true }, cache);
    scheduleCacheStore(
      input({
        facts: { ...input().facts, retrievalStatus: 'empty', answerText: 'Information Not Available (placeholder).', isRefusal: true },
        citations: [],
        sources: [],
      }),
      h.deps,
    );
    await h.drain();
    expect(stored).toHaveLength(1);
    expect(stored[0].answer).toMatchObject({ is_refusal: true, citations: [], sources: [], source_versions: [] });
    expect(stored[0].answer.groundedness).toMatchObject({ status: 'not_checked', reason: 'refusal' });
    expect(h.resolve).not.toHaveBeenCalled();

    const rpc = fakeRpc(() => ({ data: 'entry-1', error: null }));
    const pg = createPgvectorSemanticCache({ adminClient: () => rpc.client, config: CONFIG });
    await pg.store(stored[0].q, stored[0].answer);
    expect(rpc.calls.find((call) => call.fn === 'rag_cache_store')?.args).toMatchObject({ p_is_refusal: true, p_ttl_seconds: CONFIG.refusalTtl });
  });

  it('a source that no longer resolves, or whose version changed since retrieval, is not stored', async () => {
    for (const [resolved, version] of [
      [new Map<string, ResolvedSource>(), null],
      [new Map<string, ResolvedSource>([[DOC_1, { name: 'placeholder.md', version: 4 }]]), 3],
    ] as const) {
      const { cache, stored } = recordingCache();
      const h = harness({}, cache);
      h.resolve.mockResolvedValueOnce(resolved);
      scheduleCacheStore(input({ sources: [{ documentId: DOC_1, name: 'placeholder.md', version }] }), h.deps);
      await h.drain();
      expect(stored).toEqual([]);
    }
  });

  it('stores under the scope of the request it is given: tenant B never writes into tenant A', async () => {
    const { cache, stored } = recordingCache();
    const h = harness({}, cache);
    scheduleCacheStore(input({ scope: SCOPE_B }), h.deps);
    await h.drain();
    expect(stored.map((entry) => scopeKey(entry.q.scope))).toEqual([scopeKey(SCOPE_B)]);
    expect(h.resolve.mock.calls[0][0]).toBe(SCOPE_B);
  });

  it('a backend store error is logged once with [Semantic Cache] and a hashed tenant key, and swallowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing: SemanticCache = {
      async check() {
        return null;
      },
      async store() {
        throw new Error('backend down');
      },
      async invalidateTenant() {
        return 0;
      },
    };
    const h = harness({}, failing);
    expect(() => scheduleCacheStore(input(), h.deps)).not.toThrow();
    await expect(h.drain()).resolves.toBeUndefined();
    const lines = warn.mock.calls.filter((call) => String(call[0]).startsWith('[Semantic Cache]'));
    expect(lines).toHaveLength(1);
    const detail = lines[0][1] as Record<string, unknown>;
    expect(detail.tenant).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(lines[0])).not.toContain(scopeKey(SCOPE_A));
    expect(JSON.stringify(lines[0])).not.toContain(QUESTION);
  });

  it('no backend: nothing is scheduled', () => {
    const h = harness({}, null);
    scheduleCacheStore(input(), h.deps);
    expect(h.tasks).toEqual([]);
  });
});

describe('cacheSourcesFromResult', () => {
  it('lists each non-image context document once with its block version, falling back to the kept chunks', () => {
    expect(
      cacheSourcesFromResult({
        blocks: [
          { documentId: DOC_1, documentName: 'placeholder.md', documentVersion: 2, chunkIds: ['c1'], page: null, sectionPath: null, title: '', text: 'x', isImage: false, alias: 'S1' },
          { documentId: DOC_1, documentName: 'placeholder.md', documentVersion: 2, chunkIds: ['c2'], page: null, sectionPath: null, title: '', text: 'y', isImage: false, alias: 'S2' },
        ],
        kept: [],
      }),
    ).toEqual([{ documentId: DOC_1, name: 'placeholder.md', version: 2 }]);
    expect(
      cacheSourcesFromResult({
        kept: [{ chunk_id: 'c1', document_id: DOC_1, document_name: 'placeholder.md', content: 'x', similarity: 0.9, rank: 1, kept_by: 'similarity' }],
      }),
    ).toEqual([{ documentId: DOC_1, name: 'placeholder.md', version: null }]);
  });
});
