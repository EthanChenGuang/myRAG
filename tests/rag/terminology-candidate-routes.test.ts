import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';

/** D-26, D-06: the candidate review routes over a faked service-role client. D-35: registry languages; D-37: placeholder terms only. */
const packs = getLanguageRegistry().packs;
const HAN = packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = packs.find((pack) => pack.script === 'Latn')!.code;

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const PLAIN_USER_ID = '00000000-0000-4000-8000-0000000000c1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000000000e2';
const CANDIDATE_ID = '00000000-0000-4000-8000-0000000000f1';
const ENTRY_ID = '00000000-0000-4000-8000-0000000000d1';
const TERMS = ['termdelta', '术语丁戊', 'termepsilon'];

type Row = Record<string, unknown>;
type Outcome = { data: unknown; error: { message: string; code?: string } | null };

const state = {
  admins: [] as string[],
  tokens: {} as Record<string, string>,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  candidates: [] as Row[],
  outcomes: {} as Record<string, Outcome>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
};

function candidateRow(id: string, term: string, status: string, support: number, extra: Row = {}): Row {
  return {
    id,
    tenant_key: `u:${ADMIN_ID}`,
    term,
    language: term === '术语丁戊' ? HAN : LATIN,
    support,
    examples: [`where is ${term} described`],
    corpus_df: 0,
    status,
    source: 'miss_log',
    entry_id: null,
    first_seen: '2026-11-20T10:00:00.000Z',
    last_seen: '2026-11-26T10:00:00.000Z',
    decided_by: null,
    decided_at: null,
    ...extra,
  };
}

function thenable(outcome: unknown) {
  const request = {
    abortSignal: () => request,
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve(outcome).then(onFulfilled, onRejected),
  };
  return request;
}

function fakeClient() {
  return {
    auth: {
      getUser: async (token: string) => {
        const id = state.tokens[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      },
    },
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      const configured = state.outcomes[fn];
      if (configured) return thenable(configured);
      if (fn === 'rag_term_list_candidates') {
        const offset = args.p_offset as number;
        const page = state.candidates.slice(offset, offset + (args.p_limit as number)).map((row) => ({ ...row, total_count: state.candidates.length }));
        return thenable({ data: page, error: null });
      }
      if (fn === 'rag_term_decide_candidate') {
        const status = args.p_action === 'accept' ? 'accepted' : 'dismissed';
        return thenable({ data: [{ candidate_id: args.p_candidate_id, status, entry_id: args.p_entry_id ?? null }], error: null });
      }
      return thenable({ data: [], error: null });
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const result = () => {
        if (table === 'admin_users') return { data: state.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null };
        if (table === 'organization_members') {
          const hit = state.members.some((member) => member.organization_id === filters.organization_id && member.user_id === filters.user_id);
          return { data: hit ? { organization_id: filters.organization_id } : null, error: null };
        }
        throw new Error(`unexpected table ${table}`);
      };
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        in: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        maybeSingle: () => Promise.resolve(result()),
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise.resolve().then(result).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
}

async function load(mode: 'single-tenant' | 'multi-tenant' = 'multi-tenant') {
  vi.resetModules();
  process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE = mode;
  process.env.MYRAG_DEPLOYMENT_MODE = mode;
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => fakeClient(), getSupabase: () => ({}) }));
  return {
    list: await import('@/app/api/rag/admin/terminology/candidates/route'),
    item: await import('@/app/api/rag/admin/terminology/candidates/[id]/route'),
  };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function req(url: string, init: { method?: string; token?: string; body?: unknown; raw?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const BASE = '/api/rag/admin/terminology/candidates';
const ADMIN = 'token-admin';

const list = (loaded: Loaded, query = '', token: string | null = ADMIN) => loaded.list.GET(req(`${BASE}${query}`, { token: token ?? undefined }));
const decide = (loaded: Loaded, body: unknown, token: string | null = ADMIN, id = CANDIDATE_ID) =>
  loaded.item.PATCH(req(`${BASE}/${id}`, { method: 'PATCH', token: token ?? undefined, body }), params(id));

let logged: string[];

beforeEach(() => {
  state.admins = [ADMIN_ID];
  state.tokens = { [ADMIN]: ADMIN_ID, 'token-plain': PLAIN_USER_ID };
  state.members = [{ organization_id: ORG_ID, user_id: ADMIN_ID }];
  state.candidates = [];
  state.outcomes = {};
  state.rpcCalls = [];
  logged = [];
  for (const method of ['warn', 'error', 'log', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.NEXT_PUBLIC_MYRAG_DEPLOYMENT_MODE;
  delete process.env.MYRAG_DEPLOYMENT_MODE;
});

describe('guards', () => {
  it('answers 401 without a session and 403 for a user who is not an admin, calling no function', async () => {
    const loaded = await load();
    for (const token of [null, 'token-plain']) {
      const status = token ? 403 : 401;
      const listed = await list(loaded, '', token);
      expect(listed.status).toBe(status);
      expect(listed.headers.get('cache-control')).toBe('no-store');
      expect((await decide(loaded, { action: 'dismiss' }, token)).status).toBe(status);
    }
    expect(state.rpcCalls).toEqual([]);
  });

  it('answers 403 for an organization the admin is not a member of', async () => {
    expect((await list(await load(), `?organization_id=${OTHER_ORG_ID}`)).status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });
});

describe('GET candidates', () => {
  it('lists the pending candidates of the admin\'s own workspace by support, with the verified actor', async () => {
    state.candidates = [
      candidateRow('00000000-0000-4000-8000-0000000000f2', TERMS[1]!, 'pending', 5),
      candidateRow('00000000-0000-4000-8000-0000000000f3', TERMS[0]!, 'pending', 3),
      candidateRow('00000000-0000-4000-8000-0000000000f4', TERMS[2]!, 'dismissed', 9),
    ];
    const response = await list(await load());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.items.map((item: Row) => item.term)).toEqual([TERMS[1], TERMS[0]]);
    expect(body.items[0]).toMatchObject({ support: 5, status: 'pending', examples: [`where is ${TERMS[1]} described`], corpus_df: 0 });
    expect(body.items[0]).not.toHaveProperty('tenant_key');
    expect(body).toMatchObject({ limit: 50, offset: 0, next_offset: null });
    expect(state.rpcCalls).toEqual([{ fn: 'rag_term_list_candidates', args: { p_actor: ADMIN_ID, p_layer_key: `u:${ADMIN_ID}`, p_limit: 50, p_offset: 0 } }]);
    expect(logged.join('\n')).not.toMatch(/termdelta|术语丁戊|described/);
  });

  it('pages with limit and offset, gives next_offset while the page is full of pending rows, and lists an organization of the admin', async () => {
    state.candidates = [1, 2, 3].map((n) => candidateRow(`00000000-0000-4000-8000-00000000000${n}`, `term${n}`, 'pending', 10 - n));
    const loaded = await load();
    const first = await (await list(loaded, `?limit=2&organization_id=${ORG_ID}`)).json();
    expect(first.items).toHaveLength(2);
    expect(first.next_offset).toBe(2);
    expect(state.rpcCalls[0]!.args).toMatchObject({ p_layer_key: `o:${ORG_ID}`, p_limit: 2, p_offset: 0 });
    const last = await (await list(loaded, '?limit=2&offset=2')).json();
    expect(last.items).toHaveLength(1);
    expect(last.next_offset).toBeNull();
  });

  it('uses s:default in single-tenant mode', async () => {
    await list(await load('single-tenant'));
    expect(state.rpcCalls[0]!.args).toMatchObject({ p_actor: ADMIN_ID, p_layer_key: 's:default' });
  });

  it('answers 400 for a limit over 100, an unknown or repeated parameter, or a tenant key', async () => {
    const loaded = await load();
    for (const query of ['?limit=101', '?limit=-1', '?tenant_key=s:default', '?actor=x', '?limit=1&limit=2']) {
      const response = await list(loaded, query);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Invalid request data');
    }
    expect(state.rpcCalls).toEqual([]);
  });

  it('answers 503 with a fixed body when the database fails', async () => {
    state.outcomes.rag_term_list_candidates = { data: null, error: { message: 'relation does not exist termdelta', code: '42P01' } };
    const response = await list(await load());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('termdelta');
  });
});

describe('PATCH candidates/[id]', () => {
  it('dismisses with the verified actor and no entry', async () => {
    const response = await decide(await load(), { action: 'dismiss' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, candidate_id: CANDIDATE_ID, status: 'dismissed', entry_id: null });
    expect(state.rpcCalls).toEqual([
      { fn: 'rag_term_decide_candidate', args: { p_actor: ADMIN_ID, p_candidate_id: CANDIDATE_ID, p_action: 'dismiss', p_entry_id: null } },
    ]);
  });

  it('accepts with an entry id', async () => {
    const response = await decide(await load(), { action: 'accept', entry_id: ENTRY_ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'accepted', entry_id: ENTRY_ID });
    expect(state.rpcCalls[0]!.args).toMatchObject({ p_action: 'accept', p_entry_id: ENTRY_ID });
  });

  it('answers 404 for an entry or a candidate of another tenant, 409 for a decided candidate, 403 for a non-admin actor in SQL', async () => {
    const loaded = await load();
    state.outcomes.rag_term_decide_candidate = { data: null, error: { message: 'not_found', code: 'P0001' } };
    expect((await decide(loaded, { action: 'accept', entry_id: ENTRY_ID })).status).toBe(404);
    state.outcomes.rag_term_decide_candidate = { data: null, error: { message: 'not_pending', code: 'P0001' } };
    const decided = await decide(loaded, { action: 'dismiss' });
    expect(decided.status).toBe(409);
    expect((await decided.json()).error).toBe('not_pending');
    state.outcomes.rag_term_decide_candidate = { data: null, error: { message: 'not_admin', code: 'P0001' } };
    expect((await decide(loaded, { action: 'dismiss' })).status).toBe(403);
  });

  it('answers 400 for a bad body and 404 for an id that is not a UUID, calling no function', async () => {
    const loaded = await load();
    const bodies: unknown[] = [
      {},
      { action: 'apply' },
      { action: 'accept' },
      { action: 'dismiss', entry_id: ENTRY_ID },
      { action: 'accept', entry_id: 'not-a-uuid' },
      { action: 'dismiss', actor: ADMIN_ID },
      { action: 'dismiss', tenant_key: `u:${ADMIN_ID}` },
    ];
    for (const body of bodies) {
      const response = await decide(loaded, body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('Invalid request data');
    }
    const notJson = await loaded.item.PATCH(req(`${BASE}/${CANDIDATE_ID}`, { method: 'PATCH', token: ADMIN, raw: '{not json' }), params(CANDIDATE_ID));
    expect(notJson.status).toBe(400);
    expect((await decide(loaded, { action: 'dismiss' }, ADMIN, 'nope')).status).toBe(404);
    expect(state.rpcCalls).toEqual([]);
  });
});
