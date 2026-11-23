import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  asAdmin,
  asPlainUser,
  mockAdminGuard,
  newGuardState,
  silenceConsole,
  type AdminGuardState,
} from '../helpers/admin-guard-fixture';

const state = vi.hoisted(() => {
  process.env.OPENAI_API_KEY = 'test-openai-key-placeholder';
  process.env.NEXT_PUBLIC_WEB_SEARCH_ENABLED = 'true';
  return { providerCalls: 0, fetchCalls: 0 };
});

let guard: AdminGuardState;

async function loadWithSession<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  mockAdminGuard(guard);
  vi.doMock('openai', () => ({
    default: class FakeOpenAI {
      audio = {
        speech: { create: async () => { state.providerCalls += 1; return { body: null }; } },
        transcriptions: { create: async () => { state.providerCalls += 1; return { text: 'placeholder' }; } },
      };
      chat = { completions: { create: async () => { state.providerCalls += 1; throw new Error('provider stopped by test'); } } };
    },
  }));
  vi.doMock('@/lib/title-generator', () => ({
    generateSmartTitle: async () => { state.providerCalls += 1; return 'placeholder title'; },
  }));
  vi.doMock('@/lib/openrouter', () => ({
    openRouter: () => { state.providerCalls += 1; throw new Error('provider stopped by test'); },
    getOpenRouterClient: () => { state.providerCalls += 1; throw new Error('provider stopped by test'); },
  }));
  return (await import(modulePath)) as T;
}

function json(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function audioForm(action: string) {
  const form = new FormData();
  form.set('action', action);
  form.set('text', 'placeholder text');
  form.set('file', new File([new Uint8Array([1, 2, 3])], 'clip.webm', { type: 'audio/webm' }));
  return new NextRequest('http://localhost/api/audio', { method: 'POST', body: form });
}

type Handler = (request: NextRequest) => Promise<Response>;

const SESSION_ROUTES: Array<{ name: string; module: string; call: (m: Record<string, Handler>) => Promise<Response> }> = [
  { name: 'audio POST speech', module: '@/app/api/audio/route', call: (m) => m.POST!(audioForm('speech')) },
  { name: 'audio POST transcribe', module: '@/app/api/audio/route', call: (m) => m.POST!(audioForm('transcribe')) },
  {
    name: 'audio GET speech',
    module: '@/app/api/audio/route',
    call: (m) => m.GET!(new NextRequest('http://localhost/api/audio?action=speech&text=placeholder')),
  },
  { name: 'title', module: '@/app/api/title/route', call: (m) => m.POST!(json('/api/title', { messages: [{ role: 'user', content: 'hello there' }] })) },
  { name: 'extract-name', module: '@/app/api/extract-name/route', call: (m) => m.POST!(json('/api/extract-name', { emailPrefix: 'jane.doe' })) },
  { name: 'web-search', module: '@/app/api/web-search/route', call: (m) => m.POST!(json('/api/web-search', { query: 'placeholder query' })) },
];

beforeEach(() => {
  guard = newGuardState();
  state.providerCalls = 0;
  state.fetchCalls = 0;
  silenceConsole();
  vi.stubGlobal('fetch', async () => {
    state.fetchCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(SESSION_ROUTES)('$name requires a verified session (ME-04)', ({ module, call }) => {
  it('answers 401 without a session and spends no provider call', async () => {
    const routeModule = await loadWithSession<Record<string, Handler>>(module);
    const response = await call(routeModule);
    expect(response.status).toBe(401);
    expect(state.providerCalls).toBe(0);
    expect(state.fetchCalls).toBe(0);
  });

  it('answers 503 when the session lookup throws and spends no provider call', async () => {
    guard.authThrows = true;
    const routeModule = await loadWithSession<Record<string, Handler>>(module);
    const response = await call(routeModule);
    expect(response.status).toBe(503);
    expect(state.providerCalls).toBe(0);
    expect(state.fetchCalls).toBe(0);
  });

  it('lets a signed-in user past the gate', async () => {
    asPlainUser(guard);
    const routeModule = await loadWithSession<Record<string, Handler>>(module);
    const response = await call(routeModule);
    expect([401, 503]).not.toContain(response.status);
  });
});

describe('config/system-prompts/translate is admin only (ME-04)', () => {
  const body = { templateKey: 'current', targetLanguage: 'French', preContext: 'Answer with {{context}}' };
  const load = () => loadWithSession<{ POST: Handler }>('@/app/api/config/system-prompts/translate/route');

  it('answers 401 without a session and calls no provider', async () => {
    const { POST } = await load();
    const response = await POST(json('/api/config/system-prompts/translate', body));
    expect(response.status).toBe(401);
    expect(state.fetchCalls).toBe(0);
  });

  it('answers 403 for a signed-in non-admin and calls no provider', async () => {
    asPlainUser(guard);
    const { POST } = await load();
    const response = await POST(json('/api/config/system-prompts/translate', body));
    expect(response.status).toBe(403);
    expect(state.fetchCalls).toBe(0);
  });

  it('answers 503 when the admin lookup fails', async () => {
    asAdmin(guard);
    guard.lookupFails = true;
    const { POST } = await load();
    const response = await POST(json('/api/config/system-prompts/translate', body));
    expect(response.status).toBe(503);
    expect(state.fetchCalls).toBe(0);
  });

  it('lets an admin reach the translation call', async () => {
    asAdmin(guard);
    const { POST } = await load();
    const response = await POST(json('/api/config/system-prompts/translate', body));
    expect([401, 403, 503]).not.toContain(response.status);
    expect(state.fetchCalls).toBeGreaterThan(0);
  });
});

describe('embed rate limit identifier (ME-04)', () => {
  const ORIGINAL_VERCEL = process.env.VERCEL;

  afterEach(() => {
    if (ORIGINAL_VERCEL === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = ORIGINAL_VERCEL;
  });

  function req(headers: Record<string, string>) {
    return new Request('http://localhost/api/embed/chat', { method: 'POST', headers });
  }

  it('ignores a caller-supplied Origin so changing it cannot reset the limit', async () => {
    vi.resetModules();
    const { getRateLimitIdentifier } = await import('@/lib/embed-rate-limit');
    const a = getRateLimitIdentifier(req({ 'x-real-ip': '203.0.113.7', origin: 'https://one.example' }));
    const b = getRateLimitIdentifier(req({ 'x-real-ip': '203.0.113.7', origin: 'https://two.example' }));
    expect(a).toBe(b);
  });

  it('on Vercel uses the platform x-real-ip and ignores a spoofed x-forwarded-for chain', async () => {
    process.env.VERCEL = '1';
    vi.resetModules();
    const { getRateLimitIdentifier } = await import('@/lib/embed-rate-limit');
    const a = getRateLimitIdentifier(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 203.0.113.7' }));
    const b = getRateLimitIdentifier(req({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.99, 203.0.113.7' }));
    expect(a).toBe(b);
    expect(a).toContain('203.0.113.7');
  });

  it('off Vercel keys on the proxy-appended last hop, not the client-controlled first entry', async () => {
    delete process.env.VERCEL;
    vi.resetModules();
    const { getRateLimitIdentifier } = await import('@/lib/embed-rate-limit');
    const a = getRateLimitIdentifier(req({ 'x-forwarded-for': '1.1.1.1, 203.0.113.7' }));
    const b = getRateLimitIdentifier(req({ 'x-forwarded-for': '2.2.2.2, 203.0.113.7' }));
    expect(a).toBe(b);
  });

  it('does not trust cf-connecting-ip', async () => {
    delete process.env.VERCEL;
    vi.resetModules();
    const { getRateLimitIdentifier } = await import('@/lib/embed-rate-limit');
    const a = getRateLimitIdentifier(req({ 'cf-connecting-ip': '1.1.1.1' }));
    const b = getRateLimitIdentifier(req({ 'cf-connecting-ip': '2.2.2.2' }));
    expect(a).toBe(b);
  });

  it('includes the configured embed tenant', async () => {
    delete process.env.VERCEL;
    vi.resetModules();
    vi.doMock('@/lib/env', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/env')>();
      return { ...actual, env: new Proxy(actual.env, { get: (target, key) => (key === 'RAG_EMBED_TENANT' ? 'tenant-placeholder' : Reflect.get(target, key)) }) };
    });
    const { getRateLimitIdentifier } = await import('@/lib/embed-rate-limit');
    expect(getRateLimitIdentifier(req({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7:tenant-placeholder');
    vi.doUnmock('@/lib/env');
  });
});
