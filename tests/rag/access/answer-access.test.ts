import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintScope } from '@/lib/rag/tenant/scope';
import type { InsertAnswerRecordInput } from '@/lib/answers/store';
import type { CitationRecord } from '@/lib/rag-eval/contracts.generated';
import { mintAnswerId, scheduleAnswerFinish, type AnswerFinishDeps, type AnswerFinishInput } from '@/lib/rag/generation/answer-finish';
import { answerReaderVisibility, documentStatuses, readerDocumentStatuses, type ReaderDocumentVisibility } from '@/lib/answers/read';
import { citationDisplayEntries } from '@/lib/citations/display';
import { createPgvectorSemanticCache } from '@/lib/rag/cache/pgvector';
import { createRedisvlSemanticCache } from '@/lib/rag/cache/redisvl-http';
import { createSemanticCacheBackend } from '@/lib/rag/cache/index';
import type { CacheAccessIo } from '@/lib/rag/cache/types';
import { computeCacheKeyHash } from '@/lib/rag/cache/keys';
import { CONFIG, DOC_1, cacheQuery, cachedAnswer } from '../cache/fixtures';
import { fakeRpc } from '../cache/fake-rpc';

// 04.3-13 (SEC-13, D-23, D-25, A-06, A-13): answer records carry the cited documents' label sets, the answer read path drops the link of a
// citation the reader can no longer see, and both semantic cache backends apply the caller's access. Neutral synthetic data.

const USER = '00000000-0000-4000-8000-0000000013a1';
const GROUP_A = '00000000-0000-4000-8000-0000000013c1';
const DOC_VISIBLE = '00000000-0000-4000-8000-0000000013d1';
const DOC_HIDDEN = '00000000-0000-4000-8000-0000000013d2';
const DOC_2 = '00000000-0000-4000-8000-00000000d002';

function quote(n: number, documentId: string, text: string): CitationRecord {
  return {
    n,
    alias: `S${n}`,
    chunkIds: [`c${n}`],
    documentId,
    documentName: `record-${n}.md`,
    documentVersion: 1,
    page: null,
    sectionPath: null,
    quote: text,
    quoteHash: createHash('sha256').update(text).digest('hex'),
    strategy: 'chunk-alias',
  };
}

function harness() {
  const inserts: InsertAnswerRecordInput[] = [];
  const tasks: Array<() => Promise<void>> = [];
  const admin = {
    from() {
      const builder = { select: () => builder, eq: () => builder, maybeSingle: async () => ({ data: null, error: null }) };
      return builder;
    },
  } as unknown as SupabaseClient;
  const deps: Partial<AnswerFinishDeps> = {
    admin: () => admin,
    insert: async (_client, input) => {
      inserts.push(input);
      return { inserted: true };
    },
    schedule: (task) => {
      tasks.push(task);
    },
    readConfig: () => ({ groundedness: false }),
  };
  return {
    inserts,
    deps,
    async run() {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

function finishInput(overrides: Partial<AnswerFinishInput> = {}): AnswerFinishInput {
  return {
    answerId: mintAnswerId(),
    scope: mintScope('single', null, null),
    userId: USER,
    chatId: null,
    traceId: 'trace-1',
    modelId: 'test/model',
    ragMode: 'strict',
    queryText: 'What does the sample clause say?',
    citations: [quote(1, DOC_VISIBLE, 'A neutral synthetic clause.')],
    citationStrategy: 'chunk-alias',
    invalidCitations: 0,
    answerText: 'The clause is neutral [S1].',
    aborted: false,
    groundednessEligible: false,
    toolOutputUsed: false,
    premise: { blocks: [{ alias: 'S1', text: 'A neutral synthetic clause.' }], webSearchTexts: [] },
    requestLanguage: 'en',
    ...overrides,
  };
}

function documentsClient(rows: Array<{ id: string; is_current: boolean; status: string }>): SupabaseClient {
  return {
    from() {
      const builder = {
        select: () => builder,
        in: async (_column: string, ids: string[]) => ({ data: rows.filter((row) => ids.includes(row.id)), error: null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('answer finish writes access sets', () => {
  it('passes the cited documents\' label sets to the store, keys only', async () => {
    const h = harness();
    const sets = [[`g:${GROUP_A}`]];
    const done = scheduleAnswerFinish(finishInput({ accessSets: sets }), h.deps);
    await h.run();
    await done;
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]!.accessSets).toEqual(sets);
    expect(JSON.stringify(h.inserts[0]!.accessSets)).not.toMatch(/clause|record-1/);
  });

  it('with access off (no sets) the insert carries no accessSets, so the column stays NULL', async () => {
    const h = harness();
    const done = scheduleAnswerFinish(finishInput(), h.deps);
    await h.run();
    await done;
    expect(h.inserts).toHaveLength(1);
    expect('accessSets' in h.inserts[0]!).toBe(false);
  });
});

describe('answer read path under access groups (A-13, D-15)', () => {
  const client = documentsClient([
    { id: DOC_VISIBLE, is_current: true, status: 'ready' },
    { id: DOC_HIDDEN, is_current: true, status: 'ready' },
  ]);
  const citations = [quote(1, DOC_VISIBLE, 'A visible synthetic clause.'), quote(2, DOC_HIDDEN, 'A restricted synthetic clause.')];

  it('keeps the snapshot text and drops the link of a citation whose document the reader can no longer see; one batched call', async () => {
    const asked: string[][] = [];
    const visibility: ReaderDocumentVisibility = async (ids) => {
      asked.push([...ids]);
      return { ok: true, ids: new Set([DOC_VISIBLE]) };
    };
    const documents = await readerDocumentStatuses(client, [DOC_VISIBLE, DOC_HIDDEN], visibility);
    expect(asked).toEqual([[DOC_VISIBLE, DOC_HIDDEN]]);
    expect(documents).toEqual({ [DOC_VISIBLE]: 'current', [DOC_HIDDEN]: 'unavailable' });
    const entries = citationDisplayEntries(citations, documents);
    expect(entries[0]).toMatchObject({ linkDocumentId: DOC_VISIBLE, unavailable: false });
    expect(entries[1]).toMatchObject({ linkDocumentId: null, unavailable: true, quote: 'A restricted synthetic clause.' });
  });

  it('a failed visibility check drops every link (fails closed)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const documents = await readerDocumentStatuses(client, [DOC_VISIBLE, DOC_HIDDEN], async () => ({ ok: false }));
    expect(documents).toEqual({ [DOC_VISIBLE]: 'unavailable', [DOC_HIDDEN]: 'unavailable' });
    const thrown = await readerDocumentStatuses(client, [DOC_VISIBLE], async () => {
      throw new Error('lookup');
    });
    expect(thrown).toEqual({ [DOC_VISIBLE]: 'unavailable' });
  });

  it('with access groups off the reader visibility is null and the statuses equal documentStatuses', async () => {
    expect(process.env.RAG_DOC_ACCESS_GROUPS ?? 'off').not.toBe('on');
    expect(await answerReaderVisibility({ organization_id: null }, USER)).toBeNull();
    expect(await readerDocumentStatuses(client, [DOC_VISIBLE, DOC_HIDDEN], null)).toEqual(await documentStatuses(client, [DOC_VISIBLE, DOC_HIDDEN]));
  });
});

function accessIo(options: { args?: { p_access_keys?: string[]; p_access_all?: boolean }; visible?: string[] | 'fail' } = {}) {
  const visibilityCalls: string[][] = [];
  const io: CacheAccessIo = {
    accessRpcArgs: async () => options.args ?? {},
    visibleDocumentIds: async (_scope, ids) => {
      visibilityCalls.push([...ids]);
      if (options.visible === 'fail') return { ok: false };
      return { ok: true, ids: new Set(options.visible ?? ids) };
    },
  };
  return { io, visibilityCalls };
}

describe('pgvector cache sends the caller\'s access arguments (D-23)', () => {
  it('adds p_access_keys and p_access_all from the access io', async () => {
    const { client, calls } = fakeRpc(() => ({ data: [{ hit: false, entry_id: null, distance: null, answer: null, is_refusal: null }], error: null }));
    const { io } = accessIo({ args: { p_access_keys: ['all', `g:${GROUP_A}`], p_access_all: false } });
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG, access: io });
    const q = cacheQuery({ accessGroupSetHash: 'f'.repeat(64) });
    await cache.check(q);
    expect(calls[0]!.args).toMatchObject({ p_key_hash: computeCacheKeyHash(q), p_access_keys: ['all', `g:${GROUP_A}`], p_access_all: false });
  });

  it('with access off the request body is today\'s five arguments', async () => {
    const { client, calls } = fakeRpc(() => ({ data: [], error: null }));
    const cache = createPgvectorSemanticCache({ adminClient: () => client, config: CONFIG, access: accessIo().io });
    await cache.check(cacheQuery());
    expect(Object.keys(calls[0]!.args).sort()).toEqual(['p_embedding', 'p_key_hash', 'p_max_distance', 'p_profile', 'p_tenant_key']);
  });

  it('createSemanticCacheBackend hands the access io to both backends', async () => {
    const { io } = accessIo({ args: { p_access_keys: ['all'], p_access_all: true } });
    const { client, calls } = fakeRpc(() => ({ data: [], error: null }));
    const created = createSemanticCacheBackend(CONFIG, { adminClient: () => client, fetch, sidecarUrl: '', sidecarSecret: '', access: io });
    await created!.backend.check(cacheQuery());
    expect(calls[0]!.args).toMatchObject({ p_access_keys: ['all'], p_access_all: true });
  });
});

describe('redisvl cache re-checks hit sources for the caller (D-23)', () => {
  function sidecar(answer = cachedAnswer({ source_versions: [{ document_id: DOC_1, version: 1 }, { document_id: DOC_2, version: 1 }] })) {
    const paths: string[] = [];
    const impl = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      const body = path.endsWith('/check') ? { hit: true, entry_id: 'entry-1', distance: 0.01, answer } : { deleted: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { fetch: impl, paths };
  }

  function build(io: CacheAccessIo | undefined, fetchImpl: typeof fetch) {
    const rpc = fakeRpc(() => ({ data: true, error: null }));
    return createRedisvlSemanticCache({
      url: 'http://sidecar.invalid',
      secret: 'placeholder-sidecar-secret',
      fetch: fetchImpl,
      adminClient: () => rpc.client,
      config: CONFIG,
      ...(io ? { access: io } : {}),
    });
  }

  it('a hit whose sources are all visible is served; one batched visibility call', async () => {
    const { io, visibilityCalls } = accessIo();
    const s = sidecar();
    const hit = await build(io, s.fetch).check(cacheQuery());
    expect(hit?.entryId).toBe('entry-1');
    expect(visibilityCalls).toEqual([[DOC_1, DOC_2]]);
  });

  it('a hit with a source the caller cannot see is a miss and is not invalidated', async () => {
    const { io } = accessIo({ visible: [DOC_1] });
    const s = sidecar();
    expect(await build(io, s.fetch).check(cacheQuery())).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(s.paths).toEqual(['/v1/cache/check']);
  });

  it('a failed visibility check is a miss', async () => {
    const { io } = accessIo({ visible: 'fail' });
    expect(await build(io, sidecar().fetch).check(cacheQuery())).toBeNull();
  });
});
