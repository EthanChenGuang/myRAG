import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Plan 03.2-19 task 3 (D-11, D-12, UI-SPEC 8.1 and 8.2): the rebuild routes are deployment-admin only, take the mechanism and nothing else,
// list the rebuild rows on the coverage answer and map the SQL refusals of activation and rollback to 409 with a reason.

type Row = Record<string, unknown>;
type RpcOutcome = { data: unknown; error: { code?: string; message: string } | null };

const RUN_ID = '00000000-0000-4000-8000-00000000ab01';
const RUN_ROW: Row = {
  id: RUN_ID,
  mechanism: 'reparse',
  activation: 'rebuild_batch',
  state: 'complete',
  total: 3,
  done: 3,
  gaps: 0,
  plan: { kind: 'held_batch', affected: 3 },
  evidence_passed: true,
  started_at: '2026-11-25T10:00:00Z',
  activated_at: null,
  rolled_back_at: null,
};

const state = {
  admin: { ok: true, userId: 'admin-1' } as { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503; reason: string },
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  handlers: {} as Record<string, () => RpcOutcome>,
  startCalls: [] as unknown[],
  startResult: null as unknown,
  startError: null as Error | null,
};

function rpcClient() {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const outcome = state.handlers[fn]?.() ?? { data: [], error: null };
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcOutcome) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(outcome).then(onFulfilled, onRejected),
      };
      return request;
    },
  };
}

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', () => ({
    checkAdmin: async () => state.admin,
    adminDenied: (status: number) => new Response(JSON.stringify({ success: false, error: 'denied' }), { status, headers: { 'content-type': 'application/json' } }),
  }));
  const run = await import('@/lib/rag/ingest/rebuild/run');
  vi.doMock('@/lib/rag/ingest/rebuild/run', async () => ({
    ...run,
    startRebuild: async (input: unknown, deps: unknown) => {
      state.startCalls.push({ input, deps });
      if (state.startError) throw state.startError;
      return state.startResult;
    },
  }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({ db: () => rpcClient() as never });
  const coverage = await import('@/app/api/rag/admin/ingest-fingerprint/route');
  const start = await import('@/app/api/rag/admin/ingest-fingerprint/rebuild/route');
  const activate = await import('@/app/api/rag/admin/ingest-fingerprint/rebuild/[id]/activate/route');
  const rollback = await import('@/app/api/rag/admin/ingest-fingerprint/rebuild/[id]/rollback/route');
  return { run, coverage, start, activate, rollback };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function post(url: string, body?: unknown, raw?: string): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('rebuild admin routes', () => {
  let loaded: Loaded;

  beforeEach(async () => {
    state.admin = { ok: true, userId: 'admin-1' };
    state.rpcCalls = [];
    state.handlers = {};
    state.startCalls = [];
    state.startError = null;
    state.startResult = {
      status: 'started',
      mechanism: 'reparse',
      affected: 3,
      withoutFingerprint: 0,
      plan: { kind: 'held_batch', mechanism: 'reparse', activation: 'rebuild_batch', affected: 3, documents: [] },
      run: { id: RUN_ID, mechanism: 'reparse', activation: 'rebuild_batch', state: 'running', total: 3, done: 0, gaps: 0, plan: {}, evidencePassed: null, startedAt: '2026-11-25T10:00:00Z', activatedAt: null, rolledBackAt: null },
      resumed: false,
      more: false,
    };
    loaded = await load();
  });

  afterEach(() => {
    vi.doUnmock('@/lib/admin-route-auth');
    vi.doUnmock('@/lib/rag/ingest/rebuild/run');
  });

  it.each([401, 403, 503] as const)('every route answers %s when the admin guard refuses', async (status) => {
    state.admin = { ok: false, status, reason: 'denied' };
    expect((await loaded.start.POST(post('/api/rag/admin/ingest-fingerprint/rebuild', { mechanism: 'reparse' }))).status).toBe(status);
    expect((await loaded.activate.POST(post('/x'), params(RUN_ID))).status).toBe(status);
    expect((await loaded.rollback.POST(post('/x'), params(RUN_ID))).status).toBe(status);
    expect(state.startCalls).toHaveLength(0);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('starts a rebuild from the mechanism alone, with the admin as starter and a time budget, and answers the run row', async () => {
    const response = await loaded.start.POST(post('/api/rag/admin/ingest-fingerprint/rebuild', { mechanism: 'reparse' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ success: true, status: 'started', mechanism: 'reparse', affected: 3, more: false });
    expect(body.run).toMatchObject({ id: RUN_ID, mechanism: 'reparse', state: 'running', done: 0, total: 3, gaps: 0, activation: 'rebuild_batch' });
    const call = state.startCalls[0] as { input: Row };
    expect(call.input).toMatchObject({ mechanism: 'reparse', startedBy: 'admin-1' });
    expect(typeof call.input.deadlineMs).toBe('number');
    expect(call.input.deadlineMs as number).toBeLessThan(60_000);
    expect(JSON.stringify(body)).not.toMatch(/u:|o:|s:default/);
  });

  it.each([
    [{ mechanism: 'reparse', document_ids: ['00000000-0000-4000-8000-000000000001'] }],
    [{ mechanism: 'reparse', tenant_key: 's:default' }],
    [{ mechanism: 'rescan' }],
    [{ mechanism: 'anything' }],
    [{}],
  ])('refuses a body other than a known mechanism: %j', async (body) => {
    const response = await loaded.start.POST(post('/api/rag/admin/ingest-fingerprint/rebuild', body));
    expect(response.status).toBe(400);
    expect(state.startCalls).toHaveLength(0);
  });

  it('refuses a body that is not JSON', async () => {
    expect((await loaded.start.POST(post('/api/rag/admin/ingest-fingerprint/rebuild', undefined, '{'))).status).toBe(400);
  });

  it('answers needs_async with the count and the fixed command when the queue is off', async () => {
    state.startResult = {
      status: 'command',
      mechanism: 'reparse',
      affected: 7,
      withoutFingerprint: 0,
      plan: { kind: 'needs_async', mechanism: 'reparse', affected: 7, command: 'npm run rag:rebuild -- start --mechanism reparse' },
    };
    const body = await (await loaded.start.POST(post('/api/rag/admin/ingest-fingerprint/rebuild', { mechanism: 'reparse' }))).json();
    expect(body).toMatchObject({ success: true, status: 'needs_async', affected: 7, command: 'npm run rag:rebuild -- start --mechanism reparse' });
    expect(body.run).toBeUndefined();
  });

  it('answers a command mechanism with its fixed command and no tenant key', async () => {
    state.startResult = {
      status: 'command',
      mechanism: 'relex',
      affected: 2,
      withoutFingerprint: 0,
      plan: { kind: 'command', mechanism: 'relex', activation: 'none', affected: 2, commands: ['npm run rag:relex -- --tenant u:00000000-0000-4000-8000-0000000000a1'] },
    };
    const body = await (await loaded.start.POST(post('/api/rag/admin/ingest-fingerprint/rebuild', { mechanism: 'relex' }))).json();
    expect(body).toMatchObject({ success: true, status: 'command', affected: 2, command: 'npm run rag:relex' });
    expect(JSON.stringify(body)).not.toContain('u:0000');
  });

  it('answers 503 without the database message when the start fails', async () => {
    state.startError = new loaded.run.RebuildUnavailable('rag_rebuild_start', 'XX000');
    const response = await loaded.start.POST(post('/api/rag/admin/ingest-fingerprint/rebuild', { mechanism: 'rechunk' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'rebuild_unavailable' });
  });

  it.each([
    ['activation_refused: eval_missing', 'eval_missing'],
    ['activation_refused: eval_failed', 'eval_failed'],
    ['activation_refused: incomplete', 'incomplete'],
    ['activation_refused: already_activated', 'already_activated'],
  ])('activation maps the SQL refusal %s to 409', async (message, reason) => {
    state.handlers.rag_rebuild_activate = () => ({ data: null, error: { code: '55000', message } });
    const response = await loaded.activate.POST(post('/x'), params(RUN_ID));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'activation_refused', reason });
    expect(state.rpcCalls[0]).toEqual({ fn: 'rag_rebuild_activate', args: { p_run_id: RUN_ID, p_actor: 'admin-1' } });
  });

  it('rollback maps the SQL refusal to 409, an unknown id to 404 and success to 200', async () => {
    state.handlers.rag_rebuild_rollback = () => ({ data: null, error: { code: '55000', message: 'rollback_refused: already_rolled_back' } });
    let response = await loaded.rollback.POST(post('/x'), params(RUN_ID));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'rollback_refused', reason: 'already_rolled_back' });

    state.handlers.rag_rebuild_rollback = () => ({ data: null, error: { code: '22023', message: 'not_found' } });
    response = await loaded.rollback.POST(post('/x'), params(RUN_ID));
    expect(response.status).toBe(404);

    state.handlers.rag_rebuild_rollback = () => ({
      data: [
        { document_id: '00000000-0000-4000-8000-000000000001', tenant_key: 's:default', outcome: 'restored' },
        { document_id: '00000000-0000-4000-8000-000000000002', tenant_key: 's:default', outcome: 'superseded' },
      ],
      error: null,
    });
    response = await loaded.rollback.POST(post('/x'), params(RUN_ID));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, restored: 1, superseded: 1 });
  });

  it('activation success answers counts only; a malformed id is 404 without a database call; a body is refused', async () => {
    state.handlers.rag_rebuild_activate = () => ({ data: [{ document_id: '00000000-0000-4000-8000-000000000001', tenant_key: 's:default', outcome: 'published' }], error: null });
    const response = await loaded.activate.POST(post('/x'), params(RUN_ID));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, published: 1, superseded: 0 });

    state.rpcCalls = [];
    expect((await loaded.activate.POST(post('/x'), params('not-a-uuid'))).status).toBe(404);
    expect(state.rpcCalls).toHaveLength(0);
    expect((await loaded.activate.POST(post('/x', { run_id: RUN_ID }), params(RUN_ID))).status).toBe(400);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it('GET ingest-fingerprint lists the rebuild rows with their UI state and activation', async () => {
    state.handlers.rag_fingerprint_groups = () => ({ data: [], error: null });
    state.handlers.rag_rebuild_list = () => ({
      data: [
        RUN_ROW,
        { ...RUN_ROW, id: '00000000-0000-4000-8000-00000000ab02', state: 'activated' },
        { ...RUN_ROW, id: '00000000-0000-4000-8000-00000000ab03', mechanism: 'rechunk', activation: 'chunking_profiles', state: 'running', done: 1 },
        { ...RUN_ROW, id: '00000000-0000-4000-8000-00000000ab04', state: 'rolled_back' },
      ],
      error: null,
    });
    const response = await loaded.coverage.GET(new Request('http://localhost/api/rag/admin/ingest-fingerprint'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rebuilds).toEqual([
      { id: RUN_ID, mechanism: 'reparse', done: 3, total: 3, gaps: 0, state: 'built', started: '2026-11-25T10:00:00Z', activation: 'rebuild_batch' },
      { id: '00000000-0000-4000-8000-00000000ab02', mechanism: 'reparse', done: 3, total: 3, gaps: 0, state: 'active', started: '2026-11-25T10:00:00Z', activation: 'rebuild_batch' },
      { id: '00000000-0000-4000-8000-00000000ab03', mechanism: 'rechunk', done: 1, total: 3, gaps: 0, state: 'running', started: '2026-11-25T10:00:00Z', activation: 'chunking_profiles' },
      { id: '00000000-0000-4000-8000-00000000ab04', mechanism: 'reparse', done: 3, total: 3, gaps: 0, state: 'rolled_back', started: '2026-11-25T10:00:00Z', activation: 'rebuild_batch' },
    ]);
    expect(body.pending).toHaveLength(7);
  });
});
