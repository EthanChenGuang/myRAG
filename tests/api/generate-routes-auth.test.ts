import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env.FAL_API_KEY = 'test-fal-key-placeholder';
  delete process.env.USE_OPENAI_IMAGE;
  delete process.env.USE_REPLICATE_PROVIDER;
  delete process.env.REPLICATE_API_TOKEN;
  return {
    user: null as { id: string } | null,
    authThrows: false,
    providerCalls: 0,
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        if (state.authThrows) throw new Error('auth down');
        return { data: { user: state.user } };
      },
    },
  }),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      listBuckets: async () => ({ data: [], error: null }),
      createBucket: async () => ({ data: {}, error: null }),
      from: () => ({
        list: async () => ({ data: [], error: null }),
        upload: async () => ({ data: {}, error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'http://storage.invalid/object' } }),
      }),
    },
  }),
}));

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: () => undefined,
    subscribe: async () => {
      state.providerCalls += 1;
      return { data: { images: [] } };
    },
    queue: {
      submit: async () => {
        state.providerCalls += 1;
        throw new Error('provider stopped by test');
      },
    },
  },
}));

vi.mock('openai', () => ({ default: class FakeOpenAI {} }));
vi.mock('replicate', () => ({ default: class FakeReplicate {} }));

const imageRoute = await import('@/app/api/generate-image/route');
const videoRoute = await import('@/app/api/generate-video/route');
const threeDRoute = await import('@/app/api/generate-3d/route');

const ROUTES = [
  { name: 'generate-image', post: imageRoute.POST, body: { prompt: '' } },
  { name: 'generate-video', post: videoRoute.POST, body: { prompt: '' } },
  { name: 'generate-3d', post: threeDRoute.POST, body: { prompt: 'a chair', imageData: '' } },
];

function post(name: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.user = null;
  state.authThrows = false;
  state.providerCalls = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(ROUTES)('$name requires a verified session', ({ name, post: handler, body }) => {
  it('answers 401 without a session and calls no provider', async () => {
    const response = await handler(post(name, { ...body, prompt: 'a poster', imageData: 'data:image/png;base64,AAAA' }) as never);
    expect(response.status).toBe(401);
    expect(state.providerCalls).toBe(0);
  });

  it('answers 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const response = await handler(post(name, { ...body, prompt: 'a poster' }) as never);
    expect(response.status).toBe(503);
    expect(state.providerCalls).toBe(0);
  });

  it('lets a signed-in user reach request validation', async () => {
    state.user = { id: '00000000-0000-4000-8000-0000000000a1' };
    const response = await handler(post(name, body) as never);
    expect([401, 503]).not.toContain(response.status);
  });
});
