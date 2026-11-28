import { describe, expect, it, vi } from 'vitest';
import {
  INGEST_RESUME_MAX_ATTEMPTS,
  abortableSleep,
  ingestResumeFetchers,
  needsResume,
  parseResumeBody,
  resumeDelayMs,
  resumeIngestUntilSettled,
  type ResumeCall,
  type StageSnapshot,
} from '@/components/ui/ingest-resume';

const DOC = '00000000-0000-4000-8000-00000000d001';

const processing = (chunkCount = 0, reason: string | null = 'deadline'): ResumeCall => ({ ok: true, snapshot: { status: 'processing', reason, chunkCount } });
const status = (value: string, reason: string | null = null): ResumeCall => ({ ok: true, snapshot: { status: value, reason, chunkCount: 3 } });

function harness(calls: ResumeCall[], stages: Array<StageSnapshot | null> = []) {
  const sleeps: number[] = [];
  const resume = vi.fn(async () => calls.shift() ?? processing());
  const readStage = vi.fn(async () => (stages.length > 0 ? stages.shift() ?? null : null));
  const controller = new AbortController();
  const options = {
    resume,
    readStage,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    signal: controller.signal,
  };
  return { options, resume, sleeps, controller };
}

describe('needsResume', () => {
  it('is true only for a 202 processing answer with a document id and no job', () => {
    expect(needsResume(202, { status: 'processing', documentId: DOC })).toBe(true);
    expect(needsResume(202, { status: 'processing', id: DOC })).toBe(true);
    expect(needsResume(202, { status: 'queued', documentId: DOC, jobId: 'j' })).toBe(false);
    expect(needsResume(202, { status: 'processing', documentId: DOC, jobId: 'j' })).toBe(false);
    expect(needsResume(200, { status: 'ready', documentId: DOC })).toBe(false);
    expect(needsResume(202, { status: 'processing' })).toBe(false);
    expect(needsResume(202, null)).toBe(false);
  });
});

describe('parseResumeBody', () => {
  it('accepts the resume answer and rejects anything without a status', () => {
    expect(parseResumeBody({ status: 'processing', documentId: DOC, chunkCount: 4, reason: 'deadline' })).toEqual({ status: 'processing', reason: 'deadline', chunkCount: 4 });
    expect(parseResumeBody({ status: 'ready' })).toEqual({ status: 'ready', reason: null, chunkCount: 0 });
    expect(parseResumeBody({ chunkCount: 1 })).toBeNull();
    expect(parseResumeBody({ status: 'ready', chunkCount: -1 })).toBeNull();
    expect(parseResumeBody('ready')).toBeNull();
  });
});

describe('resumeIngestUntilSettled', () => {
  it('keeps calling while each call makes progress and returns the settled status', async () => {
    const progress: number[] = [];
    const { options, resume } = harness(
      [processing(0), processing(0), processing(40), status('ready')],
      [{ stage: 'parse', parsePending: false }, { stage: 'images', parsePending: false }, { stage: 'images', parsePending: false }],
    );
    const result = await resumeIngestUntilSettled(DOC, { ...options, onProgress: (p) => progress.push(p.attempt) });
    expect(result).toEqual({ kind: 'settled', status: 'ready', attempts: 4 });
    expect(resume).toHaveBeenCalledTimes(4);
    expect(progress).toEqual([1, 2, 3]);
  });

  it('stops with stalled when calls leave the stage and chunk count unchanged', async () => {
    const same = { stage: 'chunk', parsePending: false };
    const { options, resume, sleeps } = harness([], [same, same, same, same, same]);
    const result = await resumeIngestUntilSettled(DOC, options);
    expect(result).toMatchObject({ kind: 'stalled', reason: 'deadline' });
    expect(resume).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([resumeDelayMs(0), resumeDelayMs(1), resumeDelayMs(2)]);
  });

  it('does not count a pending parse job as a stall, and stops at the attempt limit', async () => {
    const pending = { stage: 'store_original', parsePending: true };
    const { options, resume } = harness([], Array.from({ length: 30 }, () => pending));
    const result = await resumeIngestUntilSettled(DOC, options);
    expect(result).toEqual({ kind: 'exhausted', attempts: INGEST_RESUME_MAX_ATTEMPTS });
    expect(resume).toHaveBeenCalledTimes(INGEST_RESUME_MAX_ATTEMPTS);
  });

  it('reports a failed version with its reason', async () => {
    const { options } = harness([status('failed', 'parse_failed')]);
    expect(await resumeIngestUntilSettled(DOC, options)).toEqual({ kind: 'failed', reason: 'parse_failed', attempts: 1 });
  });

  it('stops at once when the server cannot resume the version', async () => {
    const { options, resume } = harness([processing(0, 'resume_state_missing')]);
    expect(await resumeIngestUntilSettled(DOC, options)).toMatchObject({ kind: 'stalled', reason: 'resume_state_missing' });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('stops on 401, 403 and 404 without retrying', async () => {
    for (const httpStatus of [401, 403, 404]) {
      const { options, resume } = harness([{ ok: false, httpStatus }]);
      expect(await resumeIngestUntilSettled(DOC, options)).toEqual({ kind: 'refused', httpStatus, attempts: 1 });
      expect(resume).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a transient failure and gives up after repeated ones', async () => {
    const recovered = harness([{ ok: false, httpStatus: 503 }, status('ready')]);
    expect(await resumeIngestUntilSettled(DOC, recovered.options)).toMatchObject({ kind: 'settled', attempts: 2 });

    const down = harness([{ ok: false, httpStatus: 503 }, { ok: false, httpStatus: 503 }, { ok: false, httpStatus: 503 }]);
    expect(await resumeIngestUntilSettled(DOC, down.options)).toMatchObject({ kind: 'stalled', reason: 'resume_unavailable', attempts: 3 });

    const thrown = harness([]);
    thrown.resume.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(status('ready'));
    expect(await resumeIngestUntilSettled(DOC, thrown.options)).toMatchObject({ kind: 'settled', attempts: 2 });
  });

  it('stops when the signal aborts, before or during a call or a wait', async () => {
    const before = harness([]);
    before.controller.abort();
    expect(await resumeIngestUntilSettled(DOC, before.options)).toEqual({ kind: 'cancelled', attempts: 0 });
    expect(before.resume).not.toHaveBeenCalled();

    const during = harness([]);
    during.resume.mockImplementationOnce(async () => {
      during.controller.abort();
      return processing();
    });
    expect(await resumeIngestUntilSettled(DOC, during.options)).toEqual({ kind: 'cancelled', attempts: 1 });

    const waiting = harness([]);
    const result = resumeIngestUntilSettled(DOC, { ...waiting.options, sleep: abortableSleep });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    waiting.controller.abort();
    expect(await result).toMatchObject({ kind: 'cancelled' });
  });
});

describe('ingestResumeFetchers', () => {
  it('posts to the resume route with the workspace query and validates both answers', async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/resume')) return new Response(JSON.stringify({ status: 'processing', chunkCount: 2, reason: 'deadline' }), { status: 200 });
      return new Response(JSON.stringify({ status: 'processing', lastCompleted: 'images', warnings: ['parse_pending'] }), { status: 200 });
    }) as unknown as typeof fetch;
    const fetchers = ingestResumeFetchers('?organizationId=org-1', fetchImpl);
    const signal = new AbortController().signal;
    expect(await fetchers.resume(DOC, signal)).toEqual({ ok: true, snapshot: { status: 'processing', reason: 'deadline', chunkCount: 2 } });
    expect(await fetchers.readStage(DOC, signal)).toEqual({ stage: 'images', parsePending: true });
    expect(seen).toEqual([
      { url: `/api/rag/ingest/${DOC}/resume?organizationId=org-1`, method: 'POST' },
      { url: `/api/rag/ingest/${DOC}?organizationId=org-1`, method: 'GET' },
    ]);

    const refusing = ingestResumeFetchers('', (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch);
    expect(await refusing.resume(DOC, signal)).toEqual({ ok: false, httpStatus: 403 });
    const garbled = ingestResumeFetchers('', (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch);
    expect(await garbled.resume(DOC, signal)).toEqual({ ok: false, httpStatus: 0 });
  });
});
