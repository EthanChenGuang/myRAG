import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline, retrievalWith } from '../helpers/chat-route-fakes';

const SECRET = 'b'.repeat(48);
const ENV_NAMES = [
  'RAG_EVAL_SECRET',
  'RAG_EVAL_ENDPOINT_ENABLED',
  'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE',
  'RAG_DOMAIN_EMBEDDINGS',
  'RAG_EMBEDDING_PROFILES',
] as const;
const env = process.env as Record<string, string | undefined>;

const h = await vi.hoisted(async () => {
  const fakes = await import('../helpers/chat-route-fakes');
  return { ...fakes.createChatRouteHarness(), runSpy: vi.fn() };
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
    content: `Neutral sample chunk ${id}`,
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
      query: 'What does the sample document say?',
      rag_mode: 'flexible',
      ...(options ? { options } : {}),
    }),
  });
}

describe('eval route binding overrides (D-22)', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    delete env.RAG_DOMAIN_EMBEDDINGS;
    delete env.RAG_EMBEDDING_PROFILES;
    h.runSpy.mockReset();
    h.supabase.store.reset();
    h.supabase.store.documents = [{ id: 'doc-1', filename: 'sample-1.md', created_at: '2026-01-01T00:00:00.000Z', content: 'sample', metadata: {} }];
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
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('maps embedding_bindings and domain_control_leg to the retrieval options', async () => {
    const route = await loadRoute();
    const response = await route.POST(
      evalRequest({ embedding_bindings: { contract_legal: 'voyage-law-2-1024' }, domain_control_leg: 'contract_legal' }),
    );

    expect(response.status).not.toBe(400);
    expect(h.runSpy).toHaveBeenCalledTimes(1);
    const input = h.runSpy.mock.calls[0][0];
    expect(input.profile).toBe('eval');
    expect(input.options.embeddingBindings).toEqual({ contract_legal: 'voyage-law-2-1024' });
    expect(input.options.domainControlLeg).toBe('contract_legal');
  });

  it('passes neither field when the request names none, and the response is unchanged', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ max_results: 5 }));

    expect(response.status).toBe(200);
    const input = h.runSpy.mock.calls[0][0];
    expect('embeddingBindings' in input.options).toBe(false);
    expect('domainControlLeg' in input.options).toBe(false);
  });

  it('an empty binding map passes no override', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ embedding_bindings: {} }));

    expect(response.status).toBe(200);
    expect('embeddingBindings' in h.runSpy.mock.calls[0][0].options).toBe(false);
  });

  it('with the domain switch off a binding override is a structured error, never a run on the global profile', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ embedding_bindings: { contract_legal: 'voyage-law-2-1024' } }));
    const body = (await response.json()) as { error: string; reason: string };

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: 'retrieval failed', reason: 'domain_embeddings_disabled' });
    expect(h.retrieval).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown doc type', { embedding_bindings: { memo: 'x' } }],
    [
      'a seven-entry map',
      {
        embedding_bindings: {
          general: 'p1',
          financial_report: 'p2',
          contract_legal: 'p3',
          invoice_receipt: 'p4',
          product_technical: 'p5',
          scanned_image: 'p6',
          memo: 'p7',
        },
      },
    ],
    ['a profile id outside the pattern', { embedding_bindings: { contract_legal: 'Not A Profile' } }],
    ['an empty profile id', { embedding_bindings: { contract_legal: '' } }],
    ['an unknown control leg', { domain_control_leg: 'memo' }],
  ])('rejects %s with 400 and details before any retrieval', async (_label, options) => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest(options));
    const body = (await response.json()) as { success: boolean; details?: unknown[] };

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(Array.isArray(body.details) && body.details.length > 0).toBe(true);
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ 'x-rag-eval-secret': 'c'.repeat(48) }]])('refuses binding overrides without the right secret', async (headers) => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ embedding_bindings: { contract_legal: 'voyage-law-2-1024' } }, headers));

    expect(response.status).toBe(401);
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it.each(['chat', 'embed/chat'])('the public %s route never reads binding overrides', (routePath) => {
    const source = fs.readFileSync(path.resolve(__dirname, `../../src/app/api/${routePath}/route.ts`), 'utf8');
    expect(source).not.toMatch(/embedding_bindings|embeddingBindings|domain_control_leg|domainControlLeg/);
  });
});
