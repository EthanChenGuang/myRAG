import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const STRIPE_PINNED_VERSION = '2025-01-27.acacia';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('stripe');
  vi.doUnmock('@/lib/env');
  vi.doUnmock('@/lib/supabase/server');
  vi.doUnmock('@/lib/deployment-mode');
  vi.doUnmock('@/lib/document-processor');
});

describe('config/models GET', () => {
  test('returns the model configuration without touching the Supabase server module', async () => {
    vi.doMock('@/lib/supabase/server', () => ({}));
    const route = await import('@/app/api/config/models/route');
    const res = await route.GET(new NextRequest('http://localhost/api/config/models'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { provider: string; openaiModels: unknown[] };
    expect(typeof body.provider).toBe('string');
    expect(Array.isArray(body.openaiModels)).toBe(true);
  });

  test('POST answers 400 with the validation message for a model missing required fields', async () => {
    vi.doMock('@/lib/supabase/server', () => ({}));
    const route = await import('@/app/api/config/models/route');
    const res = await route.POST(
      new NextRequest('http://localhost/api/config/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          openaiModels: [{ id: 'only-id' }],
          openrouterModels: [],
          groqModels: [],
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('missing required fields');
  });
});

describe('user/preferences PATCH', () => {
  function mockSupabase(user: { user_metadata?: Record<string, unknown> } | null) {
    const updateUser = vi.fn(async () => ({ data: { user }, error: null }));
    vi.doMock('@/lib/deployment-mode', () => ({ requireMultiTenant: () => undefined }));
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({
        auth: {
          getSession: async () => ({ data: { session: { user: { id: 'user-1' } } } }),
          getUser: async () => ({ data: { user }, error: null }),
          updateUser,
        },
      }),
    }));
    return updateUser;
  }

  async function patch(body: unknown) {
    const route = await import('@/app/api/user/preferences/route');
    return route.PATCH(
      new Request('http://localhost/api/user/preferences', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  test('answers 401 JSON when the session has no resolvable user', async () => {
    const updateUser = mockSupabase(null);
    const res = await patch({ theme: 'dark' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(updateUser).not.toHaveBeenCalled();
  });

  test('merges new preferences over the stored ones for an authenticated user', async () => {
    const updateUser = mockSupabase({ user_metadata: { preferences: { theme: 'light', lang: 'en' } } });
    const res = await patch({ theme: 'dark' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: 'dark', lang: 'en' });
    expect(updateUser).toHaveBeenCalledTimes(1);
  });
});

describe('extract-name POST', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-openai-key-placeholder';
    process.env.NEXT_PUBLIC_NAME_EXTRACTION_ENABLED = 'true';
  });

  async function extract(emailPrefix: string, aiAnswer: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: aiAnswer } }] }), { status: 200 })),
    );
    const route = await import('@/app/api/extract-name/route');
    const res = await route.POST(
      new NextRequest('http://localhost/api/extract-name', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emailPrefix }),
      }),
    );
    return (await res.json()) as { displayName: string; type: string };
  }

  test('classifies a multi-word answer as a company', async () => {
    const body = await extract('acmecorp-a', 'Acme Corp');
    expect(body.displayName).toBe('Acme Corp');
    expect(body.type).toBe('company');
  });

  test('classifies a single-word answer as a person', async () => {
    const body = await extract('mariagarcia-b', 'Maria');
    expect(body).toMatchObject({ displayName: 'Maria', type: 'person' });
  });
});

describe('stripe client construction', () => {
  test('keeps the pinned Stripe API version sent at runtime', async () => {
    const ctor = vi.fn();
    vi.doMock('stripe', () => ({
      default: class {
        checkout = { sessions: { create: async () => ({ url: 'https://example.invalid/pay' }) } };
        constructor(...args: unknown[]) {
          ctor(...args);
        }
      },
    }));
    vi.doMock('@/lib/env', () => ({ env: { STRIPE_SECRET_KEY: 'sk_test_placeholder' } }));
    const { getStripeCheckoutUrl } = await import('@/lib/stripe');
    const url = await getStripeCheckoutUrl('price_placeholder', 'https://example.invalid/ok', 'https://example.invalid/no');
    expect(url).toBe('https://example.invalid/pay');
    expect(ctor).toHaveBeenCalledWith('sk_test_placeholder', { apiVersion: STRIPE_PINNED_VERSION });
  });
});

describe('nango document adapter', () => {
  test('forwards the nango source and provider metadata to the document processor', async () => {
    const processDocument = vi.fn(async () => 'doc-1');
    vi.doMock('@/lib/document-processor', () => ({ processDocument }));
    const { processDocumentWithMetadata } = await import('@/lib/nango/document-adapter');
    const id = await processDocumentWithMetadata('a.txt', Buffer.from('x'), {
      userId: 'user-1',
      sourceProvider: 'notion',
      sourceFileId: 'file-1',
      sourceConnectionId: 'conn-1',
    });
    expect(id).toBe('doc-1');
    expect(processDocument).toHaveBeenCalledWith('a.txt', expect.any(Buffer), {
      user_id: 'user-1',
      source: 'nango',
      source_provider: 'notion',
      source_file_id: 'file-1',
      source_connection_id: 'conn-1',
    });
  });
});
