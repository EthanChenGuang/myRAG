import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetrievalResult, RunRetrievalInput } from '@/lib/rag/types';

const h = vi.hoisted(() => ({
  fakeRetrieval: null as null | ((input: RunRetrievalInput) => Promise<RetrievalResult>),
  retrievalCalls: [] as RunRetrievalInput[],
  tasks: [] as Array<() => Promise<void>>,
  writes: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/rag/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/pipeline')>();
  return {
    ...actual,
    runRetrieval: async (input: RunRetrievalInput) => {
      h.retrievalCalls.push(input);
      return h.fakeRetrieval ? h.fakeRetrieval(input) : actual.runRetrieval(input);
    },
  };
});

vi.mock('@/lib/rag/trace/schedule', () => ({
  scheduleAfterResponse: (task: () => Promise<void>) => {
    h.tasks.push(task);
  },
}));

vi.mock('@/lib/rag/feedback-loop/retrieval-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag/feedback-loop/retrieval-log')>();
  return {
    ...actual,
    writeRetrievalLog: async (row: Record<string, unknown>) => {
      h.writes.push(row);
    },
  };
});

import { runRetrieval } from '@/lib/rag/pipeline';
import { searchForReviewItem } from '@/lib/rag/feedback-loop/review-search';
import { mintScope, scopeKey } from '@/lib/rag/tenant/scope';
import { pgliteClient } from '../helpers/pglite-rest-client';
import {
  CHUNK_A,
  CHUNK_B,
  DOC_A,
  DOC_A_MANY,
  DOC_B,
  EXPERT_A,
  MANY_A_CHUNKS,
  TENANT_A,
  TEXT_A,
  TEXT_B,
  createReviewFixture,
  insertReviewItem,
} from '../helpers/review-fixture';
import { SEMANTIC_QUERY, fakeEmbedder, fakeRpcClient, installDeps, rows, uninstallDeps } from '../rag/helpers/pipeline-fakes';

const QUERY = 'synthetic expert search phrase';

let db: PGlite;
let itemA: string;
let itemB: string;
const calls: string[] = [];
const session: { userId: string | null } = { userId: null };

function fakeResult(chunks: Array<[string, string]>): RetrievalResult {
  return {
    status: 'ok',
    reason: 'ok',
    candidates: chunks.map(([chunkId, documentId], index) => ({
      chunk_id: chunkId,
      document_id: documentId,
      content: 'ignored',
      similarity: 0.9 - index * 0.01,
      metadata: null,
      temporal_score: 0,
      financial_score: 0,
      final_score: 0.9 - index * 0.01,
      match_reason: 'fake',
    })),
  } as unknown as RetrievalResult;
}

async function loadRoutes() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => pgliteClient(db, { role: 'authenticated', userId: session.userId, label: 'ssr', calls }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => pgliteClient(db, { role: 'service_role', label: 'admin', calls }),
    getSupabase: () => ({}),
  }));
  return {
    label: await import('@/app/api/rag/review/items/[id]/label/route'),
    search: await import('@/app/api/rag/review/items/[id]/search/route'),
  };
}

const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function labelBody(evidence: Record<string, unknown>) {
  return {
    status: 'labelled',
    label: { answerable: true, category: 'general', language: 'en', expected_answer: 'An answer.', evidence: [evidence], triage: ['training'] },
  };
}

async function drain(): Promise<void> {
  while (h.tasks.length > 0) await h.tasks.shift()!();
}

beforeEach(() => {
  h.fakeRetrieval = null;
  h.retrievalCalls.length = 0;
  h.tasks.length = 0;
  h.writes.length = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('label and search routes with two tenants (multi-tenant)', () => {
  beforeAll(async () => {
    ({ db, itemA, itemB } = await createReviewFixture());
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  beforeEach(() => {
    calls.length = 0;
    session.userId = EXPERT_A;
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
    vi.stubEnv('NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
    vi.stubEnv('MYRAG_DEPLOYMENT_MODE', 'multi-tenant');
  });

  it("answers 404 when the expert of A labels B's item, and B's row stays open", async () => {
    const { label } = await loadRoutes();
    const res = await label.POST(post(`/api/rag/review/items/${itemB}/label`, { status: 'skipped' }), params(itemB));
    expect(res.status).toBe(404);
    const { rows: stored } = await db.query<{ status: string }>('SELECT status FROM rag_review_items WHERE id = $1', [itemB]);
    expect(stored[0].status).toBe('open');
  });

  it('answers 400 chunk_not_in_tenant for an A label citing a B chunk, without B text', async () => {
    const { label } = await loadRoutes();
    const evidence = { chunk_id: CHUNK_B, document_id: DOC_B, document_name: 'bravo-private.md', section: '', quote: 'private sentence' };
    const res = await label.POST(post(`/api/rag/review/items/${itemA}/label`, labelBody(evidence)), params(itemA));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'invalid_evidence', span: 0, reason: 'chunk_not_in_tenant' });
    expect(text).not.toContain(TEXT_B);
  });

  it("searches only A's tenant: the scope comes from the item, logging is suppressed, and B hits are dropped", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    h.fakeRetrieval = async () =>
      fakeResult([[CHUNK_B, DOC_B], [CHUNK_A, DOC_A], ...MANY_A_CHUNKS.map((id): [string, string] => [id, DOC_A_MANY])]);
    const { search } = await loadRoutes();
    const res = await search.POST(post(`/api/rag/review/items/${itemA}/search`, { query: QUERY }), params(itemA));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item_id).toBe(itemA);
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits.length).toBeLessThanOrEqual(30);
    expect(body.hits[0]).toEqual({
      rank: 2,
      chunk_id: CHUNK_A,
      document_id: DOC_A,
      document_name: 'alpha-guide.md',
      section: 'Part one > Detail',
      text: TEXT_A,
      score: expect.any(Number),
    });
    for (const hit of body.hits) expect([DOC_A, DOC_A_MANY]).toContain(hit.document_id);
    expect(JSON.stringify(body)).not.toContain(TEXT_B);
    expect(JSON.stringify(body)).not.toContain('bravo-private.md');

    expect(h.retrievalCalls).toHaveLength(1);
    const input = h.retrievalCalls[0]!;
    expect(input.scope && scopeKey(input.scope)).toBe(TENANT_A);
    expect(input).toMatchObject({ query: QUERY, profile: 'chat', options: { ragMode: 'flexible', maxResults: 30 }, logContext: { skip: true } });
    expect(input.trace).toBeDefined();

    const everything = JSON.stringify([log.mock.calls, (console.warn as unknown as { mock: { calls: unknown[] } }).mock.calls]);
    expect(everything).not.toContain(QUERY);
    const lines = log.mock.calls.filter((args) => args[0] === '[Review] search');
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({ expert: EXPERT_A, item: expect.stringMatching(/^[0-9a-f]{16}$/), count: body.hits.length });
  });

  it('lets a label cite a chunk found by the review search outside the snapshot', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { label } = await loadRoutes();
    const evidence = { chunk_id: MANY_A_CHUNKS[3], document_id: DOC_A_MANY, document_name: 'x', section: '', quote: 'filler sentence number 3' };
    const res = await label.POST(post(`/api/rag/review/items/${itemA}/label`, labelBody(evidence)), params(itemA));
    expect(res.status).toBe(200);
  });

  it('answers 404 for a B item search without running retrieval, and 400 for a tenant key or a bad query in the body', async () => {
    h.fakeRetrieval = async () => fakeResult([[CHUNK_B, DOC_B]]);
    const { search } = await loadRoutes();
    expect((await search.POST(post(`/api/rag/review/items/${itemB}/search`, { query: QUERY }), params(itemB))).status).toBe(404);
    for (const body of [{ query: QUERY, tenantKey: 'u:00000000-0000-4000-8000-0000000071b0' }, { query: '' }, { query: 'x'.repeat(501) }, {}]) {
      expect((await search.POST(post(`/api/rag/review/items/${itemA}/search`, body), params(itemA))).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(h.retrievalCalls).toHaveLength(0);
  });

  it('answers 503 when the item tenant cannot be scoped, without running retrieval', async () => {
    const ghostTenant = `u:${crypto.randomUUID()}`;
    await db.query('INSERT INTO rag_domain_experts (tenant_key, user_id) VALUES ($1, $2)', [ghostTenant, EXPERT_A]);
    const ghostItem = await insertReviewItem(db, ghostTenant, []);
    h.fakeRetrieval = async () => fakeResult([]);
    const { search } = await loadRoutes();
    const res = await search.POST(post(`/api/rag/review/items/${ghostItem}/search`, { query: QUERY }), params(ghostItem));
    expect(res.status).toBe(503);
    expect(h.retrievalCalls).toHaveLength(0);
  });

  it('answers 404 with the switch off and 401 without a session', async () => {
    const { search } = await loadRoutes();
    session.userId = null;
    expect((await search.POST(post(`/api/rag/review/items/${itemA}/search`, { query: QUERY }), params(itemA))).status).toBe(401);
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'false');
    session.userId = EXPERT_A;
    calls.length = 0;
    expect((await search.POST(post(`/api/rag/review/items/${itemA}/search`, { query: QUERY }), params(itemA))).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('review search writes no retrieval log row even with the log on', () => {
  const savedMode = process.env.RAG_RETRIEVAL_LOG;
  const item = { id: crypto.randomUUID(), tenant_key: 's:default', status: 'open', candidates: [] };
  const fakeSsr = {
    from: () => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: item, error: null }) };
      return chain;
    },
  };
  const fakeAdmin = {
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const key of ['select', 'in', 'eq']) chain[key] = () => chain;
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
      return chain;
    },
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.RAG_RETRIEVAL_LOG = 'masked_query';
    installDeps({ embedder: fakeEmbedder().embedder, searchRpc: fakeRpcClient({ rows: rows(3) }).client });
  });

  afterEach(() => {
    uninstallDeps();
    if (savedMode === undefined) delete process.env.RAG_RETRIEVAL_LOG;
    else process.env.RAG_RETRIEVAL_LOG = savedMode;
  });

  it('writes a row for a logged chat retrieval (control) and none for the review search', async () => {
    await runRetrieval({
      scope: mintScope('single', null, null),
      query: SEMANTIC_QUERY,
      profile: 'chat',
      signal: new AbortController().signal,
      logContext: { channel: 'chat', userId: EXPERT_A },
    });
    await drain();
    expect(h.writes).toHaveLength(1);

    h.writes.length = 0;
    h.retrievalCalls.length = 0;
    const result = await searchForReviewItem(fakeSsr as never, fakeAdmin as never, item.id, SEMANTIC_QUERY, EXPERT_A);
    expect(result.ok).toBe(true);
    expect(h.retrievalCalls).toHaveLength(1);
    await drain();
    expect(h.writes).toHaveLength(0);
  });
});
