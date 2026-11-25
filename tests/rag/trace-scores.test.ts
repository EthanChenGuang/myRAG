import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LangfuseConfig } from '@/lib/rag/trace/config';
import { postLangfuseScores, scoreId, type LangfuseScoreInput } from '@/lib/rag/trace/scores';
import { startFakeLangfuse, type FakeLangfuse } from '../helpers/fake-langfuse.mts';

const PUBLIC_KEY = 'pk-lf-test-placeholder';
const SECRET_KEY = 'sk-lf-test-placeholder';
const TRACE_ID = '0123456789abcdef0123456789abcdef';

function configFor(baseUrl: string, overrides: Partial<LangfuseConfig> = {}): LangfuseConfig {
  return {
    enabled: true,
    publicKey: PUBLIC_KEY,
    secretKey: SECRET_KEY,
    baseUrl,
    sampleRate: 1,
    reviewSampleRate: 0,
    captureContent: false,
    ...overrides,
  };
}

const SCORES: LangfuseScoreInput[] = [
  { traceId: TRACE_ID, name: 'groundedness', value: 0.71, dataType: 'NUMERIC' },
  { traceId: TRACE_ID, name: 'groundedness_label', value: 'verified', dataType: 'CATEGORICAL', comment: 'hhem_2_1_open', metadata: { language: 'en' } },
];

async function startHangingServer(): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let count = 0;
  const held: http.ServerResponse[] = [];
  const server = http.createServer((_req, res) => {
    count += 1;
    held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => count,
    async close() {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('postLangfuseScores', () => {
  let fake: FakeLangfuse;
  let partial: FakeLangfuse;

  beforeAll(async () => {
    fake = await startFakeLangfuse();
    partial = await startFakeLangfuse({ scoresStatus: 207 });
  });

  afterAll(async () => {
    await fake.close();
    await partial.close();
  });

  beforeEach(() => {
    fake.reset();
    partial.reset();
  });

  it('scoreId is the sha256 hex of "traceId|name"', () => {
    expect(scoreId(TRACE_ID, 'groundedness')).toBe(createHash('sha256').update(`${TRACE_ID}|groundedness`).digest('hex'));
    expect(scoreId(TRACE_ID, 'groundedness')).toMatch(/^[a-f0-9]{64}$/);
    expect(scoreId(TRACE_ID, 'groundedness')).not.toBe(scoreId(TRACE_ID, 'groundedness_label'));
  });

  it('sends one POST with Basic auth and an array body holding both scores, and returns accepted on 202', async () => {
    const result = await postLangfuseScores(SCORES, { config: configFor(fake.url) });
    expect(result).toEqual({ status: 'accepted', httpStatus: 202 });
    const posts = fake.requests.filter((request) => request.path === '/api/public/scores');
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe('POST');
    expect(posts[0].authorization).toBe(`Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64')}`);
    expect(posts[0].contentType).toContain('application/json');
    expect(fake.scores).toEqual([
      { id: scoreId(TRACE_ID, 'groundedness'), traceId: TRACE_ID, name: 'groundedness', value: 0.71, dataType: 'NUMERIC' },
      {
        id: scoreId(TRACE_ID, 'groundedness_label'),
        traceId: TRACE_ID,
        name: 'groundedness_label',
        value: 'verified',
        dataType: 'CATEGORICAL',
        comment: 'hhem_2_1_open',
        metadata: { language: 'en' },
      },
    ]);
  });

  it('posts the same id twice for the same trace and name, so the second overwrites the first', async () => {
    await postLangfuseScores([SCORES[0]], { config: configFor(fake.url) });
    await postLangfuseScores([{ ...SCORES[0], value: 0.2 }], { config: configFor(fake.url) });
    const ids = (fake.scores as Array<{ id: string }>).map((score) => score.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it('returns partial on 207', async () => {
    const result = await postLangfuseScores(SCORES, { config: configFor(partial.url) });
    expect(result).toEqual({ status: 'partial', httpStatus: 207 });
  });

  it('abandons a hanging server after the time box and returns failed without throwing', async () => {
    const hanging = await startHangingServer();
    try {
      const started = Date.now();
      const result = await postLangfuseScores(SCORES, { config: configFor(hanging.url), timeoutMs: 100 });
      expect(result.status).toBe('failed');
      expect(result.httpStatus).toBeNull();
      expect(hanging.requests()).toBe(1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await hanging.close();
    }
  });

  it('returns failed on an HTTP error and on a transport failure', async () => {
    const errorFetch = vi.fn(async () => new Response('{}', { status: 500 }));
    expect(await postLangfuseScores(SCORES, { config: configFor(fake.url), fetch: errorFetch as unknown as typeof fetch })).toEqual({
      status: 'failed',
      httpStatus: 500,
    });
    const throwingFetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await postLangfuseScores(SCORES, { config: configFor(fake.url), fetch: throwingFetch as unknown as typeof fetch })).toEqual({
      status: 'failed',
      httpStatus: null,
    });
  });

  it('returns skipped without a request when Langfuse is disabled, a key is missing or there is nothing to send', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 202 }));
    const options = (config: LangfuseConfig) => ({ config, fetch: fetchSpy as unknown as typeof fetch });
    expect((await postLangfuseScores(SCORES, options(configFor(fake.url, { enabled: false })))).status).toBe('skipped');
    expect((await postLangfuseScores(SCORES, options(configFor(fake.url, { secretKey: '' })))).status).toBe('skipped');
    expect((await postLangfuseScores([], options(configFor(fake.url)))).status).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.requests).toHaveLength(0);
  });

  it('never puts a key in the body or in a log line', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    const spies = [vi.spyOn(console, 'log').mockImplementation(capture), vi.spyOn(console, 'warn').mockImplementation(capture), vi.spyOn(console, 'error').mockImplementation(capture)];
    try {
      await postLangfuseScores(SCORES, { config: configFor(fake.url) });
      const hanging = await startHangingServer();
      await postLangfuseScores(SCORES, { config: configFor(hanging.url), timeoutMs: 50 });
      await hanging.close();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const serialized = JSON.stringify(fake.scores) + lines.join('\n');
    expect(serialized).not.toContain(PUBLIC_KEY);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(fake.scores).toHaveLength(2);
  });
});
