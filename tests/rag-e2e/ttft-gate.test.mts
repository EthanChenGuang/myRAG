/**
 * D-26, D-55 (F-18): the pre-generation latency gate. The chat route, the embed route and the voice-rag handler run against the
 * fixture database with a fake model behind the OpenRouter URL, on the real clock. One warm-up turn per channel is excluded, and the
 * nearest-rank p95 of the measured turns must stay at or below the channel's `pre_generation` budget. The meta-test injects a delay
 * of the budget plus 50 ms through the test-only setter and asserts that the same check then fails.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { loadPinnedEvalEnv } from '../../eval/harness/eval-env.mts';
import { fixtureProcessEnv, startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { createFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { percentile } from './latency-stats.mts';

// Next.js creates its request stores from a global AsyncLocalStorage when its modules load; every Next import below is dynamic.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUDGETS_PATH = path.join(REPO_ROOT, 'eval/config/latency-budgets.json');
const GOLDEN_PATH = path.join(REPO_ROOT, 'eval/fixtures/golden.jsonl');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const INTERNAL_API_KEY = 'test-internal-api-key-placeholder';
const VOICE_SECRET = crypto.randomBytes(24).toString('hex');
const OPENROUTER_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';
const MEASURED_TURNS = 6;
const META_EXTRA_MS = 50;
const LONG_TIMER_MS = 60_000;

export type Channel = 'chat' | 'embed' | 'voice';
const CHANNELS: readonly Channel[] = ['chat', 'embed', 'voice'];

export interface PreGenerationBudgets {
  pre_generation?: Partial<Record<Channel, { p95_ms: number }>>;
}

export interface GateVerdict {
  ok: boolean;
  channel: Channel;
  n: number;
  p95: number;
  budget: number;
  message: string;
}

/** D-26: the CI gate. Nearest-rank p95 of the measured samples against the channel's ceiling; never p50. */
export function preGenerationWithinBudget(channel: Channel, samples: readonly number[], budgets: PreGenerationBudgets): GateVerdict {
  const budget = budgets.pre_generation?.[channel]?.p95_ms;
  if (typeof budget !== 'number' || !(budget > 0)) throw new Error(`no pre_generation p95 budget for ${channel}`);
  if (samples.length === 0) throw new Error(`no pre_generation samples for ${channel}`);
  if (samples.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error(`a pre_generation sample for ${channel} is not a finite non-negative number`);
  }
  const p95 = percentile(samples, 0.95);
  const ok = p95 <= budget;
  return {
    ok,
    channel,
    n: samples.length,
    p95,
    budget,
    message: `${channel}: pre_generation p95 ${p95.toFixed(1)} ms over ${samples.length} turns ${ok ? '<=' : '>'} budget ${budget} ms`,
  };
}

interface NextScope {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
  RequestCookies: new (headers: Headers) => unknown;
}

type RouteModule = { POST: (request: Request) => Promise<Response> };

interface TraceLine {
  profile?: string;
  pre_generation_ms?: number | null;
  ttft_ms?: number | null;
  cache?: string;
}

interface Turn {
  preGenerationMs: number;
  ttftMs: number | null;
  firstTextClientMs: number | null;
  body: string;
}

/** A fake OpenAI-compatible streaming completion: three content deltas, then stop. */
function fakeCompletion(): Response {
  const encoder = new TextEncoder();
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>) =>
    `data: ${JSON.stringify({
      id: 'fake-completion',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fake-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  const parts = [
    chunk({ role: 'assistant', content: 'A neutral ' }, null),
    chunk({ content: 'synthetic ' }, null),
    chunk({ content: 'answer.' }, null),
    chunk({}, 'stop', { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 }),
    'data: [DONE]\n\n',
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function sseTextDeltas(body: string): string[] {
  const deltas: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const part = JSON.parse(payload) as { type?: string; delta?: string };
      if (part.type === 'text-delta' && typeof part.delta === 'string') deltas.push(part.delta);
    } catch {
      continue;
    }
  }
  return deltas;
}

describe('pre-generation latency gate (D-26, D-55)', () => {
  let edge: FakeEdge;
  let closeDb: () => Promise<void>;
  let next: NextScope;
  let chatRoute: RouteModule;
  let embedRoute: RouteModule;
  let voiceRoute: RouteModule;
  let rag: typeof import('@/lib/rag');
  let mintVoiceToken: typeof import('@/lib/rag/tenant/voice-token').mintVoiceToken;
  let mintScope: typeof import('@/lib/rag/tenant/scope').mintScope;
  let budgets: PreGenerationBudgets;
  let questions: string[];
  const traceLines: TraceLine[] = [];
  const originalFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const savedEnv = { ...process.env };
  const reports: string[] = [];
  let questionIndex = 0;

  before(async () => {
    const raw = JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8')) as unknown;
    const { LatencyBudgetsSchema } = await import('@/lib/rag-eval/contracts.generated');
    budgets = LatencyBudgetsSchema.parse(raw) as PreGenerationBudgets;
    questions = fs
      .readFileSync(GOLDEN_PATH, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { question: string; language: string; answerable: boolean; conversation: unknown[] })
      .filter((item) => item.language === 'en' && item.answerable && item.conversation.length === 0)
      .map((item) => item.question);
    assert.ok(questions.length >= MEASURED_TURNS + 1, 'the golden set has too few English single-turn questions');

    const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR });
    edge = await startFakeEdge({ db: fixture.db });
    closeDb = () => fixture.db.close();

    const env = process.env as Record<string, string | undefined>;
    for (const name of Object.keys(env)) {
      if (name.startsWith('RAG_') || name.startsWith('NEXT_PUBLIC_RAG_') || name.startsWith('LANGFUSE_')) delete env[name];
    }
    Object.assign(env, loadPinnedEvalEnv());
    Object.assign(env, fixtureProcessEnv(edge.url));
    env.NODE_ENV = 'test';
    env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = 'single-tenant';
    env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    env.NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS = '*';
    env.EMBED_RATE_LIMIT = '100000';
    env.MYRAG_INTERNAL_API_KEY = INTERNAL_API_KEY;
    env.RAG_VOICE_TOKEN_SECRET = VOICE_SECRET;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.split('?')[0] === OPENROUTER_COMPLETIONS) return fakeCompletion();
      return originalFetch(input, init);
    };
    const capture = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === 'string' && first.startsWith('[RAG Trace] ')) {
        try {
          traceLines.push(JSON.parse(first.slice('[RAG Trace] '.length)) as TraceLine);
        } catch {
          // not a trace payload
        }
      }
    };
    console.log = capture;
    console.warn = () => undefined;
    console.error = () => undefined;
    // The chat route arms a five-minute MCP cleanup timer per turn; unref long timers so the test process can exit.
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
      const timer = realSetTimeout(handler as () => void, delay, ...rest);
      return typeof delay === 'number' && delay >= LONG_TIMER_MS ? timer.unref() : timer;
    }) as typeof setTimeout;

    const workStorage = (await import('next/dist/server/app-render/work-async-storage.external.js')) as unknown as Pick<NextScope, 'workAsyncStorage'>;
    const unitStorage = (await import('next/dist/server/app-render/work-unit-async-storage.external.js')) as unknown as Pick<NextScope, 'workUnitAsyncStorage'>;
    const cookies = (await import('next/dist/server/web/spec-extension/cookies.js')) as unknown as Pick<NextScope, 'RequestCookies'>;
    next = { ...workStorage, ...unitStorage, ...cookies };

    // Route modules start module-level intervals (rate limiter, MCP caches); unref those so the test process can exit.
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => realSetInterval(...args).unref()) as typeof setInterval;
    try {
      await importRoutes();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  async function importRoutes(): Promise<void> {
    rag = await import('@/lib/rag');
    ({ mintVoiceToken } = await import('@/lib/rag/tenant/voice-token'));
    ({ mintScope } = await import('@/lib/rag/tenant/scope'));
    chatRoute = (await import('@/app/api/chat/route')) as unknown as RouteModule;
    embedRoute = (await import('@/app/api/embed/chat/route')) as unknown as RouteModule;
    voiceRoute = (await import('@/app/api/internal/voice-rag/route')) as unknown as RouteModule;
  }

  after(async () => {
    rag?.resetPreGenerationDelayForTests();
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = realSetTimeout;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    await edge?.close();
    await closeDb?.().catch(() => undefined);
    const env = process.env as Record<string, string | undefined>;
    for (const name of Object.keys(env)) if (!(name in savedEnv)) delete env[name];
    Object.assign(env, savedEnv);
    for (const report of reports) console.log(report);
  });

  /** Runs a route handler in a request scope without a session; after() tasks run once the response is returned. */
  async function inRequest(handler: () => Promise<Response>): Promise<Response> {
    const tasks: Array<() => unknown> = [];
    const workStore = {
      route: '/api/ttft-gate-test',
      afterContext: {
        after(task: unknown) {
          tasks.push(typeof task === 'function' ? (task as () => unknown) : () => task);
        },
      },
    };
    const requestStore = { type: 'request', phase: 'render', cookies: new next.RequestCookies(new Headers()) };
    const response = await next.workAsyncStorage.run(workStore, () => next.workUnitAsyncStorage.run(requestStore, handler));
    for (const task of tasks) void Promise.resolve().then(task).catch(() => undefined);
    return response;
  }

  function nextQuestion(): string {
    const question = questions[questionIndex % questions.length] as string;
    questionIndex += 1;
    return question;
  }

  /** Reads the body chunk by chunk so the first text delta is timed as the client sees it. */
  async function readBody(response: Response, startedAt: number): Promise<{ body: string; firstTextClientMs: number | null }> {
    assert.ok(response.body, 'the response has no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    let firstTextClientMs: number | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
      if (firstTextClientMs === null && body.includes('"type":"text-delta"')) firstTextClientMs = performance.now() - startedAt;
    }
    return { body, firstTextClientMs };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  }

  /** One text turn; the trace line written when the turn finished carries the route's own timing. */
  async function textTurn(channel: 'chat' | 'embed'): Promise<Turn> {
    const before = traceLines.length;
    const question = nextQuestion();
    const request =
      channel === 'chat'
        ? new Request('http://localhost/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: question }], data: { ragMode: 'balanced', settings: { webSearch: false } } }),
          })
        : new Request('http://localhost/api/embed/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
            body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
          });
    const route = channel === 'chat' ? chatRoute : embedRoute;
    const startedAt = performance.now();
    const response = await inRequest(() => route.POST(request));
    assert.equal(response.status, 200, `${channel} answered ${response.status}`);
    const { body, firstTextClientMs } = await readBody(response, startedAt);
    await settle();
    const line = traceLines.slice(before).find((entry) => entry.profile === channel);
    assert.ok(line, `${channel}: no [RAG Trace] line for the turn`);
    assert.equal(typeof line.pre_generation_ms, 'number', `${channel}: the trace has no pre_generation_ms`);
    return {
      preGenerationMs: line.pre_generation_ms as number,
      ttftMs: typeof line.ttft_ms === 'number' ? line.ttft_ms : null,
      firstTextClientMs,
      body,
    };
  }

  /** D-39: the app's share of voice pre-generation is the voice-rag handler, from receipt to its response. */
  async function voiceTurn(): Promise<number> {
    const minted = mintVoiceToken({ scope: mintScope('single', null, null), secret: VOICE_SECRET, ttlSeconds: 600 });
    if (!minted.ok) throw new Error(`mint failed: ${minted.reason}`);
    const request = new Request('http://localhost/api/internal/voice-rag', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': INTERNAL_API_KEY, 'x-rag-scope-token': minted.token },
      body: JSON.stringify({ query: nextQuestion(), matchCount: 5 }),
    });
    const startedAt = performance.now();
    const response = await inRequest(() => voiceRoute.POST(request));
    await response.text();
    const elapsed = performance.now() - startedAt;
    assert.equal(response.status, 200, `voice-rag answered ${response.status}`);
    return elapsed;
  }

  async function measure(channel: Channel): Promise<{ preGeneration: number[]; turns: Turn[] }> {
    if (channel === 'voice') {
      await voiceTurn();
      const preGeneration: number[] = [];
      for (let i = 0; i < MEASURED_TURNS; i += 1) preGeneration.push(await voiceTurn());
      return { preGeneration, turns: [] };
    }
    await textTurn(channel);
    const turns: Turn[] = [];
    for (let i = 0; i < MEASURED_TURNS; i += 1) turns.push(await textTurn(channel));
    return { preGeneration: turns.map((turn) => turn.preGenerationMs), turns };
  }

  test('check: nearest-rank p95 against the ceiling, at the boundary and above it', () => {
    const local: PreGenerationBudgets = { pre_generation: { chat: { p95_ms: 100 } } };
    const samples = Array.from({ length: 20 }, (_, index) => (index + 1) * 5);
    assert.equal(preGenerationWithinBudget('chat', samples, local).p95, 95);
    assert.equal(preGenerationWithinBudget('chat', samples, local).ok, true);
    assert.equal(preGenerationWithinBudget('chat', [...samples.slice(0, 18), 101, 101], local).ok, false);
    assert.equal(preGenerationWithinBudget('chat', [100], local).ok, true);
    assert.throws(() => preGenerationWithinBudget('embed', samples, local), /no pre_generation p95 budget/);
    assert.throws(() => preGenerationWithinBudget('chat', [], local), /no pre_generation samples/);
    assert.throws(() => preGenerationWithinBudget('chat', [Number.NaN], local), /finite/);
  });

  test('budgets: pre_generation p95 per channel equals the channel total_p95_ms; ttft per channel and cache state', () => {
    const raw = JSON.parse(fs.readFileSync(BUDGETS_PATH, 'utf8')) as {
      profiles: Record<Channel, { total_p95_ms: number }>;
      ttft: Record<Channel, Record<string, { p50_ms: number; p95_ms: number }>>;
    };
    for (const channel of CHANNELS) {
      assert.equal(budgets.pre_generation?.[channel]?.p95_ms, raw.profiles[channel].total_p95_ms, channel);
    }
    for (const channel of ['chat', 'embed'] as const) {
      assert.deepEqual(Object.keys(raw.ttft[channel]).sort(), ['bypass', 'hit', 'miss']);
    }
    assert.deepEqual(Object.keys(raw.ttft.voice), ['bypass']);
  });

  for (const channel of CHANNELS) {
    test(`gate: ${channel} pre-generation p95 is within its budget, one warm-up turn excluded`, { timeout: 60_000 }, async () => {
      const { preGeneration, turns } = await measure(channel);
      const verdict = preGenerationWithinBudget(channel, preGeneration, budgets);
      reports.push(`[TTFT Gate] ${verdict.message}`);
      assert.ok(verdict.ok, verdict.message);
      for (const turn of turns) {
        assert.ok(sseTextDeltas(turn.body).join('').length > 0, `${channel}: the turn streamed no answer text`);
        assert.equal(typeof turn.firstTextClientMs, 'number', `${channel}: the client saw no text delta`);
      }
      for (const turn of turns) {
        assert.equal(typeof turn.ttftMs, 'number', `${channel}: the trace has no ttft_ms`);
        assert.ok((turn.ttftMs as number) >= turn.preGenerationMs, `${channel}: ttft_ms is below pre_generation_ms`);
      }
    });
  }

  for (const channel of ['chat', 'embed'] as const) {
    test(`meta: a delay of the ${channel} budget plus ${META_EXTRA_MS} ms through the test setter fails the same check`, { timeout: 60_000 }, async () => {
      const budget = budgets.pre_generation?.[channel]?.p95_ms as number;
      rag.setPreGenerationDelayForTests(budget + META_EXTRA_MS);
      try {
        const turns: Turn[] = [];
        for (let i = 0; i < 2; i += 1) turns.push(await textTurn(channel));
        const verdict = preGenerationWithinBudget(channel, turns.map((turn) => turn.preGenerationMs), budgets);
        assert.equal(verdict.ok, false, `expected the gate to fail: ${verdict.message}`);
      } finally {
        rag.resetPreGenerationDelayForTests();
      }
      const recovered = await textTurn(channel);
      assert.ok(preGenerationWithinBudget(channel, [recovered.preGenerationMs], budgets).ok, 'the gate still fails after the reset');
    });
  }

  // D-39: voice-rag makes no generator call, so the setter cannot reach it; the same check fails on its samples shifted by the delay.
  test(`meta: voice samples shifted by the budget plus ${META_EXTRA_MS} ms fail the same check`, { timeout: 60_000 }, async () => {
    const budget = budgets.pre_generation?.voice?.p95_ms as number;
    const samples = [await voiceTurn(), await voiceTurn()];
    assert.ok(preGenerationWithinBudget('voice', samples, budgets).ok, 'voice fails before the shift');
    const shifted = samples.map((value) => value + budget + META_EXTRA_MS);
    const verdict = preGenerationWithinBudget('voice', shifted, budgets);
    assert.equal(verdict.ok, false, `expected the gate to fail: ${verdict.message}`);
  });
});
