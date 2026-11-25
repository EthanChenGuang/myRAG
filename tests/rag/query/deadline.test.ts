import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_DEADLINE_CAP_MS,
  groupDeadlineMs,
  groupDeadlineSignal,
  QUERY_BUDGET_MS,
  transformAbortReason,
  transformSignal,
} from '@/lib/rag/query/deadline';

describe('groupDeadlineMs (A-7)', () => {
  it('is min(900, budget - cache timeout - elapsed since the gate start) for chat', () => {
    expect(groupDeadlineMs({ profile: 'chat', elapsedMs: 600, cacheTimeoutMs: 150 })).toBe(450);
    expect(groupDeadlineMs({ profile: 'chat', elapsedMs: 100, cacheTimeoutMs: 150 })).toBe(900);
    expect(groupDeadlineMs({ profile: 'chat', elapsedMs: 1100, cacheTimeoutMs: 150 })).toBe(0);
  });

  it('uses the same 1.2 s budget for embed', () => {
    expect(QUERY_BUDGET_MS.embed).toBe(1200);
    expect(groupDeadlineMs({ profile: 'embed', elapsedMs: 600, cacheTimeoutMs: 150 })).toBe(450);
  });

  it('caps at 900 ms', () => {
    expect(GROUP_DEADLINE_CAP_MS).toBe(900);
    expect(groupDeadlineMs({ profile: 'chat', elapsedMs: 0, cacheTimeoutMs: 0 })).toBe(900);
  });

  it('returns null for voice: voice runs no parallel group', () => {
    expect(groupDeadlineMs({ profile: 'voice', elapsedMs: 0, cacheTimeoutMs: 0 })).toBeNull();
  });

  it('returns null for eval (no timeouts, D-27) and media (no query layer)', () => {
    expect(groupDeadlineMs({ profile: 'eval', elapsedMs: 0, cacheTimeoutMs: 0 })).toBeNull();
    expect(groupDeadlineMs({ profile: 'media', elapsedMs: 0, cacheTimeoutMs: 0 })).toBeNull();
  });

  it('accepts a budget override from QueryParams', () => {
    expect(groupDeadlineMs({ profile: 'chat', elapsedMs: 200, cacheTimeoutMs: 150, queryBudgetMs: 1000 })).toBe(650);
  });

  it('treats a cache that is off as zero cache time and never returns a negative or fractional value', () => {
    expect(groupDeadlineMs({ profile: 'chat', elapsedMs: 700.6, cacheTimeoutMs: 0 })).toBe(499);
    expect(groupDeadlineMs({ profile: 'chat', elapsedMs: 5000, cacheTimeoutMs: 150 })).toBe(0);
    expect(groupDeadlineMs({ profile: 'chat', elapsedMs: Number.NaN, cacheTimeoutMs: 150 })).toBe(0);
  });
});

describe('transformSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts with reason timeout when the per-transform timeout fires', () => {
    const request = new AbortController();
    const group = groupDeadlineSignal(900);
    const signal = transformSignal(request.signal, group, 600);
    vi.advanceTimersByTime(599);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect(transformAbortReason(request.signal, signal)).toBe('timeout');
  });

  it('aborts with reason timeout when the group deadline fires first', () => {
    const request = new AbortController();
    const group = groupDeadlineSignal(450);
    const signal = transformSignal(request.signal, group, 900);
    vi.advanceTimersByTime(450);
    expect(signal.aborted).toBe(true);
    expect(transformAbortReason(request.signal, signal)).toBe('timeout');
  });

  it('aborts with reason aborted when the request signal aborts', () => {
    const request = new AbortController();
    const signal = transformSignal(request.signal, groupDeadlineSignal(900), 600);
    vi.advanceTimersByTime(100);
    request.abort();
    expect(signal.aborted).toBe(true);
    expect(transformAbortReason(request.signal, signal)).toBe('aborted');
  });

  it('reports aborted when the request is cancelled even after a timeout', () => {
    const request = new AbortController();
    const signal = transformSignal(request.signal, null, 100);
    vi.advanceTimersByTime(100);
    request.abort();
    expect(transformAbortReason(request.signal, signal)).toBe('aborted');
  });

  it('reports null while nothing has aborted', () => {
    const request = new AbortController();
    const signal = transformSignal(request.signal, null, 100);
    expect(transformAbortReason(request.signal, signal)).toBeNull();
  });

  it('a zero group deadline aborts at once', () => {
    const request = new AbortController();
    const signal = transformSignal(request.signal, groupDeadlineSignal(0), 600);
    vi.advanceTimersByTime(0);
    expect(signal.aborted).toBe(true);
    expect(transformAbortReason(request.signal, signal)).toBe('timeout');
  });

  it('has no group and no timeout when both are null (eval)', () => {
    const request = new AbortController();
    const signal = transformSignal(request.signal, groupDeadlineSignal(null), null);
    vi.advanceTimersByTime(60_000);
    expect(signal.aborted).toBe(false);
    request.abort();
    expect(signal.aborted).toBe(true);
  });

  it('an already-aborted request yields an aborted signal', () => {
    const request = new AbortController();
    request.abort();
    const signal = transformSignal(request.signal, groupDeadlineSignal(900), 600);
    expect(signal.aborted).toBe(true);
    expect(transformAbortReason(request.signal, signal)).toBe('aborted');
  });
});
