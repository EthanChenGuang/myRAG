import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createCohereReranker } from '@/lib/rag/rerank/cohere';
import { RerankError } from '@/lib/rag/rerank/scores';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '../../fixtures/rerank');
const COHERE_KEY = 'test-cohere-key-placeholder-0123456789';

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

type RecordedFetch = typeof fetch & { calls: { url: string; init: RequestInit }[] };

function recordingFetch(responses: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): RecordedFetch {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return responses(input, init);
  };
  const fn = impl as RecordedFetch;
  fn.calls = calls;
  return fn;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function cohereReranker(
  fetchFn: RecordedFetch,
  opts: { apiKey?: string; baseUrl?: string; model?: string } = {},
) {
  return createCohereReranker({
    fetch: fetchFn,
    apiKey: opts.apiKey ?? COHERE_KEY,
    baseUrl: opts.baseUrl ?? '',
    model: opts.model ?? 'rerank-v5.0-fast',
  });
}

describe('Cohere rerank adapter', () => {
  afterEach(() => {
    // isolate per test via fresh recordingFetch instances
  });

  it('returns scores for every document index from a recorded basic response', async () => {
    const body = readFixture('cohere-basic.json');
    const fetchFn = recordingFetch(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const reranker = cohereReranker(fetchFn);
    const docs = ['fixture doc one', 'fixture doc two', 'fixture doc three'];
    const out = await reranker.rerank('fixture query text', docs, { signal: signal() });
    expect(fetchFn.calls).toHaveLength(1);
    const call = fetchFn.calls[0];
    expect(call.url).toBe('https://api.cohere.com/v2/rerank');
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${COHERE_KEY}`);
    const reqBody = JSON.parse(String(call.init.body));
    expect(reqBody).toMatchObject({ model: 'rerank-v5.0-fast', query: 'fixture query text', documents: docs });
    expect(reqBody).not.toHaveProperty('top_n');
    expect(reqBody).not.toHaveProperty('relevant_spans');
    expect(out.scores.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(out.scores.map((s) => s.score)).toEqual([0.91, 0.44, 0.12]);
    expect(out.usage).toEqual({ search_units: 1 });
  });

  it('requests relevant_spans when wantSpans and preserves span offsets', async () => {
    const body = readFixture('cohere-spans.json');
    const fetchFn = recordingFetch(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const reranker = cohereReranker(fetchFn);
    const docs = ['fixture doc one', 'fixture doc two'];
    const out = await reranker.rerank('fixture query', docs, { signal: signal(), wantSpans: true });
    const reqBody = JSON.parse(String(fetchFn.calls[0].init.body));
    expect(reqBody.relevant_spans).toEqual({ mode: 'enabled' });
    expect(out.scores[0].spans).toEqual([{ start: 0, end: 12, score: 0.95 }]);
    expect(out.scores[1].spans).toEqual([{ start: 4, end: 18, score: 0.7 }]);
  });

  it('rejects a partial response missing an index', async () => {
    const body = readFixture('cohere-partial.json');
    const fetchFn = recordingFetch(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const reranker = cohereReranker(fetchFn);
    await expect(
      reranker.rerank('fixture query', ['fixture doc one', 'fixture doc two', 'fixture doc three'], {
        signal: signal(),
      }),
    ).rejects.toThrow(/incomplete|missing|index/i);
  });

  it('rejects duplicate indexes and non-finite scores via completeScores', async () => {
    const fetchFn = recordingFetch(async () =>
      new Response(
        JSON.stringify({
          id: 'fixture-response-id-placeholder',
          results: [
            { index: 0, relevance_score: 0.5 },
            { index: 0, relevance_score: 0.4 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const reranker = cohereReranker(fetchFn);
    await expect(reranker.rerank('q', ['a', 'b'], { signal: signal() })).rejects.toThrow();

    fetchFn.calls.length = 0;
    const fetchNaN = recordingFetch(async () =>
      new Response(
        JSON.stringify({
          id: 'fixture-response-id-placeholder',
          results: [
            { index: 0, relevance_score: 0.5 },
            { index: 1, relevance_score: Number.NaN },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(cohereReranker(fetchNaN).rerank('q', ['a', 'b'], { signal: signal() })).rejects.toThrow();
  });

  it('maps HTTP errors to RerankError without body or key in the message', async () => {
    const body = readFixture('cohere-429.json');
    const fetchFn = recordingFetch(async () =>
      new Response(JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json' } }),
    );
    const reranker = cohereReranker(fetchFn);
    let caught: unknown;
    try {
      await reranker.rerank('fixture query', ['fixture doc one'], { signal: signal() });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RerankError);
    const err = caught as RerankError;
    expect(err.provider).toBe('cohere');
    expect(err.status).toBe(429);
    expect(err.message).toBe('[RAG Rerank] cohere failed (429)');
    expect(err.message).not.toContain(COHERE_KEY);
    expect(err.message).not.toContain('rate limited');
  });

  it('honours abort before the request completes', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = recordingFetch(async () => {
      throw new Error('fetch should not run');
    });
    await expect(
      cohereReranker(fetchFn).rerank('q', ['doc'], { signal: controller.signal }),
    ).rejects.toBeTruthy();
    expect(fetchFn.calls).toHaveLength(0);
  });

  it('composes timeoutMs with the caller signal through AbortSignal.any', async () => {
    let sawSignal = false;
    const fetchFn = recordingFetch(async (_url, init) => {
      sawSignal = init?.signal instanceof AbortSignal;
      const body = readFixture('cohere-basic.json');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await cohereReranker(fetchFn).rerank('q', ['fixture doc one', 'fixture doc two', 'fixture doc three'], {
      signal: signal(),
      timeoutMs: 5000,
    });
    expect(sawSignal).toBe(true);
  });

  it('uses https://api.cohere.com when baseUrl is empty', async () => {
    const fetchFn = recordingFetch(async () =>
      new Response(JSON.stringify(readFixture('cohere-basic.json')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await cohereReranker(fetchFn, { baseUrl: '' }).rerank('q', ['fixture doc one', 'fixture doc two', 'fixture doc three'], {
      signal: signal(),
    });
    expect(fetchFn.calls[0].url).toBe('https://api.cohere.com/v2/rerank');
  });
});