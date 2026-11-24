import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { installChatPipeline, retrievalWith } from '../helpers/chat-route-fakes';

const SECRET = 'a'.repeat(48);
const ENV_NAMES = ['RAG_EVAL_SECRET', 'RAG_EVAL_ENDPOINT_ENABLED', 'NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE'] as const;
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

describe('eval route per-request stage overrides', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_NAMES.map((name) => [name, env[name]]));
    env.RAG_EVAL_SECRET = SECRET;
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    h.runSpy.mockReset();
    h.supabase.store.reset();
    h.supabase.store.documents = [{ id: 'doc-1', filename: 'refund-policy-1.md', created_at: '2026-01-01T00:00:00.000Z', content: 'refund policy', metadata: {} }];
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

  it('passes disabled stages and timeouts to the pipeline and the stage shows as disabled in the trace', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ disabled_stages: ['assemble'], stage_timeouts_ms: { search: 4000 } }));
    const trace = (await response.json()) as { stage_status: Record<string, string> };

    expect(response.status).toBe(200);
    expect(h.runSpy).toHaveBeenCalledTimes(1);
    expect(h.runSpy.mock.calls[0][0].profile).toBe('eval');
    expect(h.runSpy.mock.calls[0][0].stageOverrides).toEqual({ disabledStages: ['assemble'], timeouts: { search: 4000 } });
    expect(trace.stage_status.assemble).toBe('disabled');
  });

  it('passes no overrides when the options name none', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ max_results: 5 }));

    expect(response.status).toBe(200);
    expect(h.runSpy.mock.calls[0][0].stageOverrides).toBeUndefined();
  });

  it.each([
    ['an unknown stage name', { disabled_stages: ['rerank'] }],
    ['an unknown timeout stage', { stage_timeouts_ms: { rerank: 100 } }],
    ['a timeout of zero', { stage_timeouts_ms: { search: 0 } }],
    ['a timeout above the cap', { stage_timeouts_ms: { search: 60001 } }],
    ['a non-integer timeout', { stage_timeouts_ms: { search: 10.5 } }],
  ])('rejects %s with 400 before any retrieval', async (_label, options) => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest(options));

    expect(response.status).toBe(400);
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it('refuses overrides without the eval secret and runs no retrieval', async () => {
    const route = await loadRoute();
    const response = await route.POST(evalRequest({ disabled_stages: ['assemble'] }, {}));

    expect([401, 403, 404]).toContain(response.status);
    expect(h.runSpy).not.toHaveBeenCalled();
  });

  it.each(['chat', 'embed/chat'])('the public %s route never reads stage overrides', (routePath) => {
    const source = fs.readFileSync(path.resolve(__dirname, `../../src/app/api/${routePath}/route.ts`), 'utf8');
    expect(source).not.toMatch(/stageOverrides|disabled_stages|stage_timeouts/);
  });
});
