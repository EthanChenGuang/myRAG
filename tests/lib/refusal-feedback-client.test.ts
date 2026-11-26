import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRefusalControlHidden,
  isTraceId,
  postRefusalFeedback,
  postSourceOpened,
  refusalRequestFor,
  registerMessageTrace,
  resetRefusalFeedbackSession,
  setSourcesMessage,
  shouldShowRefusalControl,
  signalSourceOpened,
  sourceKeyOf,
  sourcesMessage,
  traceForMessage,
} from '@/lib/chat/refusal-feedback-client';
import {
  extractStreamAnswerMetadata,
  pickRefusalMetadata,
  withRefusalFeedback,
  type RefusalFeedbackValue,
} from '@/lib/chat/answer-metadata';

const TRACE = 'a'.repeat(32);
const OTHER_TRACE = 'b'.repeat(32);
const SAVED: RefusalFeedbackValue = { vote: 'expected_answer', reasons: [], at: '2026-11-26T10:00:00.000Z' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  resetRefusalFeedbackSession();
});

describe('isTraceId', () => {
  it('accepts 32 lowercase hex characters only', () => {
    expect(isTraceId(TRACE)).toBe(true);
    expect(isTraceId('A'.repeat(32))).toBe(false);
    expect(isTraceId('a'.repeat(31))).toBe(false);
    expect(isTraceId('trace-1')).toBe(false);
    expect(isTraceId(undefined)).toBe(false);
  });
});

describe('shouldShowRefusalControl', () => {
  const base = { role: 'assistant', finished: true, metadata: { ragTraceId: TRACE, refusal: true }, isGhostMode: false, chatId: '22222222-2222-4222-8222-222222222222' };

  it('shows for a finished assistant refusal with a valid trace id', () => {
    expect(shouldShowRefusalControl(base)).toBe(true);
  });

  it.each([
    ['no refusal flag', { metadata: { ragTraceId: TRACE } }],
    ['refusal false', { metadata: { ragTraceId: TRACE, refusal: false } }],
    ['no metadata', { metadata: undefined }],
    ['bad trace id', { metadata: { ragTraceId: 'trace-1', refusal: true } }],
    ['user message', { role: 'user' }],
    ['still streaming', { finished: false }],
    ['ghost mode', { isGhostMode: true }],
    ['ghost chat id', { chatId: 'ghost-123' }],
  ])('hides with %s', (_name, override) => {
    expect(shouldShowRefusalControl({ ...base, ...override })).toBe(false);
  });

  it('hides once the trace was hidden by two 404s in this session', async () => {
    const fetch = vi.fn(async () => json(404, { error: 'not_found' }));
    await postRefusalFeedback(TRACE, { vote: 'correct_refusal', reasons: [] }, { fetch, sleep: async () => {} });
    expect(isRefusalControlHidden(TRACE)).toBe(true);
    expect(shouldShowRefusalControl(base)).toBe(false);
  });
});

describe('refusalRequestFor', () => {
  it('sends expected_answer with no reasons on the first choice', () => {
    expect(refusalRequestFor(null, { type: 'vote', vote: 'expected_answer' })).toEqual({ vote: 'expected_answer', reasons: [] });
  });

  it('sends correct_refusal with no reasons and drops chips', () => {
    const current: RefusalFeedbackValue = { vote: 'expected_answer', reasons: ['other'], at: SAVED.at };
    expect(refusalRequestFor(current, { type: 'vote', vote: 'correct_refusal' })).toEqual({ vote: 'correct_refusal', reasons: [] });
  });

  it('does nothing when the chosen button is selected again', () => {
    expect(refusalRequestFor(SAVED, { type: 'vote', vote: 'expected_answer' })).toBeNull();
  });

  it('toggles chips in a fixed order only after expected_answer', () => {
    const withOther = refusalRequestFor(SAVED, { type: 'reason', reason: 'other' });
    expect(withOther).toEqual({ vote: 'expected_answer', reasons: ['other'] });
    const both = refusalRequestFor({ ...SAVED, reasons: ['other'] }, { type: 'reason', reason: 'answer_exists' });
    expect(both).toEqual({ vote: 'expected_answer', reasons: ['answer_exists', 'other'] });
    expect(refusalRequestFor({ ...SAVED, reasons: ['other'] }, { type: 'reason', reason: 'other' })).toEqual({ vote: 'expected_answer', reasons: [] });
    expect(refusalRequestFor(null, { type: 'reason', reason: 'other' })).toBeNull();
    expect(refusalRequestFor({ ...SAVED, vote: 'correct_refusal' }, { type: 'reason', reason: 'other' })).toBeNull();
  });
});

describe('postRefusalFeedback', () => {
  it('posts JSON same-origin to the trace route and returns the stored value', async () => {
    const fetch = vi.fn(async () => json(200, { vote: 'expected_answer', reasons: ['wrong_language'], at: SAVED.at }));
    const result = await postRefusalFeedback(TRACE, { vote: 'expected_answer', reasons: ['wrong_language'] }, { fetch });
    expect(result).toEqual({ ok: true, feedback: { vote: 'expected_answer', reasons: ['wrong_language'], at: SAVED.at } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/rag/retrieval/${TRACE}/feedback`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ vote: 'expected_answer', reasons: ['wrong_language'] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries a first 404 once after 2 s and succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(404, { error: 'not_found' }))
      .mockResolvedValueOnce(json(200, { vote: 'correct_refusal', reasons: [], at: SAVED.at }));
    const result = await postRefusalFeedback(TRACE, { vote: 'correct_refusal', reasons: [] }, { fetch, sleep });
    expect(result.ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(isRefusalControlHidden(TRACE)).toBe(false);
  });

  it('hides the control after a second 404', async () => {
    const fetch = vi.fn(async () => json(404, { error: 'not_found' }));
    const result = await postRefusalFeedback(TRACE, { vote: 'correct_refusal', reasons: [] }, { fetch, sleep: async () => {} });
    expect(result).toEqual({ ok: false, hidden: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(isRefusalControlHidden(TRACE)).toBe(true);
    expect(isRefusalControlHidden(OTHER_TRACE)).toBe(false);
  });

  it.each([400, 401, 415, 500, 503])('offers a retry on %i', async (status) => {
    const fetch = vi.fn(async () => json(status, { error: 'x' }));
    expect(await postRefusalFeedback(TRACE, { vote: 'correct_refusal', reasons: [] }, { fetch })).toEqual({ ok: false, retry: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the network throws or the response is malformed', async () => {
    const thrown = vi.fn(async () => {
      throw new TypeError('network');
    });
    expect(await postRefusalFeedback(TRACE, { vote: 'correct_refusal', reasons: [] }, { fetch: thrown })).toEqual({ ok: false, retry: true });
    const malformed = vi.fn(async () => json(200, { vote: 'maybe' }));
    expect(await postRefusalFeedback(TRACE, { vote: 'correct_refusal', reasons: [] }, { fetch: malformed })).toEqual({ ok: false, retry: true });
  });

  it('aborts after the timeout and offers a retry', async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    expect(await postRefusalFeedback(TRACE, { vote: 'correct_refusal', reasons: [] }, { fetch, timeoutMs: 5 })).toEqual({ ok: false, retry: true });
  });

  it('never sends for a malformed trace id', async () => {
    const fetch = vi.fn(async () => json(200, {}));
    expect(await postRefusalFeedback('../admin', { vote: 'correct_refusal', reasons: [] }, { fetch })).toEqual({ ok: false, hidden: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('source-open signal', () => {
  it('posts the constant body with keepalive and only the trace id in the path', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    expect(postSourceOpened(TRACE, 'doc:doc-1', { fetch })).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/rag/retrieval/${TRACE}/signal`);
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(String(init.body))).toEqual({ kind: 'source_opened' });
    expect(String(init.body)).not.toContain('doc-1');
  });

  it('sends once per source per trace in the session', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    postSourceOpened(TRACE, 'citation:1', { fetch });
    postSourceOpened(TRACE, 'citation:1', { fetch });
    postSourceOpened(TRACE, 'citation:2', { fetch });
    postSourceOpened(OTHER_TRACE, 'citation:1', { fetch });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops sending for a trace after a 404', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    postSourceOpened(TRACE, 'citation:1', { fetch });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postSourceOpened(TRACE, 'citation:2', { fetch })).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('swallows a thrown or rejected fetch', async () => {
    const throwing = vi.fn(() => {
      throw new Error('sync');
    });
    expect(() => postSourceOpened(TRACE, 'citation:1', { fetch: throwing as never })).not.toThrow();
    const rejecting = vi.fn(async () => {
      throw new Error('async');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    postSourceOpened(OTHER_TRACE, 'citation:1', { fetch: rejecting });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('never sends for a malformed trace id', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    expect(postSourceOpened('trace-1', 'citation:1', { fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves the trace through the message registry', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    registerMessageTrace('m1', TRACE);
    expect(traceForMessage('m1')).toBe(TRACE);
    expect(signalSourceOpened({ messageId: 'm1', sourceKey: 'citation:1', incognito: false }, { fetch })).toBe(true);
    expect(signalSourceOpened({ messageId: 'm2', sourceKey: 'citation:1', incognito: false }, { fetch })).toBe(false);
    expect(signalSourceOpened({ messageId: null, sourceKey: 'citation:1', incognito: false }, { fetch })).toBe(false);
    expect(signalSourceOpened({ messageId: 'm1', sourceKey: null, incognito: false }, { fetch })).toBe(false);
    registerMessageTrace('m1', undefined);
    expect(traceForMessage('m1')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never sends in an incognito chat', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    registerMessageTrace('m1', TRACE);
    expect(signalSourceOpened({ messageId: 'm1', sourceKey: 'citation:1', incognito: true }, { fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('remembers which message owns the sources panel', () => {
    setSourcesMessage('m3');
    expect(sourcesMessage()).toBe('m3');
    setSourcesMessage(null);
    expect(sourcesMessage()).toBeNull();
  });

  it('keys a source by citation number, else document id, else URL', () => {
    expect(sourceKeyOf({ citation: { n: 2 }, documentId: 'd' })).toBe('citation:2');
    expect(sourceKeyOf({ documentId: 'd', url: 'https://example.org/a' })).toBe('doc:d');
    expect(sourceKeyOf({ url: 'https://example.org/a' })).toBe('url:https://example.org/a');
    expect(sourceKeyOf({})).toBeNull();
  });
});

describe('refusal metadata', () => {
  it('keeps refusal from the stream start metadata', () => {
    expect(extractStreamAnswerMetadata({ ragTraceId: TRACE, refusal: true })).toEqual({ ragTraceId: TRACE, refusal: true });
    expect(extractStreamAnswerMetadata({ ragTraceId: TRACE, refusal: 'yes' })).toEqual({ ragTraceId: TRACE });
    expect(extractStreamAnswerMetadata({ ragTraceId: TRACE })).toEqual({ ragTraceId: TRACE });
  });

  it('picks only a valid refusal flag and stored vote', () => {
    expect(pickRefusalMetadata({ refusal: true, refusalFeedback: SAVED, other: 1 })).toEqual({ refusal: true, refusalFeedback: SAVED });
    expect(pickRefusalMetadata({ refusal: false, refusalFeedback: { vote: 'maybe', reasons: [], at: 'x' } })).toEqual({});
    expect(pickRefusalMetadata(undefined)).toEqual({});
  });

  it('writes a saved vote into the matching message only', () => {
    const messages = [
      { id: 'm1', metadata: { ragTraceId: TRACE, refusal: true } as Record<string, unknown> },
      { id: 'm2', metadata: { ragTraceId: OTHER_TRACE } as Record<string, unknown> },
    ];
    const next = withRefusalFeedback(messages, 'm1', SAVED);
    expect(next).not.toBe(messages);
    expect(next[0].metadata).toEqual({ ragTraceId: TRACE, refusal: true, refusalFeedback: SAVED });
    expect(next[1]).toBe(messages[1]);
    expect(withRefusalFeedback(next, 'm1', SAVED)).toBe(next);
    expect(withRefusalFeedback(messages, 'missing', SAVED)).toBe(messages);
  });
});
