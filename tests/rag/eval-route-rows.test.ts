import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline, retrievalWith } from '../helpers/chat-route-fakes';

const SECRET = 'a'.repeat(48);
const ENV_NAMES = ['RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED', 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE'] as const;
const env = process.env as Record<string, string | undefined>;

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return fakes.createChatRouteHarness();
});

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));

let saved: Record<string, string | undefined>;

function row(id: string, similarity: number, metadata: Record<string, unknown> | null = null) {
  return {
    chunk_id: `chunk-${id}`,
    document_id: `doc-${id}`,
    content: `Refund policy chunk ${id}`,
    similarity,
    metadata,
    temporal_score: 0,
    financial_score: 0,
    final_score: similarity,
    match_reason: 'similarity',
  };
}

describe('eval route assembly rows', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    h.supabase.store.reset();
    h.supabase.store.documents = ['1', '2'].map((id) => ({
      id: `doc-${id}`,
      filename: `refund-policy-${id}.md`,
      created_at: '2026-01-01T00:00:00.000Z',
      content: 'refund policy',
      metadata: {},
    }));
    h.supabase.store.document_chunks = [
      { id: 'chunk-1', document_id: 'doc-1', metadata: null },
      { id: 'chunk-2', document_id: 'doc-2', metadata: { image_url: 'https://example.com/a.png' } },
    ];
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([row('1', 0.9), row('2', 0.8, { image_url: 'https://example.com/a.png' })]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.resetModules();
  });

  it('reads documents and chunk metadata once per request and still names the kept candidates', async () => {
    vi.resetModules();
    await installChatPipeline(h);
    const route = await import('@/app/api/internal/rag/run/route');
    const response = await route.POST(
      new NextRequest('http://localhost/api/internal/rag/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rag-eval-secret': SECRET },
        body: JSON.stringify({ schema_version: 1, query: 'What is the refund policy?', rag_mode: 'flexible' }),
      }),
    );
    const trace = (await response.json()) as {
      candidates: Array<{ chunk_id: string; document_name: string | null; has_image: boolean }>;
      kept: Array<{ chunk_id: string }>;
    };

    expect(response.status).toBe(200);
    const tables = (h.supabase.store.calls as Array<{ table?: string; method?: string }>)
      .filter((call) => call.method === 'select')
      .map((call) => call.table);
    expect(tables.filter((table) => table === 'documents')).toHaveLength(1);
    expect(tables.filter((table) => table === 'document_chunks')).toHaveLength(1);
    expect(trace.kept.length).toBeGreaterThan(0);
    const first = trace.candidates.find((candidate) => candidate.chunk_id === 'chunk-1');
    expect(first?.document_name).toBe('refund-policy-1.md');
    expect(trace.candidates.find((candidate) => candidate.chunk_id === 'chunk-2')?.has_image).toBe(true);
  });
});
