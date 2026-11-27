import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPlainUser, mockAdminGuard, newGuardState, silenceConsole, type AdminGuardState } from '../helpers/admin-guard-fixture';

const state = vi.hoisted(() => ({ providerCalls: 0, elevenLabsConfigured: false }));
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

let guard: AdminGuardState;

type Handler = (request: NextRequest) => Promise<Response>;

async function loadRoute(): Promise<{ GET: Handler; POST: Handler }> {
  vi.resetModules();
  mockAdminGuard(guard);
  vi.doMock('openai', () => ({
    default: class FakeOpenAI {
      constructor(options: { apiKey?: string }) {
        if (!options?.apiKey) throw new Error('missing api key');
      }
      audio = {
        speech: { create: async () => { state.providerCalls += 1; return { body: null }; } },
        transcriptions: { create: async () => { state.providerCalls += 1; return { text: 'placeholder' }; } },
      };
    },
  }));
  vi.doMock('@/lib/elevenlabs-utils', () => ({
    isElevenLabsConfigured: () => state.elevenLabsConfigured,
    elevenLabsTextToSpeech: async () => { state.providerCalls += 1; throw new Error('provider stopped by test'); },
    elevenLabsSpeechToText: async () => { state.providerCalls += 1; throw new Error('provider stopped by test'); },
  }));
  return (await import('@/app/api/audio/route')) as unknown as { GET: Handler; POST: Handler };
}

function audioForm(action: string, provider?: string) {
  const form = new FormData();
  form.set('action', action);
  form.set('text', 'placeholder text');
  form.set('file', new File([new Uint8Array([1, 2, 3])], 'clip.webm', { type: 'audio/webm' }));
  if (provider) form.set('provider', provider);
  return new NextRequest('http://localhost/api/audio', { method: 'POST', body: form });
}

const CALLS: Array<{ name: string; call: (m: { GET: Handler; POST: Handler }) => Promise<Response> }> = [
  { name: 'POST speech', call: (m) => m.POST(audioForm('speech')) },
  { name: 'POST transcribe', call: (m) => m.POST(audioForm('transcribe')) },
  { name: 'GET speech', call: (m) => m.GET(new NextRequest('http://localhost/api/audio?action=speech&text=placeholder')) },
  { name: 'POST speech with an unconfigured second provider', call: (m) => m.POST(audioForm('speech', 'elevenlabs')) },
  { name: 'POST transcribe with an unconfigured second provider', call: (m) => m.POST(audioForm('transcribe', 'elevenlabs')) },
];

beforeEach(() => {
  guard = newGuardState();
  state.providerCalls = 0;
  state.elevenLabsConfigured = false;
  silenceConsole();
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('audio route without OPENAI_API_KEY', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    delete process.env.OPENAI_API_KEY;
  });

  it.each(CALLS)('$name answers 503 voice_unavailable as structured JSON', async ({ call }) => {
    asPlainUser(guard);
    const route = await loadRoute();
    const response = await call(route);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await response.json();
    expect(body).toMatchObject({ success: false, error: 'voice_unavailable' });
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(state.providerCalls).toBe(0);
  });

  it.each(CALLS)('$name still answers 401 without a session', async ({ call }) => {
    const route = await loadRoute();
    const response = await call(route);
    expect(response.status).toBe(401);
    expect(state.providerCalls).toBe(0);
  });
});

describe('audio route with OPENAI_API_KEY', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-openai-key-placeholder';
  });

  it('keeps transcription unchanged', async () => {
    asPlainUser(guard);
    const route = await loadRoute();
    const response = await route.POST(audioForm('transcribe'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'placeholder' });
    expect(state.providerCalls).toBe(1);
  });

  it('keeps speech unchanged', async () => {
    asPlainUser(guard);
    const route = await loadRoute();
    const response = await route.POST(audioForm('speech'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(state.providerCalls).toBe(1);
  });

  it('keeps the 400 for a missing text', async () => {
    asPlainUser(guard);
    const route = await loadRoute();
    const response = await route.GET(new NextRequest('http://localhost/api/audio?action=speech'));
    expect(response.status).toBe(400);
  });
});
