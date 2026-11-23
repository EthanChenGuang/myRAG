import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as rag from '@/lib/rag';
import { isTenantScope } from '@/lib/rag';
import { fakeEmbedder, installDeps, uninstallDeps } from './helpers/pipeline-fakes';

vi.hoisted(() => {
  process.env.FAL_API_KEY = 'test-fal-key-placeholder';
  delete process.env.USE_OPENAI_IMAGE;
  delete process.env.USE_REPLICATE_PROVIDER;
  delete process.env.REPLICATE_API_TOKEN;
});

vi.mock('@/lib/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag')>();
  return { ...actual, runRetrieval: vi.fn(actual.runRetrieval) };
});

vi.mock('@supabase/supabase-js', () => {
  const storage = {
    listBuckets: async () => ({ data: [{ name: 'chat-videos' }], error: null }),
    createBucket: async () => ({ data: {}, error: null }),
    from: () => ({
      list: async () => ({ data: [], error: null }),
      upload: async () => ({ data: {}, error: null }),
      getPublicUrl: () => ({ data: { publicUrl: 'http://storage.invalid/object' } }),
    }),
  };
  return { createClient: () => ({ storage }) };
});

vi.mock('@fal-ai/client', () => ({
  fal: {
    config: () => undefined,
    subscribe: async () => ({ data: { images: [] } }),
    queue: {
      submit: async () => {
        throw new Error('provider stopped by test');
      },
    },
  },
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: async () => ({ choices: [{ message: { content: 'rewritten prompt' } }] }) } };
  },
}));

const imageRoute = await import('@/app/api/generate-image/route');
const videoRoute = await import('@/app/api/generate-video/route');

function post(url: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const emptyAdmin = {
  rpc() {
    const request = {
      abortSignal: () => request,
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected),
    };
    return request;
  },
};

beforeEach(() => {
  uninstallDeps();
  installDeps({ adminClient: () => emptyAdmin as never, embedder: fakeEmbedder().embedder });
  vi.mocked(rag.runRetrieval).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uninstallDeps();
});

describe('media entry points call the pipeline', () => {
  test('generate-image calls runRetrieval with the media profile, the image kind and a minted scope', async () => {
    await imageRoute.POST(post('/api/generate-image', { prompt: 'a poster', useContext: true }));
    expect(rag.runRetrieval).toHaveBeenCalledTimes(1);
    const input = vi.mocked(rag.runRetrieval).mock.calls[0][0];
    expect(input).toMatchObject({ profile: 'media', query: 'a poster', options: { mediaKind: 'image' } });
    expect(isTenantScope(input.scope)).toBe(true);
  });

  test('generate-video calls runRetrieval with the media profile, the video kind and a minted scope', async () => {
    await videoRoute.POST(post('/api/generate-video', { prompt: 'a clip', useContext: true }));
    expect(rag.runRetrieval).toHaveBeenCalledTimes(1);
    const input = vi.mocked(rag.runRetrieval).mock.calls[0][0];
    expect(input).toMatchObject({ profile: 'media', query: 'a clip', options: { mediaKind: 'video' } });
    expect(isTenantScope(input.scope)).toBe(true);
  });

  test('neither media route calls the pipeline when context is not requested', async () => {
    await imageRoute.POST(post('/api/generate-image', { prompt: 'a poster' }));
    await videoRoute.POST(post('/api/generate-video', { prompt: 'a clip' }));
    expect(rag.runRetrieval).not.toHaveBeenCalled();
  });
});
