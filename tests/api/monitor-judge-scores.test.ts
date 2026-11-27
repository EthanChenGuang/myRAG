import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = '00000000-0000-4000-8000-0000000029c1';
const TENANT_A = `u:${ADMIN}`;
const BASE = 'http://localhost/api/rag/admin/monitor/judge-scores';

interface State {
  guard: { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503 };
  logTenants: Record<string, string>;
  stored: Array<{ tenant_key: string; trace_id: string; metric: string; score: number; judge_id: string }>;
  calls: Array<{ fn: string; args: Record<string, unknown> }>;
}

let state: State;

const adminClient = {
  from: () => {
    throw new Error('the judge-score route reads no table directly');
  },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    state.calls.push({ fn, args });
    if (fn !== 'rag_online_judge_scores_record') return { data: null, error: { message: 'unexpected rpc' } };
    let stored = 0;
    let dropped = 0;
    for (const item of args.p_scores as Array<Record<string, unknown>>) {
      const tenant = state.logTenants[String(item.trace_id)];
      if (!tenant) {
        dropped += 1;
        continue;
      }
      state.stored.push({
        tenant_key: tenant,
        trace_id: String(item.trace_id),
        metric: String(item.metric),
        score: Number(item.score),
        judge_id: String(item.judge_id),
      });
      stored += 1;
    }
    return { data: [{ stored, dropped }], error: null };
  },
};

async function route() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/admin-route-auth')>();
    return {
      ...actual,
      checkAdmin: async () => (state.guard.ok ? { ok: true, userId: state.guard.userId } : { ok: false, status: state.guard.status, reason: 'denied' }),
    };
  });
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: adminClient, getSupabaseAdmin: () => adminClient, getSupabase: () => ({}) }));
  return import('@/app/api/rag/admin/monitor/judge-scores/route');
}

function post(body: unknown) {
  return new NextRequest(BASE, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder-token' },
  });
}

function score(trace: string, over: Record<string, unknown> = {}) {
  return { trace_id: trace, metric: 'faithfulness', score: 0.75, judge_id: 'example/judge-model', ...over };
}

let savedMonitor: string | undefined;

describe('POST /api/rag/admin/monitor/judge-scores (05.3-29, D-23, D-55)', () => {
  let logs: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    savedMonitor = process.env.RAG_MONITOR;
    process.env.RAG_MONITOR = 'true';
    state = { guard: { ok: true, userId: ADMIN }, logTenants: { 'trace-1': TENANT_A, 'trace-2': TENANT_A }, stored: [], calls: [] };
    logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
  });
  afterEach(() => {
    for (const spy of logs) spy.mockRestore();
    if (savedMonitor === undefined) delete process.env.RAG_MONITOR;
    else process.env.RAG_MONITOR = savedMonitor;
    vi.doUnmock('@/lib/admin-route-auth');
    vi.doUnmock('@/lib/supabase');
  });

  it('stores scores of known traces under the tenant of their log row and counts the unknown ones as dropped', async () => {
    const { POST } = await route();
    const response = await POST(
      post({ scores: [score('trace-1'), score('trace-2', { metric: 'answer_relevance', score: 1 }), score('trace-unknown', { score: 0 })] }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ stored: 2, dropped: 1 });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].args).toEqual({
      p_scores: [score('trace-1'), score('trace-2', { metric: 'answer_relevance', score: 1 }), score('trace-unknown', { score: 0 })],
    });
    expect(state.stored.every((row) => row.tenant_key === TENANT_A)).toBe(true);
  });

  it('refuses a body naming a tenant key, at the top or on a score, and writes nothing', async () => {
    const { POST } = await route();
    expect((await POST(post({ tenant_key: 'u:00000000-0000-4000-8000-000000000bad', scores: [score('trace-1')] }))).status).toBe(400);
    expect((await POST(post({ scores: [score('trace-1', { tenant_key: TENANT_A })] }))).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it.each([
    ['more than 500 scores', { scores: Array.from({ length: 501 }, (_, i) => score(`trace-${i}`)) }],
    ['a score above 1', { scores: [score('trace-1', { score: 1.01 })] }],
    ['a score below 0', { scores: [score('trace-1', { score: -0.01 })] }],
    ['an unknown metric', { scores: [score('trace-1', { metric: 'free_text' })] }],
    ['a malformed trace id', { scores: [score('trace 1')] }],
    ['a malformed judge id', { scores: [score('trace-1', { judge_id: ' spaced judge' })] }],
    ['a text field', { scores: [score('trace-1', { comment: 'free text' })] }],
    ['no scores', { scores: [] }],
    ['a body that is not JSON', '{not json'],
  ])('answers 400 for %s', async (_name, body) => {
    const { POST } = await route();
    expect((await POST(post(body))).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it('RAG_MONITOR off answers 404 before the admin check; a denied caller gets the guard status', async () => {
    process.env.RAG_MONITOR = 'false';
    state.guard = { ok: false, status: 401 };
    const off = await route();
    expect((await off.POST(post({ scores: [score('trace-1')] }))).status).toBe(404);
    process.env.RAG_MONITOR = 'true';
    const on = await route();
    expect((await on.POST(post({ scores: [score('trace-1')] }))).status).toBe(401);
    expect(state.calls).toEqual([]);
  });
});
