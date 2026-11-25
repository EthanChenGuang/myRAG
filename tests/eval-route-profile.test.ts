import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline, retrievalWith } from './helpers/chat-route-fakes';

const SECRET = 'a'.repeat(48);
const ENV_NAMES = ['RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED', 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE', 'RAG_EMBEDDING_PROFILES'] as const;
const env = process.env as Record<string, string | undefined>;

const h = await vi.hoisted(async () => {
  const fakes = await import('./helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), runSpy: vi.fn() };
});

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));

function chunkRow(id: string, similarity: number) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content: `Refund policy chunk ${id}`,
    similarity,
    metadata: null,
    temporal_score: 0,
    financial_score: 0,
    final_score: similarity,
    match_reason: 'similarity',
  };
}

function stubEvalRetrieval() {
  return {
    status: 'ok' as const,
    reason: 'ok',
    candidates: [],
    context: '',
    usedDocuments: [],
    sourceImages: [],
    links: [],
    relevantChunks: [],
    kept: [],
    queryTerms: [],
    refusalCandidate: false,
    stages: [
      { name: 'search' as const, status: 'ok' as const, startedAt: 0, endedAt: 1, candidatesIn: 0, candidatesOut: 0, detail: 'fake' },
      { name: 'assemble' as const, status: 'ok' as const, startedAt: 1, endedAt: 2, candidatesIn: 0, candidatesOut: 0 },
    ],
    traceId: 'trace-stub',
    queryContext: {
      isTemporalQuery: false,
      isFinancialQuery: false,
      isSpecificDataQuery: false,
      requiredPrecision: 'low' as const,
      suggestedThreshold: 0.3,
      reasoningText: 'stub',
      financialMetrics: [],
      searchStrategy: 'semantic_only' as const,
    },
  };
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
        h.runSpy(input);
        return Promise.resolve(stubEvalRetrieval());
      },
    };
  });
  await installChatPipeline(h);
  return import('@/app/api/internal/rag/run/route');
}

function evalRequest(options: Record<string, unknown> | undefined, headers: Record<string, string> = { 'x-rag-eval-secret': SECRET }) {
  return new NextRequest('http://localhost/api/internal/rag/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      schema_version: 1,
      query: 'What is the refund policy?',
      rag_mode: 'flexible',
      ...(options ? { options } : {}),
    }),
  });
}

describe('eval route embedding_profile option', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.RAG_EVAL_ENDPOINT_ENABLED = 'true';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.RAG_EMBEDDING_PROFILES = 'on';
    h.runSpy.mockReset();
    h.supabase.store.reset();
    h.supabase.store.documents = [{ id: 'doc-1', filename: 'refund-policy-1.md', created_at: '2026-01-01T00:00:00.000Z', content: 'refund policy', metadata: {} }];
    h.supabase.store.document_chunks = [{ id: 'chunk-1', document_id: 'doc-1', metadata: null }];
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([chunkRow('1', 0.9)]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.resetModules();
  });

  it('passes embeddingProfile into runRetrieval for authenticated eval requests', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ embedding_profile: 'voyage-4-large-2048' }));

    expect(response.status).toBe(200);
    expect(h.runSpy).toHaveBeenCalledTimes(1);
    expect(h.runSpy.mock.calls[0][0].profile).toBe('eval');
    expect(h.runSpy.mock.calls[0][0].options?.embeddingProfile).toBe('voyage-4-large-2048');
  });

  it('refuses embedding_profile without the eval secret', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ embedding_profile: 'voyage-4-large-2048' }, {}));

    expect([401, 403, 404]).toContain(response.status);
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it('the public chat route never reads embedding_profile', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/app/api/chat/route.ts'), 'utf8');
    expect(source).not.toMatch(/embedding_profile|embeddingProfile/);
  });
});