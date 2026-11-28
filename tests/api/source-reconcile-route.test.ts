import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const runSourceReconcile = vi.hoisted(() => vi.fn());

vi.mock('@/lib/nango/reconcile', () => ({ runSourceReconcile }));

import { POST, maxDuration } from '@/app/api/internal/rag/source-reconcile/route';

const SECRET = 'route-secret-for-unit-tests-000000';
const HEADER = 'x-sidecar-secret';
const COUNTS = {
  processed: 1,
  removed: 2,
  paused: 0,
  incomplete: 0,
  failed: 0,
  skipped: 0,
  overdue: 0,
  purgeRetried: 1,
  purgeStillPending: 0,
  purgeRescrubbed: 2,
  purgeSkipped: 0,
  purgeFailed: 0,
};

function request(options: { secret?: string; body?: string } = {}): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.secret !== undefined) headers.set(HEADER, options.secret);
  return new NextRequest('http://localhost/api/internal/rag/source-reconcile', {
    method: 'POST',
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

describe('POST /api/internal/rag/source-reconcile (D-30, D-42)', () => {
  const saved = process.env.RAG_SIDECAR_SECRET;

  beforeEach(() => {
    runSourceReconcile.mockReset();
    runSourceReconcile.mockResolvedValue({ ...COUNTS });
    process.env.RAG_SIDECAR_SECRET = SECRET;
    for (const level of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.RAG_SIDECAR_SECRET;
    else process.env.RAG_SIDECAR_SECRET = saved;
    vi.restoreAllMocks();
  });

  it('answers 401 without the header, with a wrong, a near-miss or an upper-cased secret, and never runs the job', async () => {
    for (const secret of [undefined, 'wrong', SECRET.slice(0, -1), `${SECRET}0`, SECRET.toUpperCase()]) {
      const response = await POST(request(secret === undefined ? {} : { secret }));
      expect(response.status).toBe(401);
    }
    expect(runSourceReconcile).not.toHaveBeenCalled();
  });

  it('refuses every request while RAG_SIDECAR_SECRET is unset', async () => {
    delete process.env.RAG_SIDECAR_SECRET;
    for (const secret of [undefined, '', SECRET]) {
      const response = await POST(request(secret === undefined ? {} : { secret }));
      expect(response.status).toBe(401);
    }
    expect(runSourceReconcile).not.toHaveBeenCalled();
  });

  it('runs the job once within maxDuration and answers no-store counts', async () => {
    const response = await POST(request({ secret: SECRET }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, ...COUNTS });
    expect(runSourceReconcile).toHaveBeenCalledTimes(1);
    const [options] = runSourceReconcile.mock.calls[0] as [{ deadlineMs: number; connectionId?: string; signal?: AbortSignal }];
    expect(options.deadlineMs).toBeGreaterThan(0);
    expect(options.deadlineMs).toBeLessThan(maxDuration * 1000);
    expect(options.connectionId).toBeUndefined();
    expect(options.signal).toBeDefined();
  });

  it('passes a connection_id filter from the body', async () => {
    const id = '00000000-0000-4000-8000-00000000c002';
    const response = await POST(request({ secret: SECRET, body: JSON.stringify({ connection_id: id }) }));
    expect(response.status).toBe(200);
    expect(runSourceReconcile).toHaveBeenCalledWith(expect.objectContaining({ connectionId: id }));
  });

  it('answers 400 for a connection_id that is not a uuid, an unknown field or malformed JSON', async () => {
    for (const body of [JSON.stringify({ connection_id: 'conn-1' }), JSON.stringify({ tenant_key: 's:default' }), '{not json']) {
      const response = await POST(request({ secret: SECRET, body }));
      expect(response.status).toBe(400);
    }
    expect(runSourceReconcile).not.toHaveBeenCalled();
  });

  it('answers 503 reconcile_unavailable when the job throws', async () => {
    runSourceReconcile.mockRejectedValue(new Error('database down'));
    const response = await POST(request({ secret: SECRET }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'reconcile_unavailable' });
  });
});
