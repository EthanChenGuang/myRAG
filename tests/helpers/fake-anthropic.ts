import { readFileSync } from 'node:fs';
import path from 'node:path';

export const FAKE_ANTHROPIC_KEY = 'test-anthropic-key-placeholder';
export const FAKE_ANTHROPIC_BASE_URL = 'http://127.0.0.1:4318/v1';

export interface CapturedAnthropicRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type FakeAnthropicResponse =
  | { sse: string; status?: undefined; body?: undefined }
  | { status: number; body: unknown; sse?: undefined };

export interface FakeAnthropicFetch {
  fetch: typeof fetch;
  requests: CapturedAnthropicRequest[];
  last(): CapturedAnthropicRequest;
}

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'anthropic');

/** Reads a recorded-shape SSE fixture from tests/fixtures/anthropic. */
export function readAnthropicFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init ?? {}).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** A fetch that records each request and answers with an SSE fixture or a JSON error. */
export function createFakeAnthropicFetch(response: FakeAnthropicResponse): FakeAnthropicFetch {
  const requests: CapturedAnthropicRequest[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === 'string' ? init.body : '';
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: headersToRecord(init?.headers),
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    if (response.sse !== undefined) {
      const text = response.sse.endsWith('.sse') ? readAnthropicFixture(response.sse) : response.sse;
      return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    fetch: fake,
    requests,
    last() {
      const request = requests[requests.length - 1];
      if (!request) throw new Error('no Anthropic request captured');
      return request;
    },
  };
}
