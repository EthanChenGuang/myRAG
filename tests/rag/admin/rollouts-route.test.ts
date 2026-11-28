import { beforeEach, describe, expect, it, vi } from 'vitest';
import { harness, headersFor, loadRoute, resetHarness, type RpcOutcome } from './route-harness';

/** LANG-11 (plan 07-49): the rollouts admin route. Fails closed, 404 while off, ids, keys, counts and codes only, never the salt. */

type RouteModule = typeof import('@/app/api/rag/admin/rollouts/route');

const URL = 'http://localhost:3000/api/rag/admin/rollouts';
const DAY = 86_400_000;
const ROLLOUT_ID = '00000000-0000-4000-8000-0000000000aa';
const SALT = 'SaltValueNeverShown01';
const A = 'o:00000000-0000-4000-8000-000000000001';
const B = 'o:00000000-0000-4000-8000-000000000002';
const X = 'o:00000000-0000-4000-8000-000000000009';
const CREATED = new Date(Date.now() - 20 * DAY).toISOString();

const activation = {
  embedding: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, activated: 'profile-b', previous: 'profile-a' })),
  chunking: vi.fn(async (id: string, options: { docType?: string }) => ({ activated: id, previous: null, docType: options.docType ?? 'general', changed: true })),
  rebuild: vi.fn(async () => ({ published: [], superseded: 0 })),
};

class FakeChunkingRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
class FakeRebuildRefused extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
  ) {
    super(reason);
  }
}

async function load(): Promise<RouteModule> {
  return loadRoute(async () => {
    vi.doMock('@/lib/rag/lang/settings', () => ({ getLanguageSettings: () => ({ configured: true, languages: ['en'], primary: 'en', monolingual: true }) }));
    vi.doMock('@/lib/rag/embeddings/profile-ops', () => ({ activateEmbeddingProfile: activation.embedding }));
    vi.doMock('@/lib/rag/chunking/profile-ops', () => ({
      activateChunkingProfile: activation.chunking,
      rollbackChunkingProfile: vi.fn(async () => ({})),
      ChunkingActivationRefused: FakeChunkingRefused,
    }));
    vi.doMock('@/lib/rag/ingest/rebuild/run', () => ({
      activateRebuild: activation.rebuild,
      RebuildRefused: FakeRebuildRefused,
      RebuildNotFound: class extends Error {},
    }));
    return import('@/app/api/rag/admin/rollouts/route');
  });
}

function get(auth: 'admin' | 'user' | 'none' = 'admin'): Request {
  return new Request(URL, { method: 'GET', headers: headersFor(auth) });
}

function post(body: unknown, auth: 'admin' | 'user' | 'none' = 'admin'): Request {
  return new Request(URL, { method: 'POST', headers: { ...headersFor(auth), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function active(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROLLOUT_ID,
    kind: 'embedding_profile',
    candidate_ref: { embedding_profile_id: 'profile-b' },
    incumbent_ref: { embedding_profile_id: 'profile-a' },
    mode: 'tenants',
    share_percent: null,
    salt: SALT,
    included_tenants: [A],
    excluded_tenants: [X],
    chunking_map: null,
    created_at: CREATED,
    ...partial,
  };
}

function cell(tenant: string, language: string, retrievals: number, refused: number) {
  return { tenant_key: tenant, language, retrievals, refused, kb_unavailable: 0, votes_up: 20, votes_down: 2, low_confidence: 0 };
}

function cells(current: ReturnType<typeof cell>[], baseline: ReturnType<typeof cell>[]) {
  return (args: Record<string, unknown>): RpcOutcome => ({
    data: Date.parse(String(args.p_since)) >= Date.parse(CREATED) ? current : baseline,
    error: null,
  });
}

function sqlRefusal(code: string): RpcOutcome {
  return { data: null, error: { code: '55000', message: `rollout_refused: ${code}` } };
}

const healthy = [cell(A, 'en', 100, 10), cell(B, 'en', 200, 20)];

function onAndActive(rows: Record<string, unknown>[] = [active()]): void {
  harness.env = { RAG_ROLLOUTS: 'true' };
  harness.outcomes.rag_rollout_active = { data: rows, error: null };
  harness.outcomes.rag_language_quality_cells = cells(healthy, healthy);
  harness.outcomes.rag_rollout_finish = { data: 'promoted', error: null };
}

function expectNoText(text: string): void {
  expect(text).not.toContain(SALT);
  expect(text).not.toContain('"ok":false');
  expect(text).not.toContain('rollout_refused');
}

describe('/api/rag/admin/rollouts', () => {
  beforeEach(() => {
    resetHarness();
    vi.clearAllMocks();
  });

  it('switched off: 404 before the admin check and any database read', async () => {
    const route = await load();
    expect((await route.GET(get('none'))).status).toBe(404);
    expect((await route.POST(post({ action: 'rollback', rolloutId: ROLLOUT_ID }, 'none'))).status).toBe(404);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('no session 401, non-admin 403, lookup failure 503, each before any rollout read', async () => {
    onAndActive();
    const route = await load();
    expect((await route.GET(get('none'))).status).toBe(401);
    expect((await route.POST(post({ action: 'promote', rolloutId: ROLLOUT_ID }, 'none'))).status).toBe(401);
    expect(harness.rpcCalls).toEqual([]);
    harness.guardAvailable = false;
    expect((await route.GET(get('admin'))).status).toBe(503);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('non-admin: 403 on the list and on every action, nothing changes', async () => {
    onAndActive();
    const route = await load();
    expect((await route.GET(get('user'))).status).toBe(403);
    for (const body of [
      { action: 'promote', rolloutId: ROLLOUT_ID },
      { action: 'rollback', rolloutId: ROLLOUT_ID },
      { action: 'exclude', rolloutId: ROLLOUT_ID, tenant: A },
      { action: 'start', kind: 'embedding_profile', candidate: 'profile-b', mode: 'share', share: 10 },
    ]) {
      expect((await route.POST(post(body, 'user'))).status).toBe(403);
    }
    expect(harness.rpcCalls).toEqual([]);
  });

  it('list fields: keys, arm sizes, per-language values with n and verdict, the policy; ended rows; never the salt', async () => {
    onAndActive();
    harness.tables.rag_rollouts = [
      { id: '00000000-0000-4000-8000-0000000000cc', kind: 'chunking_profile', candidate_ref: { chunking_profile_ids: ['general:cp-b'] }, state: 'rolled_back', ended_at: '2026-11-20T00:00:00.000Z', salt: SALT, ended_by: 'someone' },
    ];
    const route = await load();
    const response = await route.GET(get());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expectNoText(text);
    const body = JSON.parse(text);
    expect(body.policy).toEqual({ observationDays: 7, minSamples: 30 });
    expect(body.active).toHaveLength(1);
    const [entry] = body.active;
    expect(Object.keys(entry).sort()).toEqual(
      ['arms', 'candidate', 'createdAt', 'excluded', 'id', 'incumbent', 'included', 'kind', 'languages', 'mode', 'share', 'state'].sort(),
    );
    expect(entry).toMatchObject({ id: ROLLOUT_ID, kind: 'embedding_profile', candidate: ['profile-b'], incumbent: ['profile-a'], mode: 'tenants', share: null, state: 'active', included: [A], excluded: [X] });
    expect(entry.arms).toEqual({ candidate: 1, incumbent: 2 });
    const refusal = entry.languages[0].measures.find((row: { measure: string }) => row.measure === 'refusal_rate');
    expect(entry.languages[0].language).toBe('en');
    expect(refusal).toEqual({ measure: 'refusal_rate', candidate: { value: 0.1, n: 100 }, before: { value: 0.1, n: 100 }, others: { value: 0.1, n: 200 }, verdict: 'holds' });
    expect(entry.languages[0].measures.map((row: { measure: string }) => row.measure)).toEqual(['refusal_rate', 'not_helpful_rate', 'judge_score']);
    expect(body.ended).toEqual([{ id: '00000000-0000-4000-8000-0000000000cc', kind: 'chunking_profile', candidate: ['general:cp-b'], state: 'rolled_back', endedAt: '2026-11-20T00:00:00.000Z' }]);
    expect(text).not.toContain('someone');
  });

  it('promote accepted: 200 with the result, the candidate activated and the rollout finished', async () => {
    onAndActive();
    const route = await load();
    const response = await route.POST(post({ action: 'promote', rolloutId: ROLLOUT_ID }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expectNoText(text);
    expect(JSON.parse(text)).toMatchObject({ id: ROLLOUT_ID, state: 'promoted', candidate: ['profile-b'] });
    expect(activation.embedding).toHaveBeenCalledWith('profile-b', expect.any(String));
    expect(harness.rpcCalls.find((call) => call.fn === 'rag_rollout_finish')?.args).toMatchObject({ p_state: 'promoted' });
  });

  it('promote refused: 409 with { code } and no ok field, for each rollout code and an activation refusal', async () => {
    const cases: Array<{ code: string; setup: () => void }> = [
      { code: 'rollout_observation_too_short', setup: () => (harness.outcomes.rag_rollout_active = { data: [active({ created_at: new Date().toISOString() })], error: null }) },
      { code: 'rollout_monitoring_insufficient:en', setup: () => (harness.outcomes.rag_language_quality_cells = cells([cell(A, 'en', 12, 1)], healthy)) },
      { code: 'rollout_language_drop:en:refusal_rate', setup: () => (harness.outcomes.rag_language_quality_cells = cells([cell(A, 'en', 100, 40)], healthy)) },
      { code: 'external_not_ready:qdrant', setup: () => activation.embedding.mockResolvedValueOnce({ ok: false, reason: 'activation_refused: external_not_ready', detail: '', code: 'external_not_ready', backend: 'qdrant' }) },
    ];
    for (const entry of cases) {
      resetHarness();
      onAndActive();
      entry.setup();
      const route = await load();
      const response = await route.POST(post({ action: 'promote', rolloutId: ROLLOUT_ID }));
      expect(response.status, entry.code).toBe(409);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ code: entry.code });
      expectNoText(text);
      expect(harness.rpcCalls.some((call) => call.fn === 'rag_rollout_finish'), entry.code).toBe(false);
    }
  });

  it('promote of a chunking_profile or rebuild_run rollout goes through its own activation and keeps its refusal', async () => {
    onAndActive([active({ kind: 'chunking_profile', candidate_ref: { chunking_profile_ids: ['general:cp-b'] }, chunking_map: { general: 'cp-b' } })]);
    activation.chunking.mockRejectedValueOnce(new FakeChunkingRefused('activation_refused: not_ready'));
    let route = await load();
    let response = await route.POST(post({ action: 'promote', rolloutId: ROLLOUT_ID }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'activation_refused: not_ready' });
    expect(activation.chunking).toHaveBeenCalledWith('cp-b', expect.objectContaining({ docType: 'general' }));

    resetHarness();
    onAndActive([active({ kind: 'rebuild_run', candidate_ref: { rebuild_run_id: '00000000-0000-4000-8000-0000000000bb' }, incumbent_ref: null })]);
    activation.rebuild.mockRejectedValueOnce(new FakeRebuildRefused('activation_refused', 'eval_failed'));
    route = await load();
    response = await route.POST(post({ action: 'promote', rolloutId: ROLLOUT_ID }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'activation_refused:eval_failed' });
  });

  it('start, include, exclude and rollback call the 0744 functions with the admin as actor', async () => {
    onAndActive();
    harness.outcomes.rag_rollout_start = { data: ROLLOUT_ID, error: null };
    harness.outcomes.rag_rollout_set_tenant = { data: 'exclude', error: null };
    harness.outcomes.rag_rollout_rollback = { data: 'rolled_back', error: null };
    const route = await load();
    const started = await route.POST(post({ action: 'start', kind: 'embedding_profile', candidate: 'profile-b', mode: 'tenants', tenants: [A, B] }));
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual({ id: ROLLOUT_ID, kind: 'embedding_profile' });
    const start = harness.rpcCalls.find((call) => call.fn === 'rag_rollout_start')!;
    expect(start.args).toMatchObject({ p_kind: 'embedding_profile', p_candidate_ref: { embedding_profile_id: 'profile-b' }, p_mode: 'tenants', p_tenants: [A, B], p_share_percent: null });
    expect(typeof start.args.p_actor).toBe('string');
    expect((await route.POST(post({ action: 'exclude', rolloutId: ROLLOUT_ID, tenant: A }))).status).toBe(200);
    expect(harness.rpcCalls.find((call) => call.fn === 'rag_rollout_set_tenant')?.args).toMatchObject({ p_tenant_key: A, p_membership: 'exclude' });
    expect((await route.POST(post({ action: 'rollback', rolloutId: ROLLOUT_ID }))).status).toBe(200);
  });

  it('a second active rollout of a kind answers 409 with the SQL refusal; an ended one 404', async () => {
    onAndActive();
    harness.outcomes.rag_rollout_start = sqlRefusal('active_exists');
    harness.outcomes.rag_rollout_rollback = sqlRefusal('not_active');
    const route = await load();
    const response = await route.POST(post({ action: 'start', kind: 'embedding_profile', candidate: 'profile-b', mode: 'share', share: 10 }));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ code: 'active_exists' });
    expectNoText(text);
    expect((await route.POST(post({ action: 'rollback', rolloutId: ROLLOUT_ID }))).status).toBe(404);
  });

  it('upper-case or malformed keys, unknown fields and a share outside 1-100 answer 400 before any write', async () => {
    onAndActive();
    const route = await load();
    for (const body of [
      { action: 'include', rolloutId: ROLLOUT_ID, tenant: A.toUpperCase() },
      { action: 'include', rolloutId: ROLLOUT_ID, tenant: 'o:not-a-uuid' },
      { action: 'start', kind: 'embedding_profile', candidate: 'profile-b', mode: 'tenants', tenants: ['S:DEFAULT'] },
      { action: 'start', kind: 'embedding_profile', candidate: 'profile-b', mode: 'share', share: 0 },
      { action: 'start', kind: 'embedding_profile', candidate: 'profile-b', mode: 'share' },
      { action: 'start', kind: 'rebuild_run', candidate: 'not-a-uuid', mode: 'share', share: 5 },
      { action: 'rollback', rolloutId: ROLLOUT_ID, salt: SALT },
      { action: 'promote', rolloutId: ROLLOUT_ID, arm: 'candidate' },
    ]) {
      const response = await route.POST(post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(harness.rpcCalls).toEqual([]);
  });

  it('a failed rollout read answers 503 without a database message', async () => {
    onAndActive();
    harness.outcomes.rag_rollout_active = { data: null, error: { code: 'XX000', message: 'connection reset at host db.internal' } };
    const route = await load();
    const response = await route.GET(get());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('db.internal');
  });
});
