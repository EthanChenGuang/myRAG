import { APICallError } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  errorStatusOf,
  fallbackReasonFor,
  firstTokenGate,
  type GatePart,
} from '@/lib/rag/generation/citations/fallback';

type Part = GatePart & Record<string, unknown>;

function streamOf(parts: Part[], options: { hang?: boolean } = {}) {
  let cancelled = false;
  const stream = new ReadableStream<Part>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      if (!options.hang) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

/** A stream whose parts are pushed by the test. */
function manualStream() {
  let controller!: ReadableStreamDefaultController<Part>;
  let cancelled = false;
  const stream = new ReadableStream<Part>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, push: (part: Part) => controller.enqueue(part), close: () => controller.close(), cancelled: () => cancelled };
}

async function drain(stream: ReadableStream<Part>): Promise<Part[]> {
  const out: Part[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

const START: Part = { type: 'start' };
const REASONING: Part[] = [
  { type: 'start-step' },
  { type: 'reasoning-start', id: 'r1' },
  { type: 'reasoning-delta', id: 'r1', delta: 'thinking' },
  { type: 'reasoning-end', id: 'r1' },
];
const TEXT: Part[] = [
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Hello ' },
  { type: 'text-delta', id: 't1', delta: '[S1].' },
  { type: 'text-end', id: 't1' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

describe('firstTokenGate (D-10)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replays every buffered part in order, then the rest unchanged', async () => {
    const parts = [START, ...REASONING, ...TEXT];
    const abort = vi.fn();
    const result = await firstTokenGate(streamOf(parts).stream, { errorStatus: () => null, abort });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(await drain(result.stream)).toEqual(parts);
    expect(abort).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'status_401'],
    [400, 'status_400'],
    [404, 'status_404'],
    [429, 'status_429'],
    [503, 'status_5xx'],
    [500, 'status_5xx'],
    [529, 'status_5xx'],
    [null, 'error'],
    [403, 'error'],
  ] as const)('an error before any text with status %s falls back with %s', async (status, reason) => {
    const source = streamOf([START, { type: 'start-step' }, { type: 'error', errorText: 'secret provider detail' }, { type: 'finish' }]);
    const abort = vi.fn();
    const result = await firstTokenGate(source.stream, { errorStatus: () => status, abort });
    expect(result).toEqual({ kind: 'fallback', reason });
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it('a finish with no text and a refusal finish reason falls back with refusal', async () => {
    const source = streamOf([START, { type: 'start-step' }, { type: 'finish-step' }, { type: 'finish', finishReason: 'content-filter' }]);
    const result = await firstTokenGate(source.stream, { errorStatus: () => null, abort: vi.fn() });
    expect(result).toEqual({ kind: 'fallback', reason: 'refusal' });
  });

  it('a finish with no text for another reason is replayed, not a fallback', async () => {
    const parts: Part[] = [START, { type: 'finish', finishReason: 'stop' }];
    const result = await firstTokenGate(streamOf(parts).stream, { errorStatus: () => null, abort: vi.fn() });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(await drain(result.stream)).toEqual(parts);
  });

  it('no first token within the timeout falls back with timeout and aborts the direct call', async () => {
    vi.useFakeTimers();
    const source = manualStream();
    source.push(START);
    const abort = vi.fn();
    const pending = firstTokenGate(source.stream, { timeoutMs: 8000, errorStatus: () => null, abort });
    await vi.advanceTimersByTimeAsync(7999);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toEqual({ kind: 'fallback', reason: 'timeout' });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(source.cancelled()).toBe(true);
  });

  it('uses 8 s as the default timeout', async () => {
    vi.useFakeTimers();
    const source = manualStream();
    const abort = vi.fn();
    const pending = firstTokenGate(source.stream, { errorStatus: () => null, abort });
    await vi.advanceTimersByTimeAsync(7990);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toEqual({ kind: 'fallback', reason: 'timeout' });
  });

  it('a first text delta in time clears the timer', async () => {
    vi.useFakeTimers();
    const source = manualStream();
    const abort = vi.fn();
    const pending = firstTokenGate(source.stream, { timeoutMs: 8000, errorStatus: () => null, abort });
    source.push(START);
    source.push({ type: 'text-start', id: 't1' });
    source.push({ type: 'text-delta', id: 't1', delta: 'Hi' });
    const result = await pending;
    expect(result.kind).toBe('ok');
    await vi.advanceTimersByTimeAsync(20000);
    expect(abort).not.toHaveBeenCalled();
    source.push({ type: 'text-end', id: 't1' });
    source.close();
    if (result.kind === 'ok') expect((await drain(result.stream)).map((part) => part.type)).toEqual(['start', 'text-start', 'text-delta', 'text-end']);
  });

  it('an error after the first text delta is forwarded, not a fallback', async () => {
    const parts: Part[] = [START, { type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'Part' }, { type: 'error', errorText: 'late' }];
    const abort = vi.fn();
    const result = await firstTokenGate(streamOf(parts).stream, { errorStatus: () => 500, abort });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(await drain(result.stream)).toEqual(parts);
    expect(abort).not.toHaveBeenCalled();
  });

  it('cancelling the gated stream cancels the source', async () => {
    const source = manualStream();
    source.push({ type: 'text-delta', id: 't1', delta: 'x' });
    const result = await firstTokenGate(source.stream, { errorStatus: () => null, abort: vi.fn() });
    if (result.kind !== 'ok') throw new Error('expected ok');
    await result.stream.cancel();
    expect(source.cancelled()).toBe(true);
  });
});

describe('fallback reasons', () => {
  it('reads the status of an APICallError and of plain objects', () => {
    const error = new APICallError({ message: 'rate limited', url: 'http://x/v1/messages', requestBodyValues: {}, statusCode: 429 });
    expect(errorStatusOf(error)).toBe(429);
    expect(errorStatusOf({ statusCode: 404 })).toBe(404);
    expect(errorStatusOf({ status: 401 })).toBe(401);
    expect(errorStatusOf(new Error('x'))).toBeNull();
    expect(errorStatusOf(undefined)).toBeNull();
  });

  it('maps statuses to reasons', () => {
    expect(fallbackReasonFor(400)).toBe('status_400');
    expect(fallbackReasonFor(401)).toBe('status_401');
    expect(fallbackReasonFor(404)).toBe('status_404');
    expect(fallbackReasonFor(429)).toBe('status_429');
    expect(fallbackReasonFor(502)).toBe('status_5xx');
    expect(fallbackReasonFor(418)).toBe('error');
    expect(fallbackReasonFor(null)).toBe('error');
  });
});
