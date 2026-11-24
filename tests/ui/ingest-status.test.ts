import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_INGEST_JOB_STATE,
  createIngestJobTracker,
  ingestJobPollDelayMs,
  ingestRealtimeTopic,
  isTerminalIngestStatus,
  type IngestJobState,
  type IngestRealtimeChannelLike,
  type IngestRealtimeClientLike,
} from '@/lib/hooks/use-ingest-job-status';
import { IngestStatusBadge } from '@/components/ui/ingest-status-badge';
import { describeIngestStatus } from '@/components/ui/ingest-status-labels';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_JOB_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

function pollBody(status: string, extra: Partial<IngestJobState> = {}): Response {
  return new Response(
    JSON.stringify({
      jobId: JOB_ID,
      documentId: null,
      status,
      stage: extra.stage ?? null,
      provisional: extra.provisional ?? false,
      needsReview: extra.needsReview ?? status === 'needs_review',
      reason: extra.reason ?? null,
      updatedAt: '2026-11-24T10:00:00.000Z',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

type Step = Response | Error | 'hang';

function scriptedFetch(steps: Step[]) {
  const calls: Array<{ url: string; at: number; signal: AbortSignal | undefined }> = [];
  let index = 0;
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), at: Date.now(), signal: init?.signal ?? undefined });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (step instanceof Error) throw step;
    return (step as Response).clone();
  });
  return { impl: impl as unknown as typeof fetch, calls, spy: impl };
}

function gaps(calls: Array<{ at: number }>): number[] {
  return calls.slice(1).map((call, i) => call.at - (calls[i] as { at: number }).at);
}

function startTracker(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createIngestJobTracker>[0]> = {}) {
  const updates: IngestJobState[] = [];
  const tracker = createIngestJobTracker({
    jobId: JOB_ID,
    onUpdate: (state) => updates.push(state),
    fetchImpl,
    ...extra,
  });
  tracker.start();
  return { tracker, updates };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('poll cadence', () => {
  it('uses 2 s before 60 s elapsed and 10 s afterwards', () => {
    expect(ingestJobPollDelayMs(0)).toBe(2000);
    expect(ingestJobPollDelayMs(59_999)).toBe(2000);
    expect(ingestJobPollDelayMs(60_000)).toBe(10_000);
    expect(ingestJobPollDelayMs(600_000)).toBe(10_000);
  });

  it('doubles the delay after consecutive errors and caps it at 10 s', () => {
    expect(ingestJobPollDelayMs(0, 1)).toBe(4000);
    expect(ingestJobPollDelayMs(0, 2)).toBe(8000);
    expect(ingestJobPollDelayMs(0, 3)).toBe(10_000);
    expect(ingestJobPollDelayMs(120_000, 1)).toBe(10_000);
  });

  it('polls every 2 s for the first minute, then every 10 s', async () => {
    const fetcher = scriptedFetch([pollBody('parsing')]);
    const { tracker } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(80_000);
    tracker.stop();
    const g = gaps(fetcher.calls);
    expect(g.slice(0, 30)).toEqual(Array(30).fill(2000));
    expect(g.slice(30)).toEqual([10_000, 10_000]);
    expect(fetcher.calls[0]?.url).toBe(`/api/rag/ingest/jobs/${JOB_ID}`);
  });

  it('sends the organization id as a query parameter when one is selected', async () => {
    const fetcher = scriptedFetch([pollBody('ready')]);
    startTracker(fetcher.impl, { organizationId: ORG_ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.calls[0]?.url).toBe(`/api/rag/ingest/jobs/${JOB_ID}?organizationId=${ORG_ID}`);
  });
});

describe('stop conditions', () => {
  it('stops polling once the job is ready and reports the final state', async () => {
    const fetcher = scriptedFetch([pollBody('parsing'), pollBody('embedding', { stage: 'embedding' }), pollBody('ready')]);
    const { updates } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher.calls).toHaveLength(3);
    expect(updates.at(-1)?.status).toBe('ready');
  });

  it.each(['ready', 'failed', 'needs_review', 'quarantined', 'skipped_duplicate'])('stops at %s after the first poll', async (status) => {
    expect(isTerminalIngestStatus(status)).toBe(true);
    const fetcher = scriptedFetch([pollBody(status)]);
    const { updates } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.calls).toHaveLength(1);
    expect(updates.at(-1)?.status).toBe(status);
  });

  it.each(['queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding'])('keeps polling at %s', (status) => {
    expect(isTerminalIngestStatus(status)).toBe(false);
  });

  it('carries needsReview and the reason code of a needs_review job', async () => {
    const fetcher = scriptedFetch([pollBody('needs_review', { reason: 'low_confidence_ocr' })]);
    const { updates } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.at(-1)).toMatchObject({ status: 'needs_review', needsReview: true, reason: 'low_confidence_ocr' });
  });

  it('carries the provisional flag while the job is still running', async () => {
    const fetcher = scriptedFetch([pollBody('parsing', { provisional: true }), pollBody('ready')]);
    const { updates } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.at(-1)).toMatchObject({ status: 'parsing', provisional: true });
  });

  it('aborts the in-flight request on stop and never polls again', async () => {
    const fetcher = scriptedFetch(['hang']);
    const { tracker, updates } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.calls).toHaveLength(1);
    expect(fetcher.calls[0]?.signal?.aborted).toBe(false);
    tracker.stop();
    expect(fetcher.calls[0]?.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.calls).toHaveLength(1);
    expect(updates).toHaveLength(0);
  });

  it('reports not_found and stops on a 404', async () => {
    const fetcher = scriptedFetch([new Response('{}', { status: 404 })]);
    const { updates } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.calls).toHaveLength(1);
    expect(updates.at(-1)?.status).toBe('not_found');
  });

  it('keeps polling with backoff through network errors and 503s', async () => {
    const fetcher = scriptedFetch([
      new TypeError('fetch failed'),
      new Response('{}', { status: 503 }),
      new TypeError('fetch failed'),
      pollBody('ready'),
    ]);
    const { updates } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(gaps(fetcher.calls)).toEqual([4000, 8000, 10_000]);
    expect(updates.at(-1)?.status).toBe('ready');
    expect(updates.some((u) => u.status === 'not_found')).toBe(false);
  });

  it('does not retry a rejected session', async () => {
    const fetcher = scriptedFetch([new Response('{}', { status: 401 })]);
    const { updates } = startTracker(fetcher.impl);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.calls).toHaveLength(1);
    expect(updates.at(-1)?.status).toBe('unavailable');
  });
});

describe('ingestRealtimeTopic', () => {
  it('uses s:default in single-tenant mode', () => {
    expect(ingestRealtimeTopic({ deploymentMode: 'single-tenant', organizationId: ORG_ID, userId: USER_ID })).toBe('rag-ingest:s:default');
  });

  it('uses o:<organization> when an organization is selected in multi-tenant mode', () => {
    expect(ingestRealtimeTopic({ deploymentMode: 'multi-tenant', organizationId: ORG_ID, userId: USER_ID })).toBe(`rag-ingest:o:${ORG_ID}`);
  });

  it('uses u:<user> without an organization in multi-tenant mode', () => {
    expect(ingestRealtimeTopic({ deploymentMode: 'multi-tenant', organizationId: null, userId: USER_ID })).toBe(`rag-ingest:u:${USER_ID}`);
  });

  it('has no topic without an organization or user in multi-tenant mode', () => {
    expect(ingestRealtimeTopic({ deploymentMode: 'multi-tenant', organizationId: null, userId: null })).toBeNull();
  });
});

type BroadcastListener = (message: { payload?: unknown }) => void;

function fakeRealtime(userId: string | null = USER_ID) {
  const channels: Array<{
    topic: string;
    options: unknown;
    listeners: BroadcastListener[];
    statusCallback?: (status: string) => void;
    removed: boolean;
  }> = [];
  const client: IngestRealtimeClientLike = {
    channel: vi.fn((topic: string, options: { config: { private: boolean } }) => {
      const record = { topic, options, listeners: [] as BroadcastListener[], removed: false } as (typeof channels)[number];
      channels.push(record);
      const channel: IngestRealtimeChannelLike = {
        on(_type, _filter, callback) {
          record.listeners.push(callback);
          return channel;
        },
        subscribe(callback) {
          record.statusCallback = callback;
          return channel;
        },
      };
      (record as unknown as { channel: IngestRealtimeChannelLike }).channel = channel;
      return channel;
    }),
    removeChannel: vi.fn((channel: IngestRealtimeChannelLike) => {
      const record = channels.find((c) => (c as unknown as { channel: unknown }).channel === channel);
      if (record) record.removed = true;
    }),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: userId ? { user: { id: userId } } : null } })),
    },
  };
  const emit = (topicIndex: number, payload: unknown) => {
    for (const listener of channels[topicIndex]?.listeners ?? []) listener({ payload });
  };
  return { client, channels, emit };
}

describe('Realtime gating', () => {
  it('never opens a channel when the switch is off', async () => {
    const rt = fakeRealtime();
    const getClient = vi.fn(() => rt.client);
    const fetcher = scriptedFetch([pollBody('parsing')]);
    const { tracker } = startTracker(fetcher.impl, {
      realtime: { enabled: false, deploymentMode: 'single-tenant', getClient },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    tracker.stop();
    expect(getClient).not.toHaveBeenCalled();
    expect(rt.client.channel).not.toHaveBeenCalled();
  });

  it('subscribes to the private o:<organization> channel when enabled', async () => {
    const rt = fakeRealtime();
    const fetcher = scriptedFetch([pollBody('parsing')]);
    const { tracker } = startTracker(fetcher.impl, {
      organizationId: ORG_ID,
      realtime: { enabled: true, deploymentMode: 'multi-tenant', getClient: () => rt.client },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.client.channel).toHaveBeenCalledTimes(1);
    expect(rt.channels[0]?.topic).toBe(`rag-ingest:o:${ORG_ID}`);
    expect(rt.channels[0]?.options).toEqual({ config: { private: true } });
    tracker.stop();
    expect(rt.client.removeChannel).toHaveBeenCalledTimes(1);
  });

  it('uses the session user id for the topic when no organization is selected', async () => {
    const rt = fakeRealtime();
    const fetcher = scriptedFetch([pollBody('parsing')]);
    startTracker(fetcher.impl, {
      realtime: { enabled: true, deploymentMode: 'multi-tenant', getClient: () => rt.client },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels.map((c) => c.topic)).toEqual([`rag-ingest:u:${USER_ID}`]);
  });

  it('opens no channel without a session user in multi-tenant personal mode', async () => {
    const rt = fakeRealtime(null);
    const fetcher = scriptedFetch([pollBody('parsing')]);
    startTracker(fetcher.impl, {
      realtime: { enabled: true, deploymentMode: 'multi-tenant', getClient: () => rt.client },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.client.channel).not.toHaveBeenCalled();
  });

  it('subscribes to s:default in single-tenant mode', async () => {
    const rt = fakeRealtime();
    const fetcher = scriptedFetch([pollBody('parsing')]);
    startTracker(fetcher.impl, {
      realtime: { enabled: true, deploymentMode: 'single-tenant', getClient: () => rt.client },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.channels.map((c) => c.topic)).toEqual(['rag-ingest:s:default']);
  });

  it('updates on a broadcast for its job and ignores another job', async () => {
    const rt = fakeRealtime();
    const fetcher = scriptedFetch([pollBody('queued')]);
    const { updates, tracker } = startTracker(fetcher.impl, {
      realtime: { enabled: true, deploymentMode: 'single-tenant', getClient: () => rt.client },
    });
    await vi.advanceTimersByTimeAsync(0);
    const before = updates.length;
    rt.emit(0, { job_id: OTHER_JOB_ID, document_id: null, status: 'ready', stage: null, provisional: false });
    expect(updates).toHaveLength(before);
    rt.emit(0, { job_id: JOB_ID, document_id: null, status: 'embedding', stage: 'embedding', provisional: true });
    expect(updates.at(-1)).toMatchObject({ status: 'embedding', stage: 'embedding', provisional: true });
    tracker.stop();
  });

  it('ignores malformed broadcast payloads', async () => {
    const rt = fakeRealtime();
    const fetcher = scriptedFetch([pollBody('queued')]);
    const { updates, tracker } = startTracker(fetcher.impl, {
      realtime: { enabled: true, deploymentMode: 'single-tenant', getClient: () => rt.client },
    });
    await vi.advanceTimersByTimeAsync(0);
    const before = updates.length;
    rt.emit(0, null);
    rt.emit(0, 'ready');
    rt.emit(0, { job_id: JOB_ID });
    rt.emit(0, { job_id: JOB_ID, status: 42 });
    expect(updates).toHaveLength(before);
    tracker.stop();
  });

  it('confirms a terminal broadcast with one immediate poll', async () => {
    const rt = fakeRealtime();
    const fetcher = scriptedFetch([pollBody('embedding'), pollBody('needs_review', { reason: 'low_confidence_ocr' })]);
    const { updates } = startTracker(fetcher.impl, {
      realtime: { enabled: true, deploymentMode: 'single-tenant', getClient: () => rt.client },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.calls).toHaveLength(1);
    rt.emit(0, { job_id: JOB_ID, document_id: null, status: 'needs_review', stage: null, provisional: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher.calls).toHaveLength(2);
    expect(updates.at(-1)).toMatchObject({ status: 'needs_review', reason: 'low_confidence_ocr' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.calls).toHaveLength(2);
  });

  it('keeps polling when the subscription is denied and drops the channel', async () => {
    const rt = fakeRealtime();
    const fetcher = scriptedFetch([pollBody('parsing')]);
    const { tracker } = startTracker(fetcher.impl, {
      realtime: { enabled: true, deploymentMode: 'single-tenant', getClient: () => rt.client },
    });
    await vi.advanceTimersByTimeAsync(0);
    rt.channels[0]?.statusCallback?.('CHANNEL_ERROR');
    expect(rt.client.removeChannel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher.calls.length).toBeGreaterThanOrEqual(3);
    tracker.stop();
  });

  it('shares one channel between trackers of the same topic and closes it with the last one', async () => {
    const rt = fakeRealtime();
    const fetcher = scriptedFetch([pollBody('parsing')]);
    const realtime = { enabled: true, deploymentMode: 'single-tenant' as const, getClient: () => rt.client };
    const first = startTracker(fetcher.impl, { realtime });
    const second = startTracker(fetcher.impl, { jobId: OTHER_JOB_ID, realtime });
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.client.channel).toHaveBeenCalledTimes(1);
    first.tracker.stop();
    expect(rt.client.removeChannel).not.toHaveBeenCalled();
    second.tracker.stop();
    expect(rt.client.removeChannel).toHaveBeenCalledTimes(1);
  });
});

describe('IngestStatusBadge', () => {
  const render = (state: Partial<IngestJobState>, language: string) =>
    renderToStaticMarkup(createElement(IngestStatusBadge, { state: { ...INITIAL_INGEST_JOB_STATE, ...state }, language }));

  it.each([
    ['en', 'ready', 'Ready'],
    ['zh', 'ready', '已就绪'],
    ['it', 'ready', 'Pronto'],
    ['en', 'needs_review', 'Needs review'],
    ['zh', 'needs_review', '需要审核'],
    ['it', 'needs_review', 'Da rivedere'],
    ['en', 'failed', 'Failed'],
    ['zh', 'failed', '失败'],
    ['it', 'failed', 'Non riuscito'],
  ])('renders %s label for %s with an accessible name', (language, status, label) => {
    const html = render({ status, needsReview: status === 'needs_review' }, language);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(label);
  });

  it.each([
    ['en', 'Searchable, still improving'],
    ['zh', '可搜索，仍在优化'],
    ['it', 'Ricercabile, ancora in miglioramento'],
  ])('shows the provisional text in %s while the job is still running', (language, text) => {
    const html = render({ status: 'parsing', provisional: true }, language);
    expect(html).toContain(`aria-label="${text}"`);
  });

  it('shows Ready, not the provisional text, once the final version is published', () => {
    const html = render({ status: 'ready', provisional: true }, 'en');
    expect(html).toContain('aria-label="Ready"');
    expect(html).not.toContain('still improving');
  });

  it('falls back to English for an unknown UI language', () => {
    expect(describeIngestStatus({ ...INITIAL_INGEST_JOB_STATE, status: 'ready' }, 'xx').label).toBe('Ready');
  });

  it('labels each in-flight stage distinctly from queued', () => {
    const labels = ['queued', 'preflight', 'parsing', 'checking', 'chunking', 'embedding'].map(
      (status) => describeIngestStatus({ ...INITIAL_INGEST_JOB_STATE, status }, 'en').label,
    );
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });
});
