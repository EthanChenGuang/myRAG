import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline, retrievalWith } from '../helpers/chat-route-fakes';

const SECRET = 'a'.repeat(48);
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'RAG_PIPELINE',
  'RAG_DOC_ATTRIBUTES',
  'RAG_ATTRIBUTE_FILTER',
] as const;
const env = process.env as Record<string, string | undefined>;

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), runSpy: vi.fn(), checkSpy: vi.fn() };
});

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  getSupabaseAdmin: () => h.supabase.client,
}));

let saved: Record<string, string | undefined>;

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

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/rag', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/rag')>();
    return {
      ...actual,
      runRetrieval: (input: Parameters<typeof actual.runRetrieval>[0]) => {
        h.runSpy(input);
        return actual.runRetrieval(input);
      },
      checkExplicitAttributeFilter: async (_scope: unknown, explicit: Record<string, string[]> | undefined) => {
        h.checkSpy(explicit);
        const { AttributeFilterError } = await import('@/lib/rag/retrieval/attributes');
        if (explicit && 'zz_unknown_key' in explicit) {
          throw new AttributeFilterError('unknown_attribute', 400, 'an attribute key is not a filterable attribute', [
            { path: 'attributes.zz_unknown_key', message: 'unknown_attribute' },
          ]);
        }
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
      query: 'What does the neutral probe say?',
      rag_mode: 'flexible',
      ...(options ? { options } : {}),
    }),
  });
}

/**
 * 03.3 verification G4: the eval route answers an explicit attributes filter with an unknown key with a structured 400 before any
 * retrieval, like the scopes filter; with RAG_ATTRIBUTE_FILTER off the attributes key keeps today's unrecognized-key 400.
 */
describe('eval route explicit attributes filter', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    h.runSpy.mockReset();
    h.checkSpy.mockReset();
    h.supabase.store.reset();
    h.supabase.store.documents = [{ id: 'doc-1', filename: 'probe-1.md', created_at: '2026-01-01T00:00:00.000Z', content: 'neutral probe', metadata: {} }];
    h.supabase.store.document_chunks = [{ id: 'chunk-1', document_id: 'doc-1', metadata: null }];
    h.retrieval.mockReset();
    h.retrieval.mockResolvedValue(retrievalWith([chunkRow('1', 0.9)]));
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

  it('answers 400 unknown_attribute with the key path and runs no retrieval', async () => {
    env.RAG_PIPELINE = 'v2';
    env.RAG_DOC_ATTRIBUTES = 'true';
    env.RAG_ATTRIBUTE_FILTER = 'hard';
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ retrieval_filters: { attributes: { zz_unknown_key: ['q1'] } } }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: 'unknown_attribute',
      details: [{ path: 'attributes.zz_unknown_key', message: 'unknown_attribute' }],
    });
    expect(h.checkSpy).toHaveBeenCalledWith({ zz_unknown_key: ['q1'] });
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it('with RAG_ATTRIBUTE_FILTER off an attributes key keeps the unrecognized-key 400 and the check is not called', async () => {
    env.RAG_PIPELINE = 'v2';
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ retrieval_filters: { attributes: { zz_unknown_key: ['q1'] } } }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: 'Invalid request data' });
    expect(h.checkSpy).not.toHaveBeenCalled();
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it('a request without an attributes filter never calls the check', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ max_results: 5 }));

    expect(response.status).toBe(200);
    expect(h.checkSpy).not.toHaveBeenCalled();
  });
});
