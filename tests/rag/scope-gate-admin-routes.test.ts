import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintScope, scopeKey, type TenantScope } from '@/lib/rag/tenant/scope';
import { resetScopeGateCalibrationForTests, setScopeGateCalibrationForTests } from '@/lib/rag/scope/calibration';

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const ORG_A = '0a000000-0000-4000-8000-00000000000a';
const ORG_B = '0b000000-0000-4000-8000-00000000000b';
const PROFILE = 'openai-3-small-1536';
const EX_B = '0b000000-0000-4000-8000-0000000000e1';

interface FakeExample {
  id: string;
  tenantKey: string;
  text: string;
  createdBy: string;
}

const state = {
  admin: { ok: true, userId: ADMIN } as { ok: true; userId: string } | { ok: false; status: 401 | 403 | 503; reason: string },
  memberships: [ORG_A] as string[],
  workspaceDown: false,
  examples: [] as FakeExample[],
  groups: {} as Record<string, { doc_type: number; scope_tag: number; tenant: number }>,
  unsupported: false,
  rebuildRunning: false,
  rebuildOutcome: 'done' as 'done' | 'started' | 'running' | 'failed',
  embedDown: false,
  statusDown: false,
  calls: [] as Array<{ fn: string; tenantKey: string; actorId?: string }>,
  nextId: 1,
};

vi.mock('@/lib/admin-route-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-route-auth')>();
  return { ...actual, checkAdmin: vi.fn(async () => state.admin) };
});

vi.mock('@/lib/rag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rag')>();
  const { scopeKey: key, mintScope: mint } = await import('@/lib/rag/tenant/scope');
  return {
    ...actual,
    resolveAdminWorkspaceScope: vi.fn(async (input: { adminUserId: string; requestedOrganizationId: string | null }) => {
      if (state.workspaceDown) return { ok: false, status: 503 };
      if (input.requestedOrganizationId === null) return { ok: true, scope: mint('personal', input.adminUserId, null) };
      if (!state.memberships.includes(input.requestedOrganizationId)) return { ok: false, status: 403 };
      return { ok: true, scope: mint('org', null, input.requestedOrganizationId) };
    }),
    scopeGateStatus: vi.fn(async (scope: TenantScope) => {
      const tenantKey = key(scope);
      state.calls.push({ fn: 'status', tenantKey });
      if (state.statusDown) return { ok: false, code: 'backend_error' };
      return {
        ok: true,
        status: {
          profileId: PROFILE,
          groups: state.groups[tenantKey] ?? { doc_type: 0, scope_tag: 0, tenant: 0 },
          chunksIncluded: 40,
          newestUpdate: '2026-11-24T10:00:00.000Z',
          examples: state.examples.filter((row) => row.tenantKey === tenantKey).length,
          rebuildRunning: state.rebuildRunning,
          unsupported: state.unsupported,
          command: `npm run rag:scope-centroids -- --tenant ${tenantKey}`,
        },
      };
    }),
    listScopeExamples: vi.fn(async (scope: TenantScope) => {
      const tenantKey = key(scope);
      state.calls.push({ fn: 'list', tenantKey });
      return {
        ok: true,
        profileId: PROFILE,
        examples: state.examples
          .filter((row) => row.tenantKey === tenantKey)
          .map((row) => ({ id: row.id, text: row.text, createdBy: row.createdBy, createdAt: '2026-11-24T10:00:00.000Z' })),
      };
    }),
    addScopeExample: vi.fn(async (scope: TenantScope, input: { text: string; actorId: string }) => {
      const tenantKey = key(scope);
      state.calls.push({ fn: 'add', tenantKey, actorId: input.actorId });
      const text = input.text.trim();
      if (text === '') return { ok: false, code: 'text_empty' };
      if (Array.from(text).length > 500) return { ok: false, code: 'text_too_long' };
      const mine = state.examples.filter((row) => row.tenantKey === tenantKey);
      if (mine.some((row) => row.text.toLowerCase() === text.toLowerCase())) return { ok: false, code: 'example_exists' };
      if (mine.length >= 100) return { ok: false, code: 'limit' };
      if (state.embedDown) return { ok: false, code: 'embedding_unavailable' };
      const id = `0a000000-0000-4000-8000-${String(state.nextId++).padStart(12, '0')}`;
      state.examples.push({ id, tenantKey, text, createdBy: input.actorId });
      return { ok: true, example: { id, createdAt: '2026-11-28T10:00:00.000Z' } };
    }),
    deleteScopeExample: vi.fn(async (scope: TenantScope, id: string) => {
      const tenantKey = key(scope);
      state.calls.push({ fn: 'delete', tenantKey });
      const index = state.examples.findIndex((row) => row.id === id && row.tenantKey === tenantKey);
      if (index < 0) return { ok: false, code: 'not_found' };
      state.examples.splice(index, 1);
      return { ok: true };
    }),
    startScopeRebuild: vi.fn(async (scope: TenantScope) => {
      const tenantKey = key(scope);
      state.calls.push({ fn: 'rebuild', tenantKey });
      if (state.rebuildOutcome === 'started') return { status: 'started' };
      if (state.rebuildOutcome === 'running') return { status: 'running' };
      if (state.rebuildOutcome === 'failed') return { status: 'failed', code: 'rebuild_failed' };
      return {
        status: 'done',
        result: {
          tenantKey,
          profileId: PROFILE,
          counts: { doc_type: { groups: 2, chunks: 30 }, scope_tag: { groups: 1, chunks: 10 }, tenant: { groups: 1, chunks: 40 } },
          examples: { reembedded: 0, skipped: 0, failed: 0 },
          durationMs: 5,
        },
      };
    }),
  };
});

const statusRoute = await import('@/app/api/rag/admin/scope-gate/route');
const examplesRoute = await import('@/app/api/rag/admin/scope-gate/examples/route');
const exampleIdRoute = await import('@/app/api/rag/admin/scope-gate/examples/[id]/route');
const rebuildRoute = await import('@/app/api/rag/admin/scope-gate/rebuild/route');

const BASE = 'http://localhost/api/rag/admin/scope-gate';
const url = (path: string, org?: string) => `${BASE}${path}${org ? `?organizationId=${org}` : ''}`;
const get = (org?: string) => statusRoute.GET(new Request(url('', org)));
const add = (body: unknown, org?: string) =>
  examplesRoute.POST(new Request(url('/examples', org), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const del = (id: string, org?: string) => exampleIdRoute.DELETE(new Request(url(`/examples/${id}`, org), { method: 'DELETE' }), { params: Promise.resolve({ id }) });
const rebuild = (org?: string) => rebuildRoute.POST(new Request(url('/rebuild', org), { method: 'POST' }));

const HANDLERS: Array<[string, (org?: string) => Promise<Response>]> = [
  ['GET status', get],
  ['POST examples', (org) => add({ text: 'A neutral synthetic question about item alpha?' }, org)],
  ['DELETE example', (org) => del(EX_B, org)],
  ['POST rebuild', rebuild],
];

const keyA = scopeKey(mintScope('org', null, ORG_A));
const keyB = scopeKey(mintScope('org', null, ORG_B));

const LIVE = {
  cells: (['strict', 'balanced', 'flexible'] as const).map((mode) => ({
    correct_refusal_n: 12,
    correct_refusal_rate: 0.5,
    embedding_profile_id: PROFILE,
    false_refusal_n: 100,
    false_refusal_rate: 0.01,
    false_refusal_upper_95: 0.05,
    margin: 0.02,
    rag_mode: mode,
    status: 'calibrated',
    threshold: 0.3,
  })),
  recorded_at: '2026-11-28T01:00:00Z',
  schema_version: 1,
  source: 'live',
};

function readyEnv(): void {
  vi.stubEnv('RAG_PIPELINE', 'v2');
  vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'en');
  vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'en');
  vi.stubEnv('RAG_QUERY_LAYER', 'true');
  vi.stubEnv('RAG_SCOPE_GATE', 'true');
  vi.stubEnv('RAG_BEHAVIOR_MODE', 'strict');
  vi.stubEnv('RAG_DISABLED_STAGES', '');
}

type Readiness = Array<{ row: string; state: string }>;
const stateOf = (body: { readiness: Readiness }, row: string) => body.readiness.find((entry) => entry.row === row)?.state;

beforeEach(() => {
  state.admin = { ok: true, userId: ADMIN };
  state.memberships = [ORG_A];
  state.workspaceDown = false;
  state.examples = [{ id: EX_B, tenantKey: keyB, text: 'Workspace B example question?', createdBy: ADMIN }];
  state.groups = { [keyA]: { doc_type: 2, scope_tag: 1, tenant: 1 }, [keyB]: { doc_type: 9, scope_tag: 9, tenant: 1 } };
  state.unsupported = false;
  state.rebuildRunning = false;
  state.rebuildOutcome = 'done';
  state.embedDown = false;
  state.statusDown = false;
  state.calls = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetScopeGateCalibrationForTests();
});

describe('scope-gate admin routes: guard', () => {
  for (const [name, call] of HANDLERS) {
    it(`${name}: 401 without a session, 403 for a non-admin, 503 when verification is down, 403 for a foreign workspace`, async () => {
      state.admin = { ok: false, status: 401, reason: 'no_session' };
      expect((await call(ORG_A)).status).toBe(401);
      state.admin = { ok: false, status: 403, reason: 'not_admin' };
      const denied = await call(ORG_A);
      expect(denied.status).toBe(403);
      expect((await denied.json()).error).toBe('Admin access required');
      state.admin = { ok: false, status: 503, reason: 'auth_unavailable' };
      expect((await call(ORG_A)).status).toBe(503);
      state.admin = { ok: true, userId: ADMIN };
      const foreign = await call(ORG_B);
      expect(foreign.status).toBe(403);
      expect((await foreign.json()).error).toBe('Forbidden');
      expect(foreign.headers.get('cache-control')).toBe('no-store');
      expect(state.calls).toEqual([]);
    });
  }

  it('workspace verification down answers 503 and reaches no service', async () => {
    state.workspaceDown = true;
    expect((await get(ORG_A)).status).toBe(503);
    expect(state.calls).toEqual([]);
  });
});

describe('GET /api/rag/admin/scope-gate', () => {
  it('with the committed fixture calibration the Thresholds row is eval_only and canSkip is false', async () => {
    readyEnv();
    const response = await get(ORG_A);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(stateOf(body, 'thresholds')).toBe('eval_only');
    expect(body.canSkip).toBe(false);
    expect(body.thresholds.source).toBe('fixture');
  });

  it('an empty calibration makes the Thresholds row missing and canSkip false', async () => {
    readyEnv();
    setScopeGateCalibrationForTests({ cells: [], recorded_at: '2026-11-28T01:00:00Z', schema_version: 1, source: 'live' });
    const body = await (await get(ORG_A)).json();
    expect(stateOf(body, 'thresholds')).toBe('missing');
    expect(body.canSkip).toBe(false);
    expect(body.thresholds.rows).toEqual([]);
  });

  it('an invalid calibration is not usable', async () => {
    readyEnv();
    setScopeGateCalibrationForTests({ cells: 'broken' });
    const body = await (await get(ORG_A)).json();
    expect(stateOf(body, 'thresholds')).toBe('invalid');
    expect(body.thresholds.valid).toBe(false);
  });

  it('all four rows ready with a live calibration: canSkip is true and the running values are reported', async () => {
    readyEnv();
    setScopeGateCalibrationForTests(LIVE);
    const body = await (await get(ORG_A)).json();
    expect(body.readiness.map((entry: { row: string; state: string }) => [entry.row, entry.state])).toEqual([
      ['switch', 'on'],
      ['pipeline', 'ready'],
      ['thresholds', 'ready'],
      ['scope_data', 'ready'],
    ]);
    expect(body.canSkip).toBe(true);
    expect(body.running).toEqual({ scopeGate: true, pipeline: 'v2', queryLayer: true, ragMode: 'strict', activeProfileId: PROFILE });
    expect(body.thresholds.rows).toHaveLength(3);
    expect(body.thresholds.rows[0]).toMatchObject({ embeddingProfileId: PROFILE, activeProfile: true, ragMode: 'strict', source: 'live', threshold: 0.3, margin: 0.02 });
    expect(body.examples).toMatchObject({ total: 0, limit: 100, maxChars: 500 });
    expect(body.scopeData.rebuild).toEqual({ browser: true, command: null });
  });

  it('defaults: switch off, legacy pipeline, nothing can be skipped', async () => {
    vi.stubEnv('RAG_PIPELINE', '');
    vi.stubEnv('RAG_SCOPE_GATE', '');
    vi.stubEnv('RAG_QUERY_LAYER', '');
    const body = await (await get(ORG_A)).json();
    expect(stateOf(body, 'switch')).toBe('off');
    expect(stateOf(body, 'pipeline')).toBe('legacy');
    expect(body.canSkip).toBe(false);
  });

  it('layer off, bypass mode, missing, rebuilding and unsupported scope data are reported as such', async () => {
    readyEnv();
    setScopeGateCalibrationForTests(LIVE);
    vi.stubEnv('RAG_QUERY_LAYER', 'false');
    expect(stateOf(await (await get(ORG_A)).json(), 'pipeline')).toBe('layer_off');
    vi.stubEnv('RAG_QUERY_LAYER', 'true');
    vi.stubEnv('RAG_BEHAVIOR_MODE', 'bypass');
    expect(stateOf(await (await get(ORG_A)).json(), 'pipeline')).toBe('bypass');
    vi.stubEnv('RAG_BEHAVIOR_MODE', 'strict');
    state.groups[keyA] = { doc_type: 0, scope_tag: 0, tenant: 0 };
    expect(stateOf(await (await get(ORG_A)).json(), 'scope_data')).toBe('missing');
    state.rebuildRunning = true;
    expect(stateOf(await (await get(ORG_A)).json(), 'scope_data')).toBe('rebuilding');
    state.rebuildRunning = false;
    state.unsupported = true;
    const body = await (await get(ORG_A)).json();
    expect(stateOf(body, 'scope_data')).toBe('unsupported');
    expect(body.scopeData.rebuild.browser).toBe(false);
    expect(body.canSkip).toBe(false);
  });

  it('two workspaces: the admin of A sees only A, and the answer carries no tenant key, vector or score', async () => {
    readyEnv();
    state.memberships = [ORG_A, ORG_B];
    await add({ text: 'Workspace A example question?' }, ORG_A);
    const response = await get(ORG_A);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.examples.rows.map((row: { text: string }) => row.text)).toEqual(['Workspace A example question?']);
    expect(body.scopeData.kinds).toEqual([
      { kind: 'doc_type', referencePoints: 2 },
      { kind: 'scope_tag', referencePoints: 1 },
      { kind: 'tenant', referencePoints: 1 },
    ]);
    expect(text).not.toContain(keyA);
    expect(text).not.toContain(ORG_A);
    expect(text).not.toContain('Workspace B example');
    expect(text).not.toMatch(/"(embedding|vector|centroid|score|negative_score|tenantKey|tenant_key)"/);
    expect(state.calls.filter((call) => call.fn !== 'add').every((call) => call.tenantKey === keyA)).toBe(true);
  });

  it('a failing service answers 503 scope_gate_unavailable', async () => {
    state.statusDown = true;
    const response = await get(ORG_A);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('scope_gate_unavailable');
  });
});

describe('POST /api/rag/admin/scope-gate/examples', () => {
  it('adds with the verified actor as created_by and returns the new row', async () => {
    const response = await add({ text: 'A neutral synthetic question about item alpha?' }, ORG_A);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.example).toMatchObject({ createdBy: ADMIN });
    expect(typeof body.example.id).toBe('string');
    expect(state.calls).toEqual([{ fn: 'add', tenantKey: keyA, actorId: ADMIN }]);
  });

  it('a created_by in the body is rejected, never used', async () => {
    const response = await add({ text: 'Question?', created_by: '00000000-0000-4000-8000-0000000000ff' }, ORG_A);
    expect(response.status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it('maps text_empty, text_too_long, example_exists, limit and embedding_unavailable', async () => {
    const codeOf = async (response: Response) => [response.status, (await response.json()).error];
    expect(await codeOf(await add({ text: '   ' }, ORG_A))).toEqual([400, 'text_empty']);
    expect(await codeOf(await add({ text: 'x'.repeat(501) }, ORG_A))).toEqual([400, 'text_too_long']);
    await add({ text: 'Same question?' }, ORG_A);
    expect(await codeOf(await add({ text: 'same QUESTION?' }, ORG_A))).toEqual([409, 'example_exists']);
    state.embedDown = true;
    expect(await codeOf(await add({ text: 'Another question?' }, ORG_A))).toEqual([503, 'embedding_unavailable']);
    state.embedDown = false;
    for (let i = state.examples.filter((row) => row.tenantKey === keyA).length; i < 100; i += 1) {
      state.examples.push({ id: `x-${i}`, tenantKey: keyA, text: `filler ${i}`, createdBy: ADMIN });
    }
    expect(await codeOf(await add({ text: 'One more question?' }, ORG_A))).toEqual([409, 'limit']);
  });

  it('a non-JSON body is a structured 400', async () => {
    const response = await examplesRoute.POST(new Request(url('/examples', ORG_A), { method: 'POST', body: 'not json' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: 'Invalid request data' });
  });
});

describe('DELETE /api/rag/admin/scope-gate/examples/{id}', () => {
  it('deletes within the tenant; another workspace example reads like an unknown id', async () => {
    state.memberships = [ORG_A, ORG_B];
    const created = await (await add({ text: 'Workspace A example question?' }, ORG_A)).json();
    const foreign = await del(EX_B, ORG_A);
    expect(foreign.status).toBe(404);
    expect(state.examples.some((row) => row.id === EX_B)).toBe(true);
    const unknown = await del('0c000000-0000-4000-8000-0000000000e9', ORG_A);
    expect(unknown.status).toBe(404);
    expect(await foreign.clone().json().catch(() => null)).toEqual(await unknown.clone().json().catch(() => null));
    const ok = await del(created.example.id, ORG_A);
    expect(ok.status).toBe(200);
    expect(state.examples.filter((row) => row.tenantKey === keyA)).toEqual([]);
  });

  it('a malformed id is a structured 400', async () => {
    const response = await del('not-a-uuid', ORG_A);
    expect(response.status).toBe(400);
    expect((await response.json()).details[0].path).toBe('id');
  });
});

describe('POST /api/rag/admin/scope-gate/rebuild', () => {
  it('200 with the counts when finished, no tenant key in the answer', async () => {
    const response = await rebuild(ORG_A);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ success: true, status: 'done', kinds: [{ kind: 'doc_type', referencePoints: 2, chunksIncluded: 30 }, { kind: 'scope_tag' }, { kind: 'tenant' }] });
    expect(text).not.toContain(keyA);
    expect(state.calls.every((call) => call.tenantKey === keyA)).toBe(true);
  });

  it('202 while running, 409 rebuild_running and unsupported_binding, 503 on failure', async () => {
    state.rebuildOutcome = 'started';
    expect((await rebuild(ORG_A)).status).toBe(202);
    state.rebuildOutcome = 'running';
    const running = await rebuild(ORG_A);
    expect([running.status, (await running.json()).error]).toEqual([409, 'rebuild_running']);
    state.rebuildOutcome = 'done';
    state.rebuildRunning = true;
    expect((await (await rebuild(ORG_A)).json()).error).toBe('rebuild_running');
    state.rebuildRunning = false;
    state.unsupported = true;
    const unsupported = await rebuild(ORG_A);
    expect([unsupported.status, (await unsupported.json()).error]).toEqual([409, 'unsupported_binding']);
    state.unsupported = false;
    state.rebuildOutcome = 'failed';
    expect((await rebuild(ORG_A)).status).toBe(503);
  });
});
