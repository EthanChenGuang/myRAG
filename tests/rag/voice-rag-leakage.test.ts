import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const API_KEY = 'internal-key-placeholder-0123456789';

const state = vi.hoisted(() => ({ throwDuringRetrieval: false }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: new Proxy(actual.env, { get: (target, key) => (key === 'MYRAG_INTERNAL_API_KEY' ? 'internal-key-placeholder-0123456789' : Reflect.get(target, key)) }) };
});

vi.mock('@/lib/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag')>();
  return {
    ...actual,
    resolveVoiceScope: async () => ({ ok: true, scope: { kind: 'single', userId: null, organizationId: null } }),
    runRetrieval: async () => {
      if (state.throwDuringRetrieval) throw new Error('relation "document_chunks" secret-detail does not exist');
      return {
        status: 'ok',
        voice: { results: [{ chunk_id: 'c1', document_id: 'd1', content: 'text', similarity: 0.9 }], source_images: [] },
      };
    },
  };
});

const { POST } = await import('@/app/api/internal/voice-rag/route');

function request(query: string): NextRequest {
  return new NextRequest('http://localhost/api/internal/voice-rag', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ query }),
  });
}

beforeEach(() => {
  state.throwDuringRetrieval = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('voice-rag response hygiene', () => {
  test('a query containing the word debug does not switch on debug_info', async () => {
    const response = await POST(request('please debug the pricing'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toHaveLength(1);
    expect(body.debug_info).toBeUndefined();
  });

  test('an unexpected failure returns a generic 500 and logs the detail server-side', async () => {
    state.throwDuringRetrieval = true;
    const response = await POST(request('what is the price'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'Internal Server Error' });
    expect(JSON.stringify(body)).not.toContain('secret-detail');
    expect(console.error).toHaveBeenCalledWith('[Internal RAG] Error:', expect.stringContaining('secret-detail'));
  });
});
