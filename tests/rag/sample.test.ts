import { beforeEach, describe, expect, test, vi } from 'vitest';
import { isSampled } from '@/lib/rag/trace/sample';
import { scheduleAfterResponse } from '@/lib/rag/trace/schedule';

const afterMock = vi.fn<(task: () => Promise<void>) => void>();

vi.mock('next/server', () => ({
  after: (task: () => Promise<void>) => afterMock(task),
}));

const IDS = Array.from({ length: 10000 }, (_, index) => `request-${index}`);

describe('isSampled', () => {
  test('rate 0 is never sampled and rate 1 always is', () => {
    expect(IDS.slice(0, 200).some((id) => isSampled(id, 0))).toBe(false);
    expect(IDS.slice(0, 200).every((id) => isSampled(id, 1))).toBe(true);
  });

  test('the same id always gives the same answer', () => {
    for (const id of IDS.slice(0, 100)) {
      expect(isSampled(id, 0.5)).toBe(isSampled(id, 0.5));
    }
  });

  test('rate 0.1 samples about a tenth of ids', () => {
    const hits = IDS.filter((id) => isSampled(id, 0.1)).length;
    expect(hits / IDS.length).toBeGreaterThan(0.08);
    expect(hits / IDS.length).toBeLessThan(0.12);
  });

  test('invalid rates never sample', () => {
    expect(isSampled('request-1', Number.NaN)).toBe(false);
    expect(isSampled('request-1', -1)).toBe(false);
  });

  test('the review prefix decides independently of the trace prefix', () => {
    const differing = IDS.filter((id) => isSampled(id, 0.5, 'trace') !== isSampled(id, 0.5, 'review')).length;
    expect(differing / IDS.length).toBeGreaterThan(0.4);
    expect(differing / IDS.length).toBeLessThan(0.6);
  });
});

describe('scheduleAfterResponse', () => {
  beforeEach(() => {
    afterMock.mockReset();
  });

  test('hands the task to after() inside a request scope', () => {
    const task = vi.fn(async () => undefined);
    scheduleAfterResponse(task);
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(afterMock.mock.calls[0][0]).toBe(task);
    expect(task).not.toHaveBeenCalled();
  });

  test('runs the task detached when after() throws outside a request scope', async () => {
    afterMock.mockImplementation(() => {
      throw new Error('`after` was called outside a request scope');
    });
    let ran = false;
    expect(() =>
      scheduleAfterResponse(async () => {
        ran = true;
      }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ran).toBe(true);
  });

  test('swallows a rejected task and a synchronously throwing task', async () => {
    afterMock.mockImplementation(() => {
      throw new Error('no scope');
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => scheduleAfterResponse(() => Promise.reject(new Error('boom')))).not.toThrow();
      expect(() =>
        scheduleAfterResponse((() => {
          throw new Error('sync boom');
        }) as () => Promise<void>),
      ).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
