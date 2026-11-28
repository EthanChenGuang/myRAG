import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';

/** D-35: languages come from the registry; D-37: placeholder terms only. */
const packs = getLanguageRegistry().packs;
const HAN = packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = packs.find((pack) => pack.script === 'Latn')!.code;

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-0000000000a2';
const PLAIN_USER_ID = '00000000-0000-4000-8000-0000000000c1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const ENTRY_ID = '00000000-0000-4000-8000-0000000000d1';
const SHA = 'c'.repeat(64);
const ENTRY_TEXT = ['term alpha beta', 'termalpha', '术语甲乙丙', 'voce alfa', 'term gamma delta'];

type Row = Record<string, unknown>;
type Outcome = { data: unknown; error: { message: string; code?: string; details?: string | null } | null };

const state = {
  admins: [] as string[],
  tokens: {} as Record<string, string>,
  members: [] as Array<{ organization_id: string; user_id: string }>,
  layers: {} as Record<string, { version: number; rows: Row[] }>,
  outcomes: {} as Record<string, Outcome>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  languages: [] as string[],
};

function stored(layerKey: string, canonical: string, variants: string[], extra: Row = {}): Row {
  return {
    id: ENTRY_ID,
    layer_key: layerKey,
    canonical,
    variants,
    normalized_variants: variants,
    language: LATIN,
    kind: 'synonym',
    mode: 'one_way',
    source_language: null,
    target_language: null,
    enabled: true,
    note: null,
    suppresses_entry_id: null,
    created_by: ADMIN_ID,
    updated_by: ADMIN_ID,
    created_at: '2026-11-26T10:00:00.000Z',
    updated_at: '2026-11-26T10:00:00.000Z',
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
      if (fn === 'rag_term_list_entries') {
        const layer = state.layers[args.p_layer_key as string] ?? { version: 0, rows: [] };
        const offset = args.p_offset as number;
        const page = layer.rows.slice(offset, offset + (args.p_limit as number)).map((row) => ({ ...row, layer_version: layer.version, total_count: layer.rows.length }));
        return thenable({ data: page, error: null });
      }
      if (fn === 'rag_term_upsert_entry') {
        return thenable({ data: [{ entry_id: ENTRY_ID, layer_version: 4, entries_sha256: SHA, action: 'create' }], error: null });
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
        if (table === 'rag_term_layers') {
          const layer = state.layers[filters.layer_key as string];
          return { data: layer ? [{ layer_key: filters.layer_key, version: layer.version, entries_sha256: SHA }] : [], error: null };
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
  vi.doMock('@/lib/rag/lang/settings', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/rag/lang/settings')>();
    return {
      ...original,
      getLanguageSettings: () => ({ configured: state.languages.length > 0, languages: [...state.languages], primary: state.languages[0] ?? null, monolingual: false }),
    };
  });
  return {
    list: await import('@/app/api/rag/admin/terminology/route'),
    entry: await import('@/app/api/rag/admin/terminology/[id]/route'),
    suppressions: await import('@/app/api/rag/admin/terminology/suppressions/route'),
    versions: await import('@/app/api/rag/admin/terminology/versions/route'),
    audit: await import('@/app/api/rag/admin/terminology/audit/route'),
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
const BASE = '/api/rag/admin/terminology';
const ADMIN = 'token-admin';

function entryBody(extra: Row = {}): Row {
  return { layer: 'shared', expected_version: 3, canonical: 'term alpha beta', variants: ['termalpha'], language: LATIN, kind: 'synonym', ...extra };
}

interface RouteCase {
  name: string;
  write: boolean;
  call: (loaded: Loaded, token?: string, body?: unknown) => Promise<Response>;
}

const ROUTES: RouteCase[] = [
  { name: 'GET list', write: false, call: (l, token) => l.list.GET(req(`${BASE}?layer=shared`, { token })) },
  { name: 'POST create', write: true, call: (l, token, body) => l.list.POST(req(BASE, { method: 'POST', token, body: body ?? entryBody() })) },
  {
    name: 'PATCH entry',
    write: true,
    call: (l, token, body) => l.entry.PATCH(req(`${BASE}/${ENTRY_ID}`, { method: 'PATCH', token, body: body ?? { layer: 'shared', expected_version: 3, enabled: false } }), params(ENTRY_ID)),
  },
  {
    name: 'DELETE entry',
    write: false,
    call: (l, token) => l.entry.DELETE(req(`${BASE}/${ENTRY_ID}?layer=shared&expected_version=3`, { method: 'DELETE', token }), params(ENTRY_ID)),
  },
  {
    name: 'POST suppressions',
    write: true,
    call: (l, token, body) =>
      l.suppressions.POST(req(`${BASE}/suppressions`, { method: 'POST', token, body: body ?? { shared_entry_id: ENTRY_ID, suppressed: true, expected_version: 1 } })),
  },
  { name: 'GET versions', write: false, call: (l, token) => l.versions.GET(req(`${BASE}/versions`, { token })) },
  { name: 'GET audit', write: false, call: (l, token) => l.audit.GET(req(`${BASE}/audit?layer=shared`, { token })) },
];

let logged: string[];

beforeEach(() => {
  state.admins = [ADMIN_ID, OTHER_ADMIN_ID];
  state.tokens = { [ADMIN]: ADMIN_ID, 'token-other': OTHER_ADMIN_ID, 'token-plain': PLAIN_USER_ID };
  state.members = [{ organization_id: ORG_ID, user_id: ADMIN_ID }];
  state.layers = { shared: { version: 3, rows: [] }, [`u:${ADMIN_ID}`]: { version: 1, rows: [] } };
  state.outcomes = {};
  state.rpcCalls = [];
  state.languages = [HAN, LATIN];
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

describe.each(ROUTES)('$name: guard and Cache-Control (AGENTS.md §12)', (route) => {
  it('answers 401 without a session and calls no terminology function', async () => {
    const response = await route.call(await load());
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(state.rpcCalls).toEqual([]);
  });

  it('answers 403 for a verified user who is not an admin', async () => {
    const response = await route.call(await load(), 'token-plain');
    expect(response.status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });

  it('answers 2xx with no-store for an admin', async () => {
    state.outcomes.rag_term_delete_entry = { data: [{ layer_version: 4, entries_sha256: SHA }], error: null };
    state.outcomes.rag_term_set_suppression = { data: [{ layer_version: 2, entries_sha256: SHA, suppressed: true }], error: null };
    state.layers.shared!.rows = [stored('shared', 'term gamma delta', ['termgamma'])];
    const response = await route.call(await load(), ADMIN);
    expect([200, 201]).toContain(response.status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).success).toBe(true);
  });

  it.runIf(route.write)('answers 400 for a body that is not JSON', async () => {
    const loaded = await load();
    const response =
      route.name === 'POST create'
        ? await loaded.list.POST(req(BASE, { method: 'POST', token: ADMIN, raw: '{not json' }))
        : route.name === 'PATCH entry'
          ? await loaded.entry.PATCH(req(`${BASE}/${ENTRY_ID}`, { method: 'PATCH', token: ADMIN, raw: '{not json' }), params(ENTRY_ID))
          : await loaded.suppressions.POST(req(`${BASE}/suppressions`, { method: 'POST', token: ADMIN, raw: '{not json' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'Invalid request data', details: [{ path: '', message: 'Body is not valid JSON' }] });
  });

  it.runIf(route.write)('answers 400 with details for a body naming an actor or a tenant key', async () => {
    const loaded = await load();
    const base: Row =
      route.name === 'POST create'
        ? entryBody()
        : route.name === 'PATCH entry'
          ? { layer: 'shared', expected_version: 3 }
          : { shared_entry_id: ENTRY_ID, suppressed: true, expected_version: 1 };
    for (const field of ['actor', 'tenant_key', 'created_by', 'layer_key']) {
      const response = await route.call(loaded, ADMIN, { ...base, [field]: field === 'tenant_key' || field === 'layer_key' ? `u:${OTHER_ADMIN_ID}` : OTHER_ADMIN_ID });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe('Invalid request data');
      expect(body.details.length).toBeGreaterThan(0);
    }
    expect(state.rpcCalls).toEqual([]);
  });
});

describe('layers and workspaces (D-03)', () => {
  it('refuses the workspace layer in single-tenant mode with 400 workspace_layer_unavailable', async () => {
    const loaded = await load('single-tenant');
    const listed = await loaded.list.GET(req(`${BASE}?layer=workspace`, { token: ADMIN }));
    expect(listed.status).toBe(400);
    expect((await listed.json()).error).toBe('workspace_layer_unavailable');
    const created = await loaded.list.POST(req(BASE, { method: 'POST', token: ADMIN, body: entryBody({ layer: 'workspace' }) }));
    expect(created.status).toBe(400);
    const suppressed = await loaded.suppressions.POST(
      req(`${BASE}/suppressions`, { method: 'POST', token: ADMIN, body: { shared_entry_id: ENTRY_ID, suppressed: true, expected_version: 1 } }),
    );
    expect((await suppressed.json()).error).toBe('workspace_layer_unavailable');
    expect(state.rpcCalls).toEqual([]);
  });

  it('maps a SQL workspace_layer_unavailable to 400 too', async () => {
    state.outcomes.rag_term_list_audit = { data: null, error: { message: 'workspace_layer_unavailable' } };
    const response = await (await load()).audit.GET(req(`${BASE}/audit?layer=shared`, { token: ADMIN }));
    expect(response.status).toBe(400);
  });

  it('uses the admin personal tenant key for the workspace layer, and the organization key only for a member', async () => {
    const loaded = await load();
    await loaded.list.GET(req(`${BASE}?layer=workspace`, { token: ADMIN }));
    expect(state.rpcCalls[0]!.args).toMatchObject({ p_actor: ADMIN_ID, p_layer_key: `u:${ADMIN_ID}` });
    await loaded.list.GET(req(`${BASE}?layer=workspace&organization_id=${ORG_ID}`, { token: ADMIN }));
    expect(state.rpcCalls.at(-1)!.args).toMatchObject({ p_layer_key: `o:${ORG_ID}` });
    state.rpcCalls = [];
    const foreign = await loaded.list.GET(req(`${BASE}?layer=workspace&organization_id=${ORG_ID}`, { token: 'token-other' }));
    expect(foreign.status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });

  it('returns both versions in multi-tenant mode and no workspace in single-tenant mode', async () => {
    const multi = await (await load()).versions.GET(req(`${BASE}/versions`, { token: ADMIN }));
    expect(await multi.json()).toEqual({
      success: true,
      shared: { version: 3, entries_sha256: SHA },
      workspace: { version: 1, entries_sha256: SHA },
      enabled_languages: [HAN, LATIN],
    });
    const single = await (await load('single-tenant')).versions.GET(req(`${BASE}/versions`, { token: ADMIN }));
    expect(await single.json()).toMatchObject({ success: true, workspace: null });
  });
});

describe('validation and status mapping (D-24, D-35)', () => {
  it('lists with the enabled languages of the settings module', async () => {
    state.layers.shared!.rows = [stored('shared', 'term alpha beta', ['termalpha'])];
    const response = await (await load()).list.GET(req(`${BASE}?layer=shared&search=alpha&limit=10&offset=0`, { token: ADMIN }));
    const body = await response.json();
    expect(body).toMatchObject({ success: true, layer: 'shared', layer_version: 3, enabled_languages: [HAN, LATIN], total: 1, limit: 10, offset: 0 });
    expect(body.items[0]).toMatchObject({ id: ENTRY_ID, canonical: 'term alpha beta', variants: ['termalpha'] });
    expect(state.rpcCalls[0]!.args).toMatchObject({ p_search: 'alpha', p_limit: 10 });
  });

  it('answers 400 for a limit above 100 and for an unknown query parameter', async () => {
    const loaded = await load();
    expect((await loaded.list.GET(req(`${BASE}?limit=101`, { token: ADMIN }))).status).toBe(400);
    expect((await loaded.list.GET(req(`${BASE}?tenant_key=s:default`, { token: ADMIN }))).status).toBe(400);
  });

  it('answers 422 with the issues for a chain and writes nothing', async () => {
    state.layers.shared!.rows = [stored('shared', 'term alpha beta', ['termalpha'])];
    const response = await (await load()).list.POST(req(BASE, { method: 'POST', token: ADMIN, body: entryBody({ canonical: 'termalpha', variants: ['voce alfa'] }) }));
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Validation failed');
    expect(body.issues.map((issue: { code: string }) => issue.code)).toContain('chain');
    expect(state.rpcCalls.some((call) => call.fn === 'rag_term_upsert_entry')).toBe(false);
  });

  it('answers 201 with the override warning for a workspace entry that overrides a shared one', async () => {
    state.layers.shared!.rows = [stored('shared', 'term alpha beta', ['termalpha'])];
    const response = await (await load()).list.POST(
      req(BASE, { method: 'POST', token: ADMIN, body: entryBody({ layer: 'workspace', expected_version: 1, canonical: 'term gamma delta' }) }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, entry_id: ENTRY_ID, layer_version: 4, entries_sha256: SHA });
    expect(body.warnings.map((issue: { code: string }) => issue.code)).toContain('override');
  });

  it('creates a translation pair between two enabled languages (D-32)', async () => {
    const response = await (await load()).list.POST(
      req(BASE, {
        method: 'POST',
        token: ADMIN,
        body: entryBody({ canonical: 'term alpha beta', variants: ['术语甲乙丙'], language: HAN, kind: 'translation', source_language: HAN, target_language: LATIN }),
      }),
    );
    expect(response.status).toBe(201);
    const write = state.rpcCalls.find((call) => call.fn === 'rag_term_upsert_entry')!;
    expect(write.args.p_entry).toMatchObject({ kind: 'translation', source_language: HAN, target_language: LATIN });
    expect(write.args).toMatchObject({ p_actor: ADMIN_ID, p_layer_key: 'shared' });
  });

  it('answers 422 invalid_language for a language that is not enabled, and invalid_translation for equal languages', async () => {
    state.languages = [LATIN];
    const loaded = await load();
    const notEnabled = await loaded.list.POST(
      req(BASE, {
        method: 'POST',
        token: ADMIN,
        body: entryBody({ canonical: 'term alpha beta', variants: ['术语甲乙丙'], language: HAN, kind: 'translation', source_language: HAN, target_language: LATIN }),
      }),
    );
    expect(notEnabled.status).toBe(422);
    expect((await notEnabled.json()).issues.map((issue: { code: string }) => issue.code)).toContain('invalid_language');

    state.languages = [HAN, LATIN];
    const equal = await loaded.list.POST(
      req(BASE, { method: 'POST', token: ADMIN, body: entryBody({ kind: 'translation', source_language: LATIN, target_language: LATIN }) }),
    );
    expect(equal.status).toBe(422);
    expect((await equal.json()).issues.map((issue: { code: string }) => issue.code)).toContain('invalid_translation');
  });

  it('answers 409 with current_version for a stale PATCH', async () => {
    state.layers.shared = { version: 5, rows: [stored('shared', 'term alpha beta', ['termalpha'])] };
    const response = await (await load()).entry.PATCH(
      req(`${BASE}/${ENTRY_ID}`, { method: 'PATCH', token: ADMIN, body: { layer: 'shared', expected_version: 3, enabled: false } }),
      params(ENTRY_ID),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'version_conflict', current_version: 5 });
  });

  it('answers 409 with current_version from the SQL detail', async () => {
    state.outcomes.rag_term_delete_entry = { data: null, error: { message: 'version_conflict', details: '{"current_version": 8}' } };
    const response = await (await load()).entry.DELETE(req(`${BASE}/${ENTRY_ID}?layer=shared&expected_version=3`, { method: 'DELETE', token: ADMIN }), params(ENTRY_ID));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: 'version_conflict', current_version: 8 });
  });

  const SQL_CASES: Array<[string, number]> = [
    ['not_admin', 403],
    ['not_admin_of_layer', 403],
    ['not_found', 404],
    ['limit', 413],
    ['invalid_entry', 422],
    ['deadlock detected near term alpha beta', 503],
  ];
  for (const [message, status] of SQL_CASES) {
    it(`maps the SQL error ${message.split(' ')[0]} to ${status} without detail`, async () => {
      state.outcomes.rag_term_upsert_entry = { data: null, error: { message, code: 'P0001' } };
      const response = await (await load()).list.POST(req(BASE, { method: 'POST', token: ADMIN, body: entryBody() }));
      expect(response.status).toBe(status);
      const text = await response.text();
      for (const term of ENTRY_TEXT) expect(text).not.toContain(term);
      expect(text).not.toContain('deadlock');
    });
  }

  it('answers 404 for an entry id that is not a uuid', async () => {
    const response = await (await load()).entry.PATCH(
      req(`${BASE}/not-a-uuid`, { method: 'PATCH', token: ADMIN, body: { layer: 'shared', expected_version: 3 } }),
      params('not-a-uuid'),
    );
    expect(response.status).toBe(404);
  });

  it('logs with [RAG Admin] and never the entry text', async () => {
    const loaded = await load();
    await loaded.list.POST(req(BASE, { method: 'POST', token: ADMIN, body: entryBody() }));
    state.outcomes.rag_term_upsert_entry = { data: null, error: { message: 'boom', code: 'XX000' } };
    await loaded.list.POST(req(BASE, { method: 'POST', token: ADMIN, body: entryBody() }));
    const ours = logged.filter((line) => line.includes('terminology'));
    expect(ours.length).toBeGreaterThanOrEqual(2);
    for (const line of ours) expect(line).toContain('[RAG Admin]');
    for (const term of ENTRY_TEXT) expect(logged.join('\n')).not.toContain(term);
  });
});
