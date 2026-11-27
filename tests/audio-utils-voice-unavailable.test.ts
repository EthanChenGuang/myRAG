import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVoiceUnavailableError, speechToText, textToSpeech } from '@/lib/audio-utils';

function unavailable() {
  return new Response(
    JSON.stringify({ success: false, error: 'voice_unavailable', message: 'Voice is temporarily unavailable.' }),
    { status: 503, headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('audio client and voice_unavailable', () => {
  it('speechToText rejects with a voice-unavailable error', async () => {
    vi.stubGlobal('fetch', async () => unavailable());
    const error = await speechToText(new Blob([new Uint8Array([1])])).catch((e: unknown) => e);
    expect(isVoiceUnavailableError(error)).toBe(true);
  });

  it('textToSpeech rejects with a voice-unavailable error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => unavailable());
    const error = await textToSpeech('placeholder text').catch((e: unknown) => e);
    expect(isVoiceUnavailableError(error)).toBe(true);
  });

  it('keeps other failures as plain errors', async () => {
    vi.stubGlobal('fetch', async () => new Response('Internal Server Error', { status: 500 }));
    const error = await speechToText(new Blob([new Uint8Array([1])])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isVoiceUnavailableError(error)).toBe(false);
  });

  it('does not treat the session 503 as voice unavailable', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Authentication unavailable' }), { status: 503 }));
    const error = await speechToText(new Blob([new Uint8Array([1])])).catch((e: unknown) => e);
    expect(isVoiceUnavailableError(error)).toBe(false);
  });
});
