import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'internal-api-key-placeholder-000000';

const compared = vi.hoisted(() => ({ lengths: [] as Array<[number, number]> }));
const scopeCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
    compared.lengths.push([a.byteLength, b.byteLength]);
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

vi.mock('@/lib/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag')>();
  return {
    ...actual,
    resolveVoiceScope: async () => {
      scopeCalls.count += 1;
      return { ok: false, status: 401, reason: 'stopped_by_test' };
    },
  };
});

interface VoiceRoute {
  POST(req: NextRequest): Promise<Response>;
}

const LOADERS = {
  'voice-chat': () => import('@/app/api/internal/voice-chat/route'),
  'voice-rag': () => import('@/app/api/internal/voice-rag/route'),
  'voice-timing': () => import('@/app/api/internal/voice-timing/route'),
};
const BODIES: Record<string, unknown> = {
  'voice-timing': { traceId: '0123456789abcdef0123456789abcdef', ttft_ms: 500, pre_generation_ms: 200 },
};
const ROUTES = Object.keys(LOADERS) as Array<keyof typeof LOADERS>;

function post(route: string, key: string | null): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key !== null) headers['x-api-key'] = key;
  return new NextRequest(`http://localhost/api/internal/${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(BODIES[route] ?? { query: 'hello', messages: [] }),
  });
}

beforeEach(() => {
  process.env.MYRAG_INTERNAL_API_KEY = KEY;
  compared.lengths.length = 0;
  scopeCalls.count = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MYRAG_INTERNAL_API_KEY;
});

describe.each(ROUTES)('internal/%s x-api-key check', (name) => {
  async function load(): Promise<VoiceRoute> {
    return (await LOADERS[name]()) as unknown as VoiceRoute;
  }

  it('compares the key with timingSafeEqual over equal-length buffers', async () => {
    const { POST } = await load();
    await POST(post(name, 'short'));
    expect(compared.lengths.length).toBeGreaterThan(0);
    for (const [left, right] of compared.lengths) expect(left).toBe(right);
  });

  it('rejects wrong keys of any length before resolving a scope', async () => {
    const { POST } = await load();
    for (const wrong of ['short', `${KEY}x`, KEY.slice(0, -1), KEY.replace(/.$/, 'z')]) {
      expect((await POST(post(name, wrong))).status).toBe(401);
    }
    expect((await POST(post(name, null))).status).toBe(401);
    expect(scopeCalls.count).toBe(0);
  });

  it('accepts the configured key', async () => {
    const { POST } = await load();
    await POST(post(name, KEY));
    expect(scopeCalls.count).toBe(1);
  });
});
