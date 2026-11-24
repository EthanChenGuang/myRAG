import { afterEach, describe, expect, test, vi } from 'vitest';
import { SIDECAR_SECRET_HEADER, checkSidecarSecret } from '@/lib/rag/ingest/callbacks/internal-auth';

const SECRET = 'sidecar-secret-for-unit-tests-0000';

afterEach(() => {
  vi.restoreAllMocks();
});

function headers(value?: string): Headers {
  const out = new Headers();
  if (value !== undefined) out.set(SIDECAR_SECRET_HEADER, value);
  return out;
}

describe('checkSidecarSecret', () => {
  test('accepts the exact secret', () => {
    expect(checkSidecarSecret(headers(SECRET), { secret: () => SECRET })).toEqual({ ok: true });
  });

  test('refuses a missing, empty, wrong or truncated header with 401', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const value of [undefined, '', 'nope', SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
      expect(checkSidecarSecret(headers(value), { secret: () => SECRET })).toEqual({ ok: false, status: 401, reason: 'secret_rejected' });
    }
  });

  test('refuses everything while the secret is unset, even an empty header', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const value of [undefined, '', SECRET]) {
      expect(checkSidecarSecret(headers(value), { secret: () => '' })).toEqual({ ok: false, status: 401, reason: 'secret_unset' });
    }
  });

  test('reads the secret on every call', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let current = 'first-secret-value-000000000000';
    const deps = { secret: () => current };
    expect(checkSidecarSecret(headers(current), deps).ok).toBe(true);
    current = 'second-secret-value-00000000000';
    expect(checkSidecarSecret(headers('first-secret-value-000000000000'), deps).ok).toBe(false);
  });

  test('logs a refusal without the header value or the secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    checkSidecarSecret(headers('leaked-guess-value'), { secret: () => SECRET });
    const text = JSON.stringify(warn.mock.calls);
    expect(text).not.toContain('leaked-guess-value');
    expect(text).not.toContain(SECRET);
  });
});
