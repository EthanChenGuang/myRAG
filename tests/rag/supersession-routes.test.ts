import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RpcClient, RpcRequest, RpcResponse } from '@/lib/rag/backend/supabase-rpc';

// Plan 03.2-45 (DATA-19, D-50): supersession admin routes. The guard is a fake that admits a deployment admin or an organization admin for
// one workspace; the database is a fake of the 0806 functions that applies the actor's workspace rule. Two organizations, O and P.

const ADMIN_O = '00000000-0000-4000-8000-0000000045a1';
const ADMIN_P = '00000000-0000-4000-8000-0000000045a2';
const UPLOADER = '00000000-0000-4000-8000-0000000045a3';
const ORG_O = '00000000-0000-4000-8000-0000000045c1';
const ORG_P = '00000000-0000-4000-8000-0000000045c2';
const KEY_O = `o:${ORG_O}`;
const KEY_P = `o:${ORG_P}`;
const CAND_DIRECTED = '00000000-0000-4000-8000-0000000045b1';
const CAND_UNDIRECTED = '00000000-0000-4000-8000-0000000045b2';
const CAND_STALE = '00000000-0000-4000-8000-0000000045b3';
const CAND_P = '00000000-0000-4000-8000-0000000045b4';
const CAND_CONFIRMED = '00000000-0000-4000-8000-0000000045b5';
const LINK = '00000000-0000-4000-8000-0000000045b6';
const DOC = (n: number) => `00000000-0000-4000-8000-0000000045d${n}`;

type Row = Record<string, unknown>;

interface Candidate {
  id: string;
  tenant_key: string;
  document_id: string;
  candidate_document_id: string;
  direction: string | null;
  status: 'pending' | 'confirmed' | 'dismissed';
  stale: boolean;
  origin: string;
  signals: Row;
  older_document_id: string | null;
  decided_by: string | null;
}

const state = {
  guard: {} as Record<string, { ok: true; userId: string; tenantKey: string } | { ok: false; status: 401 | 403 | 503; reason: string }>,
  detect: 'off',
  candidates: [] as Candidate[],
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  dbFails: false,
};

const docJson = (id: string, uploader: string | null = UPLOADER) => ({
  id,
  lineage_id: id,
  filename: `neutral-${id.slice(-2)}.md`,
  doc_type: 'general',
  doc_date: '2025-01-01',
  effective_from: null,
  effective_to: null,
  uploaded_at: '2026-01-02T03:04:05.000Z',
  uploader_id: uploader,
  version: 1,
  is_current: true,
  status: 'ready',
});

function seed(): Candidate[] {
  const base = { status: 'pending' as const, stale: false, origin: 'detected', older_document_id: null, decided_by: null };
  return [
    { ...base, id: CAND_DIRECTED, tenant_key: KEY_O, document_id: DOC(1), candidate_document_id: DOC(2), direction: 'document_newer', signals: { title_match: true, content_overlap_percent: 0, conflicting_numbers: 0, internal_score: 0.91 } },
    { ...base, id: CAND_UNDIRECTED, tenant_key: KEY_O, document_id: DOC(3), candidate_document_id: DOC(4), direction: null, signals: { title_match: false, content_overlap_percent: 82, conflicting_numbers: 3 } },
    { ...base, id: CAND_STALE, tenant_key: KEY_O, document_id: DOC(5), candidate_document_id: DOC(6), direction: 'candidate_newer', stale: true, signals: {} },
    { ...base, id: CAND_P, tenant_key: KEY_P, document_id: DOC(7), candidate_document_id: DOC(8), direction: 'document_newer', signals: {} },
    { ...base, id: CAND_CONFIRMED, tenant_key: KEY_O, document_id: DOC(9), candidate_document_id: DOC(0), direction: 'document_newer', status: 'confirmed', older_document_id: DOC(0), decided_by: ADMIN_O, signals: {}, origin: 'uploader' },
  ];
}

function respond(data: unknown, error: { code: string; message: string } | null = null): RpcRequest {
  const response: RpcResponse = { data, error };
  const request: RpcRequest = { abortSignal: () => request, then: (ok, bad) => Promise.resolve(response).then(ok, bad) };
  return request;
}

const refuse = (word: string) => respond(null, { code: 'P0001', message: word });

/** The actor's keys, as rag_upload_approval_keys answers them: each admin administers one organization here. */
const keysOf = (actor: unknown) => (actor === ADMIN_O ? [KEY_O] : actor === ADMIN_P ? [KEY_P] : []);

function fakeDb(): RpcClient {
  return {
    rpc(fn, raw) {
      const args = (raw ?? {}) as Row;
      state.rpcCalls.push({ fn, args });
      if (state.dbFails) return respond(null, { code: 'XX000', message: 'connection reset: secret-text-placeholder' });
      const keys = keysOf(args.p_actor);
      const cand = state.candidates.find((row) => row.id === args.p_candidate_id && keys.includes(row.tenant_key));
      switch (fn) {
        case 'rag_list_supersession': {
          const allowed = typeof args.p_tenant_key === 'string' && keys.includes(args.p_tenant_key) ? [args.p_tenant_key] : [];
          const pending = state.candidates.filter((row) => row.status === 'pending' && allowed.includes(row.tenant_key));
          const links = state.candidates.filter((row) => row.status === 'confirmed' && allowed.includes(row.tenant_key));
          const rows = [
            ...pending.map((row) => ({
              kind: 'candidate', candidate_id: row.id, link_id: null, tenant_key: row.tenant_key, status: row.status, stale: row.stale, origin: row.origin,
              direction: row.direction, signals: row.signals, older_document_id: null, document: docJson(row.document_id), candidate_document: docJson(row.candidate_document_id, null),
              created_at: '2026-01-03T00:00:00.000Z', decided_by: null, decided_at: null,
            })),
            ...links.map((row) => ({
              kind: 'link', candidate_id: row.id, link_id: LINK, tenant_key: row.tenant_key, status: row.status, stale: false, origin: row.origin,
              direction: row.direction, signals: row.signals, older_document_id: row.older_document_id, document: docJson(row.older_document_id as string),
              candidate_document: docJson(row.document_id), created_at: '2026-01-03T00:00:00.000Z', decided_by: row.decided_by, decided_at: '2026-01-04T00:00:00.000Z',
            })),
          ];
          return respond(rows.map((row) => ({ ...row, total_count: rows.length })));
        }
        case 'rag_confirm_supersession': {
          if (!cand) return refuse('not_found');
          if (cand.status !== 'pending') return refuse('already_decided');
          const older = cand.direction === 'document_newer' ? cand.candidate_document_id : cand.direction === 'candidate_newer' ? cand.document_id : (args.p_older_document_id as string | null);
          if (older !== cand.document_id && older !== cand.candidate_document_id) return refuse('direction_required');
          if (args.p_older_document_id && args.p_older_document_id !== older) return refuse('direction_conflict');
          if (cand.stale) return refuse('stale_candidate');
          cand.status = 'confirmed';
          cand.older_document_id = older;
          cand.decided_by = args.p_actor as string;
          const newer = older === cand.document_id ? cand.candidate_document_id : cand.document_id;
          return respond([{ outcome: 'confirmed', candidate_id: cand.id, older_document_id: older, newer_document_id: newer, link_id: LINK }]);
        }
        case 'rag_dismiss_supersession':
          if (!cand) return refuse('not_found');
          if (cand.status !== 'pending') return refuse('already_decided');
          cand.status = 'dismissed';
          return respond([{ outcome: 'dismissed', candidate_id: cand.id }]);
        case 'rag_undo_supersession': {
          if (!cand) return refuse('not_found');
          if (cand.status !== 'confirmed') return refuse('not_confirmed');
          const older = cand.older_document_id as string;
          cand.status = 'pending';
          cand.older_document_id = null;
          return respond([{ outcome: 'undone', candidate_id: cand.id, older_document_id: older, newer_document_id: cand.document_id }]);
        }
        default:
          return respond([]);
      }
    },
  };
}

/** The admin client: the candidate tenant lookup and the auth user record for display names. */
function adminClient() {
  return {
    from(table: string) {
      const filters: Row = {};
      const query = {
        select: () => query,
        abortSignal: () => query,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return query;
        },
        maybeSingle() {
          if (state.dbFails) return Promise.resolve({ data: null, error: { message: 'down' } });
          const row = table === 'rag_supersession_candidates' ? state.candidates.find((c) => c.id === filters.id) : undefined;
          return Promise.resolve({ data: row ? { tenant_key: row.tenant_key } : null, error: null });
        },
      };
      return query;
    },
    auth: {
      admin: {
        getUserById: async (id: string) =>
          id === UPLOADER || id === ADMIN_O ? { data: { user: { id, email: id === UPLOADER ? 'uploader@example.invalid' : 'admin-o@example.invalid' } }, error: null } : { data: { user: null }, error: { message: 'missing' } },
      },
    },
  };
}

type Handler = (request: Request, context?: { params: Promise<{ id: string }> }) => Promise<Response>;

async function load() {
  vi.resetModules();
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin-route-auth')>()),
    checkAdminOrOrgAdmin: async (request: Request, organizationId: string | null | undefined) => {
      const caller = request.headers.get('x-test-caller') ?? '';
      const verdict = state.guard[`${caller}|${organizationId ?? ''}`];
      return verdict ? { ...verdict, ...(verdict.ok ? { via: 'organization_admin', organizationId: organizationId ?? null } : {}) } : { ok: false, status: 401, reason: 'unauthenticated' };
    },
  }));
  const deps = await import('@/lib/rag/ingest/deps');
  deps.setIngestDepsForTests({ db: () => fakeDb(), ingestEnv: () => ({ RAG_INGEST_PIPELINE: 'unified', RAG_SUPERSESSION_DETECT: state.detect }) });
  const ragDeps = await import('@/lib/rag/deps');
  ragDeps.setRagDepsForTests({ adminClient: () => adminClient() as never });
  return {
    list: (await import('@/app/api/rag/admin/supersession/route')).GET as Handler,
    confirm: (await import('@/app/api/rag/admin/supersession/[id]/confirm/route')).POST as Handler,
    dismiss: (await import('@/app/api/rag/admin/supersession/[id]/dismiss/route')).POST as Handler,
    undo: (await import('@/app/api/rag/admin/supersession/[id]/undo/route')).POST as Handler,
  };
}

const BASE = 'http://localhost/api/rag/admin/supersession';
const req = (caller: string, url: string, init: RequestInit = {}) =>
  new Request(url, { ...init, headers: { 'x-test-caller': caller, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const action = (caller: string, id: string, verb: string, org: string, body?: unknown) =>
  req(caller, `${BASE}/${id}/${verb}?organizationId=${org}`, { method: 'POST', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

let logs: string[] = [];

beforeEach(() => {
  state.guard = {
    [`${ADMIN_O}|${ORG_O}`]: { ok: true, userId: ADMIN_O, tenantKey: KEY_O },
    [`${ADMIN_O}|${ORG_P}`]: { ok: false, status: 403, reason: 'workspace_forbidden' },
    [`${ADMIN_P}|${ORG_P}`]: { ok: true, userId: ADMIN_P, tenantKey: KEY_P },
  };
  state.detect = 'off';
  state.candidates = seed();
  state.rpcCalls = [];
  state.dbFails = false;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void logs.push(JSON.stringify(args)));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logs.push(JSON.stringify(args)));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('@/lib/admin-route-auth');
});

describe('GET /api/rag/admin/supersession', () => {
  it("lists the workspace's pending candidates and confirmed links with the named fields only", async () => {
    const { list } = await load();
    const response = await list(req(ADMIN_O, `${BASE}?organizationId=${ORG_O}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toMatchObject({ success: true, detect: 'off', total: 4 });
    const ids = body.items.map((item: Row) => item.id);
    expect(ids).toEqual([CAND_DIRECTED, CAND_UNDIRECTED, CAND_STALE, CAND_CONFIRMED]);
    expect(ids).not.toContain(CAND_P);
    const first = body.items[0];
    expect(first).toEqual({
      kind: 'candidate',
      id: CAND_DIRECTED,
      origin: 'detected',
      direction: 'document_newer',
      stale: false,
      signals: { title_match: true, content_overlap_percent: 0, conflicting_numbers: 0 },
      document: {
        id: DOC(1),
        file_name: 'neutral-d1.md',
        doc_type: 'general',
        document_date: '2025-01-01',
        effective_from: null,
        effective_to: null,
        uploaded_at: '2026-01-02T03:04:05.000Z',
        uploader: { id: UPLOADER, display: 'uploader@example.invalid' },
      },
      candidate_document: expect.objectContaining({ id: DOC(2), uploader: null }),
      created_at: '2026-01-03T00:00:00.000Z',
    });
    expect(JSON.stringify(body)).not.toContain('internal_score');
    expect(body.items[1].direction).toBeNull();
    expect(body.items[2].stale).toBe(true);
    expect(body.items[3]).toMatchObject({
      kind: 'link',
      link_id: LINK,
      older_document: expect.objectContaining({ id: DOC(0) }),
      newer_document: expect.objectContaining({ id: DOC(9) }),
      decided_at: '2026-01-04T00:00:00.000Z',
      decided_by: { id: ADMIN_O, display: 'admin-o@example.invalid' },
    });
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_list_supersession').map((call) => call.args)).toEqual([
      { p_actor: ADMIN_O, p_tenant_key: KEY_O, p_limit: 50, p_offset: 0 },
    ]);
  });

  it("refuses organization O's admin for organization P and an unauthenticated caller", async () => {
    const { list } = await load();
    expect((await list(req(ADMIN_O, `${BASE}?organizationId=${ORG_P}`))).status).toBe(403);
    expect((await list(req('', `${BASE}?organizationId=${ORG_O}`))).status).toBe(401);
    expect(state.rpcCalls).toEqual([]);
  });

  it('still lists with the switch off, reports the switch, and answers 503 without the database message on failure', async () => {
    const { list } = await load();
    state.detect = 'on';
    const on = await (await (await load()).list(req(ADMIN_O, `${BASE}?organizationId=${ORG_O}`))).json();
    expect(on.detect).toBe('on');
    state.dbFails = true;
    const failed = await list(req(ADMIN_O, `${BASE}?organizationId=${ORG_O}`));
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain('secret-text-placeholder');
    expect(logs.join('\n')).not.toContain('secret-text-placeholder');
  });
});

describe('POST /api/rag/admin/supersession/[id]/confirm', () => {
  it('confirms a directed candidate with the guard user as actor', async () => {
    const { confirm } = await load();
    const response = await confirm(action(ADMIN_O, CAND_DIRECTED, 'confirm', ORG_O), ctx(CAND_DIRECTED));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, id: CAND_DIRECTED, outcome: 'confirmed', older_document_id: DOC(2), newer_document_id: DOC(1) });
    expect(state.rpcCalls.find((call) => call.fn === 'rag_confirm_supersession')?.args).toEqual({
      p_candidate_id: CAND_DIRECTED,
      p_actor: ADMIN_O,
      p_older_document_id: null,
    });
  });

  it('answers 400 direction_required for a candidate without direction, and confirms it once the older document is named', async () => {
    const { confirm } = await load();
    const missing = await confirm(action(ADMIN_O, CAND_UNDIRECTED, 'confirm', ORG_O), ctx(CAND_UNDIRECTED));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ success: false, error: 'direction_required' });
    const named = await confirm(action(ADMIN_O, CAND_UNDIRECTED, 'confirm', ORG_O, { olderDocumentId: DOC(3) }), ctx(CAND_UNDIRECTED));
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ older_document_id: DOC(3), newer_document_id: DOC(4) });
  });

  it('maps already_decided and stale_candidate to 409, and an unknown or foreign id to the same 404', async () => {
    const { confirm } = await load();
    const decided = await confirm(action(ADMIN_O, CAND_CONFIRMED, 'confirm', ORG_O), ctx(CAND_CONFIRMED));
    expect(decided.status).toBe(409);
    expect(await decided.json()).toEqual({ success: false, error: 'already_decided' });
    const stale = await confirm(action(ADMIN_O, CAND_STALE, 'confirm', ORG_O), ctx(CAND_STALE));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ success: false, error: 'stale_candidate' });
    const unknown = await confirm(action(ADMIN_O, '00000000-0000-4000-8000-0000000045ff', 'confirm', ORG_O), ctx('00000000-0000-4000-8000-0000000045ff'));
    const foreign = await confirm(action(ADMIN_O, CAND_P, 'confirm', ORG_O), ctx(CAND_P));
    expect(unknown.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await unknown.json());
    expect(state.candidates.find((row) => row.id === CAND_P)?.status).toBe('pending');
  });

  it("refuses organization O's admin acting on P, and P's admin decides P's candidate", async () => {
    const { confirm } = await load();
    expect((await confirm(action(ADMIN_O, CAND_P, 'confirm', ORG_P), ctx(CAND_P))).status).toBe(403);
    expect(state.candidates.find((row) => row.id === CAND_P)?.status).toBe('pending');
    expect((await confirm(action(ADMIN_P, CAND_P, 'confirm', ORG_P), ctx(CAND_P))).status).toBe(200);
  });

  it('refuses a body naming an actor or any other key, a malformed id and a malformed older document', async () => {
    const { confirm } = await load();
    expect((await confirm(action(ADMIN_O, CAND_DIRECTED, 'confirm', ORG_O, { actor: ADMIN_P }), ctx(CAND_DIRECTED))).status).toBe(400);
    expect((await confirm(action(ADMIN_O, 'not-an-id', 'confirm', ORG_O), ctx('not-an-id'))).status).toBe(400);
    expect((await confirm(action(ADMIN_O, CAND_UNDIRECTED, 'confirm', ORG_O, { olderDocumentId: 'x' }), ctx(CAND_UNDIRECTED))).status).toBe(400);
    expect(state.rpcCalls.filter((call) => call.fn === 'rag_confirm_supersession')).toEqual([]);
  });
});

describe('POST dismiss and undo', () => {
  it('dismisses a pending candidate once, then answers 409 already_decided', async () => {
    const { dismiss } = await load();
    const first = await dismiss(action(ADMIN_O, CAND_DIRECTED, 'dismiss', ORG_O), ctx(CAND_DIRECTED));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true, id: CAND_DIRECTED, outcome: 'dismissed' });
    const again = await dismiss(action(ADMIN_O, CAND_DIRECTED, 'dismiss', ORG_O), ctx(CAND_DIRECTED));
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ success: false, error: 'already_decided' });
    expect((await dismiss(action(ADMIN_O, CAND_P, 'dismiss', ORG_O), ctx(CAND_P))).status).toBe(404);
    expect((await dismiss(action(ADMIN_O, CAND_STALE, 'dismiss', ORG_O, { reason: 'x' }), ctx(CAND_STALE))).status).toBe(400);
  });

  it('undoes a confirmation, answers 409 not_confirmed for a pending candidate and 404 for a foreign one', async () => {
    const { undo } = await load();
    const done = await undo(action(ADMIN_O, CAND_CONFIRMED, 'undo', ORG_O), ctx(CAND_CONFIRMED));
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ success: true, id: CAND_CONFIRMED, outcome: 'undone', older_document_id: DOC(0), newer_document_id: DOC(9) });
    const pending = await undo(action(ADMIN_O, CAND_DIRECTED, 'undo', ORG_O), ctx(CAND_DIRECTED));
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({ success: false, error: 'not_confirmed' });
    expect((await undo(action(ADMIN_O, CAND_P, 'undo', ORG_O), ctx(CAND_P))).status).toBe(404);
  });

  it('logs ids only', async () => {
    const { confirm } = await load();
    await confirm(action(ADMIN_O, CAND_DIRECTED, 'confirm', ORG_O), ctx(CAND_DIRECTED));
    const line = logs.find((entry) => entry.includes('supersession confirmed'));
    expect(line).toBeDefined();
    expect(line).not.toContain('neutral-');
  });
});
