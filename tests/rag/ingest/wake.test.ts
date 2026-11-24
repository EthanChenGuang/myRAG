import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'wake-sidecar-secret-placeholder-00';
const URL = 'http://127.0.0.1:9199';

const afterMock = vi.hoisted(() => vi.fn((task: () => Promise<void>) => void task()));
const fetchMock = vi.hoisted(() => vi.fn());
const loggerDebug = vi.hoisted(() => vi.fn());

let envValues: { url: string; secret: string };

vi.mock('next/server', () => ({ after: afterMock }));
vi.mock('@/lib/logger', () => ({ logger: { debug: loggerDebug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/env', () => ({
  env: new Proxy({} as Record<string, string>, {
    get: (_target, prop: string) => {
      if (prop === 'RAG_SIDECAR_URL') return envValues.url;
      if (prop === 'RAG_SIDECAR_SECRET') return envValues.secret;
      return '';
    },
  }),
}));

async function loadWake() {
  vi.resetModules();
  return import('@/lib/rag/ingest/wake');
}

beforeEach(() => {
  envValues = { url: URL, secret: SECRET };
  afterMock.mockClear();
  fetchMock.mockReset();
  loggerDebug.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduleIngestWake', () => {
  it('is a no-op when RAG_SIDECAR_URL is unset', async () => {
    envValues.url = '';
    const { scheduleIngestWake } = await loadWake();
    scheduleIngestWake();
    expect(afterMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers after(), posts the wake with the secret header, and aborts after 1 s', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    const { scheduleIngestWake } = await loadWake();
    expect(() => scheduleIngestWake()).not.toThrow();
    expect(afterMock).toHaveBeenCalledTimes(1);
    const task = afterMock.mock.calls[0]![0] as () => Promise<void>;
    const pending = task();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith(
      `${URL}/v1/ingest/wake`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-sidecar-secret': SECRET }),
      }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('swallows a 500 response and logs only at debug without the secret', async () => {
    fetchMock.mockResolvedValue(new Response('fail', { status: 500 }));
    const { scheduleIngestWake } = await loadWake();
    scheduleIngestWake();
    const task = afterMock.mock.calls[0]![0] as () => Promise<void>;
    await expect(task()).resolves.toBeUndefined();
    const logged = JSON.stringify(loggerDebug.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(loggerDebug.mock.calls.some((call) => String(call[0]).includes('RAG Ingest'))).toBe(true);
  });

  it('swallows network errors without throwing', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('offline'), { name: 'TypeError' }));
    const { scheduleIngestWake } = await loadWake();
    scheduleIngestWake();
    const task = afterMock.mock.calls[0]![0] as () => Promise<void>;
    await expect(task()).resolves.toBeUndefined();
    expect(loggerDebug).toHaveBeenCalled();
    const logged = JSON.stringify(loggerDebug.mock.calls);
    expect(logged).not.toContain(SECRET);
  });

  it('is a no-op outside a request scope when after() throws', async () => {
    afterMock.mockImplementationOnce(() => {
      throw new Error('after_unavailable');
    });
    const { scheduleIngestWake } = await loadWake();
    expect(() => scheduleIngestWake()).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});