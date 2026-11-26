import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';

/** D-35: languages come from the registry; D-37: placeholder terms only. */
const packs = getLanguageRegistry().packs;
const HAN = packs.find((pack) => pack.script === 'Hani')!.code;
const LATIN = packs.find((pack) => pack.script === 'Latn')!.code;
const THIRD = packs.find((pack) => pack.code !== HAN && pack.code !== LATIN)!.code;

const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-0000000000a2';
const PLAIN_USER_ID = '00000000-0000-4000-8000-0000000000c1';
const ORG_ID = '00000000-0000-4000-8000-0000000000e1';
const ENTRY_ID = '00000000-0000-4000-8000-0000000000d1';
const SHA = 'c'.repeat(64);

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

let nextId = 0;
function stored(layerKey: string, canonical: string, variants: string[], extra: Row = {}): Row {
  nextId += 1;
  return {
    id: `00000000-0000-4000-8000-${String(nextId).padStart(12, '0')}`,
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
      if (fn === 'rag_term_apply_import') {
        const rows = args.p_rows as unknown[];
        return thenable({ data: [{ layer_version: (args.p_expected_version as number) + 1, entries_sha256: SHA, created: rows.length, updated: 0, unchanged: 0, deleted: 0 }], error: null });
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
    importRoute: await import('@/app/api/rag/admin/terminology/import/route'),
    exportRoute: await import('@/app/api/rag/admin/terminology/export/route'),
  };
}

type Loaded = Awaited<ReturnType<typeof load>>;

function req(url: string, init: { method?: string; token?: string; body?: unknown; raw?: string } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const body = init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  return new Request(`http://localhost${url}`, { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) });
}

const BASE = '/api/rag/admin/terminology';
const ADMIN = 'token-admin';
const HEADER = 'canonical,variants,language,kind,mode,enabled,note,source_language,target_language';
const WORKSPACE_KEY = `u:${ADMIN_ID}`;

function csvOf(...lines: string[]): string {
  return [HEADER, ...lines].join('\n');
}

const line = (canonical: string, variants: string, language = LATIN, kind = 'synonym', rest = 'one_way,true,,,') => `${canonical},${variants},${language},${kind},${rest}`;

async function postImport(loaded: Loaded, body: Row, token = ADMIN): Promise<{ status: number; body: Record<string, any>; headers: Headers }> {
  const response = await loaded.importRoute.POST(req(`${BASE}/import`, { method: 'POST', token, body }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

const applyCalls = () => state.rpcCalls.filter((call) => call.fn === 'rag_term_apply_import');

let logged: string[];

beforeEach(() => {
  nextId = 0;
  state.admins = [ADMIN_ID, OTHER_ADMIN_ID];
  state.tokens = { [ADMIN]: ADMIN_ID, 'token-other': OTHER_ADMIN_ID, 'token-plain': PLAIN_USER_ID };
  state.members = [{ organization_id: ORG_ID, user_id: ADMIN_ID }];
  state.layers = {
    shared: {
      version: 3,
      rows: [stored('shared', 'term alpha beta', ['termalpha']), stored('shared', 'term gamma delta', ['termgamma'])],
    },
    [WORKSPACE_KEY]: { version: 1, rows: [] },
  };
  state.outcomes = {};
  state.rpcCalls = [];
  state.languages = [HAN, LATIN, THIRD];
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

describe('POST /api/rag/admin/terminology/import: dry run (D-23)', () => {
  it('reports 3 creates, 1 update and 1 unchanged and writes nothing', async () => {
    const csv = csvOf(
      line('term alpha beta', 'termalpha'),
      line('term gamma delta', 'termgamma|gamma'),
      line('term epsilon zeta', 'termepsilon'),
      line('term eta theta', 'termeta'),
      line('术语甲乙丙', '术语甲', HAN),
    );
    const answer = await postImport(await load(), { layer: 'shared', csv });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(answer.body.report).toEqual({ applied: false, create: 3, update: 1, unchanged: 1, delete: 0, issues: [], layer_version_seen: 3 });
    expect(applyCalls()).toEqual([]);
  });

  it('lists the deletes of replace mode', async () => {
    const answer = await postImport(await load(), { layer: 'shared', mode: 'replace', csv: csvOf(line('term alpha beta', 'termalpha')) });
    expect(answer.status).toBe(200);
    expect(answer.body.report).toMatchObject({ create: 0, update: 0, unchanged: 1, delete: 1, applied: false });
    expect(applyCalls()).toEqual([]);
  });

  it('keys the diff on target language too: two translation pairs of one canonical are two entries', async () => {
    const csv = csvOf(
      line('term alpha beta', '术语甲乙丙', HAN, 'translation', `one_way,true,,${HAN},${LATIN}`),
      line('term alpha beta', '术语甲乙丙', HAN, 'translation', `one_way,true,,${HAN},${THIRD}`),
    );
    const answer = await postImport(await load(), { layer: 'shared', csv });
    expect(answer.status).toBe(200);
    expect(answer.body.report).toMatchObject({ create: 2, update: 0, unchanged: 0, issues: [] });
  });

  it('reports a repeated key as a duplicate', async () => {
    const answer = await postImport(await load(), { layer: 'shared', csv: csvOf(line('term zeta eta', 'termzeta'), line('Term Zeta Eta', 'termzz')) });
    expect(answer.body.report.issues).toEqual([expect.objectContaining({ row: 2, code: 'duplicate', severity: 'error' })]);
  });

  it('reports a chain and refuses to apply the same file with 422', async () => {
    const csv = csvOf(line('term zeta eta', 'term alpha beta'));
    const loaded = await load();
    const dry = await postImport(loaded, { layer: 'shared', csv });
    expect(dry.status).toBe(200);
    expect(dry.body.report.applied).toBe(false);
    expect(dry.body.report.issues.some((issue: { code: string }) => issue.code === 'chain')).toBe(true);
    const applied = await postImport(loaded, { layer: 'shared', csv, dry_run: false, expected_version: 3 });
    expect(applied.status).toBe(422);
    expect(applied.body.issues.some((issue: { code: string }) => issue.code === 'chain')).toBe(true);
    expect(applyCalls()).toEqual([]);
  });

  it('reports a translation pair to a language that is not enabled as invalid_language, and one to its own language as invalid_translation', async () => {
    state.languages = [HAN, LATIN];
    const csv = csvOf(
      line('term alpha beta', '术语甲乙丙', HAN, 'translation', `one_way,true,,${HAN},${THIRD}`),
      line('术语丁戊己', '术语丁', HAN, 'translation', `one_way,true,,${HAN},${HAN}`),
    );
    const loaded = await load();
    const dry = await postImport(loaded, { layer: 'shared', csv });
    const codes = dry.body.report.issues.map((issue: { row: number; code: string }) => [issue.row, issue.code]);
    expect(codes).toContainEqual([1, 'invalid_language']);
    expect(codes).toContainEqual([2, 'invalid_translation']);
    const applied = await postImport(loaded, { layer: 'shared', csv, dry_run: false, expected_version: 3 });
    expect(applied.status).toBe(422);
    expect(applyCalls()).toEqual([]);
  });

  it('answers 400 invalid_file with row numbers for a malformed CSV, and 413 for a file over the row limit', async () => {
    const loaded = await load();
    const bad = await postImport(loaded, { layer: 'shared', csv: csvOf(line('term alpha beta', 'termalpha'), 'term gamma delta,termgamma') });
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ success: false, error: 'invalid_file', errors: [expect.objectContaining({ row: 2 })] });
    const many = Array.from({ length: 5001 }, (_, index) => line(`term ${index}`, `t${index}`));
    const over = await postImport(loaded, { layer: 'shared', csv: csvOf(...many) });
    expect(over.status).toBe(413);
    expect(state.rpcCalls).toEqual([]);
  });
});

describe('POST /api/rag/admin/terminology/import: apply (D-05, D-23)', () => {
  it('applies with the version the dry run saw, sending normalized variants and the mode', async () => {
    const loaded = await load();
    const csv = csvOf(line('term epsilon zeta', 'TermEpsilon'));
    const applied = await postImport(loaded, { layer: 'shared', csv, dry_run: false, expected_version: 3, mode: 'merge' });
    expect(applied.status).toBe(200);
    expect(applied.body.report).toMatchObject({ applied: true, create: 1, layer_version_seen: 3 });
    expect(applied.body.layer_version).toBe(4);
    const [call] = applyCalls();
    expect(call!.args).toMatchObject({ p_actor: ADMIN_ID, p_layer_key: 'shared', p_mode: 'merge', p_expected_version: 3 });
    expect((call!.args.p_rows as Row[])[0]).toMatchObject({ canonical: 'term epsilon zeta', variants: ['TermEpsilon'], normalized_variants: ['termepsilon'] });
    expect(logged.join('\n')).not.toContain('TermEpsilon');
  });

  it('answers 409 with the current version when the layer moved since the dry run', async () => {
    const answer = await postImport(await load(), { layer: 'shared', csv: csvOf(line('term epsilon zeta', 'termepsilon')), dry_run: false, expected_version: 2 });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ success: false, error: 'version_conflict', current_version: 3 });
    expect(applyCalls()).toEqual([]);
  });

  it('maps a version conflict raised by the writer to 409', async () => {
    state.outcomes.rag_term_apply_import = { data: null, error: { message: 'version_conflict', details: JSON.stringify({ current_version: 5 }) } };
    const answer = await postImport(await load(), { layer: 'shared', csv: csvOf(line('term epsilon zeta', 'termepsilon')), dry_run: false, expected_version: 3 });
    expect(answer.status).toBe(409);
    expect(answer.body.current_version).toBe(5);
  });

  it('requires expected_version to apply', async () => {
    const answer = await postImport(await load(), { layer: 'shared', csv: csvOf(line('term epsilon zeta', 'termepsilon')), dry_run: false });
    expect(answer.status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });
});

describe('import and export guards', () => {
  it('answers 401 and 403 without an admin session, calling nothing', async () => {
    const loaded = await load();
    const body = { layer: 'shared', csv: csvOf(line('term alpha beta', 'termalpha')) };
    expect((await loaded.importRoute.POST(req(`${BASE}/import`, { method: 'POST', body }))).status).toBe(401);
    expect((await postImport(loaded, body, 'token-plain')).status).toBe(403);
    expect((await loaded.exportRoute.GET(req(`${BASE}/export?layer=shared`, { token: 'token-plain' }))).status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });

  it('answers 413 for a body over 1.5 MB before parsing it', async () => {
    const loaded = await load();
    const raw = `{"layer":"shared","csv":"${'x'.repeat(1.5 * 1024 * 1024)}"}`;
    const response = await loaded.importRoute.POST(req(`${BASE}/import`, { method: 'POST', token: ADMIN, raw }));
    expect(response.status).toBe(413);
    const unparsable = await loaded.importRoute.POST(req(`${BASE}/import`, { method: 'POST', token: ADMIN, raw: `{${'x'.repeat(1.6 * 1024 * 1024)}` }));
    expect(unparsable.status).toBe(413);
    expect(state.rpcCalls).toEqual([]);
  });

  it('refuses a body naming a tenant key or an actor', async () => {
    const loaded = await load();
    for (const field of ['tenant_key', 'actor', 'layer_key']) {
      const answer = await postImport(loaded, { layer: 'shared', csv: csvOf(line('term alpha beta', 'termalpha')), [field]: `u:${OTHER_ADMIN_ID}` });
      expect(answer.status).toBe(400);
    }
    expect(state.rpcCalls).toEqual([]);
  });
});

describe('GET /api/rag/admin/terminology/export (D-23)', () => {
  it('returns a formula-safe CSV attachment with the nine-column header, translation pairs with both languages', async () => {
    state.layers.shared!.rows.push(
      stored('shared', '=SUM(A1)', ['-1']),
      stored('shared', 'term alpha beta', ['术语甲乙丙'], { language: HAN, kind: 'translation', source_language: HAN, target_language: LATIN }),
      stored('shared', 'term omega', [], { suppresses_entry_id: ENTRY_ID }),
    );
    const response = await (await load()).exportRoute.GET(req(`${BASE}/export?layer=shared`, { token: ADMIN }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="terminology-shared-v3.csv"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const lines = (await response.text()).split('\r\n');
    expect(lines[0]).toBe(HEADER);
    expect(lines).toContain(`'=SUM(A1),'-1,${LATIN},synonym,one_way,true,,,`);
    expect(lines).toContain(`term alpha beta,术语甲乙丙,${HAN},translation,one_way,true,,${HAN},${LATIN}`);
    expect(lines.some((value) => value.startsWith('term omega'))).toBe(false);
  });

  it('round-trips: importing the export of a layer in merge mode changes nothing', async () => {
    state.layers.shared!.rows.push(
      stored('shared', '=SUM(A1)', ['-1', "'hello"], { note: 'a, "note"' }),
      stored('shared', 'term alpha beta', ['术语甲乙丙'], { language: HAN, kind: 'translation', source_language: HAN, target_language: LATIN }),
      stored('shared', 'term eta theta', ['termeta', 'eta'], { mode: 'equivalent', enabled: false }),
    );
    const loaded = await load();
    const csv = await (await loaded.exportRoute.GET(req(`${BASE}/export?layer=shared`, { token: ADMIN }))).text();
    const answer = await postImport(loaded, { layer: 'shared', csv });
    expect(answer.status).toBe(200);
    expect(answer.body.report).toEqual({ applied: false, create: 0, update: 0, unchanged: 5, delete: 0, issues: [], layer_version_seen: 3 });
  });

  it('answers 400 workspace_layer_unavailable for the workspace layer in single-tenant mode', async () => {
    const response = await (await load('single-tenant')).exportRoute.GET(req(`${BASE}/export?layer=workspace`, { token: ADMIN }));
    expect(response.status).toBe(400);
  });
});

describe('DictionaryCandidate JSONL import (D-25a)', () => {
  const REVIEW = '00000000-0000-4000-8000-0000000000f1';
  const candidate = (extra: Row = {}) =>
    JSON.stringify({
      tenant_key: WORKSPACE_KEY,
      language: LATIN,
      observed_term: 'termiota',
      canonical_term: 'term iota kappa',
      relation: 'synonym',
      example_review_item_ids: [REVIEW],
      occurrences: 2,
      ...extra,
    });

  it('rejects a row naming another tenant and writes nothing', async () => {
    const jsonl = [candidate(), candidate({ tenant_key: `u:${OTHER_ADMIN_ID}` })].join('\n');
    const answer = await postImport(await load(), { layer: 'workspace', format: 'dictionary_candidates_jsonl', jsonl, dry_run: false, expected_version: 1 });
    expect(answer.status).toBe(400);
    expect(answer.body.errors).toEqual([expect.objectContaining({ row: 2 })]);
    expect(applyCalls()).toEqual([]);
  });

  it('maps candidates to entries; a translation with canonical_language becomes a pair, one without it is invalid_translation', async () => {
    const loaded = await load();
    const good = [
      candidate(),
      candidate({ observed_term: 'iota' }),
      candidate({ language: HAN, observed_term: '术语甲乙丙', canonical_term: 'term alpha beta', relation: 'translation', canonical_language: LATIN }),
    ].join('\n');
    const dry = await postImport(loaded, { layer: 'workspace', format: 'dictionary_candidates_jsonl', jsonl: good });
    expect(dry.status).toBe(200);
    expect(dry.body.report).toMatchObject({ create: 2, issues: [], layer_version_seen: 1 });
    const applied = await postImport(loaded, { layer: 'workspace', format: 'dictionary_candidates_jsonl', jsonl: good, dry_run: false, expected_version: 1 });
    expect(applied.status).toBe(200);
    const rows = applyCalls()[0]!.args.p_rows as Row[];
    expect(applyCalls()[0]!.args.p_layer_key).toBe(WORKSPACE_KEY);
    expect(rows).toEqual([
      expect.objectContaining({ canonical: 'term iota kappa', variants: ['termiota', 'iota'], kind: 'synonym', language: LATIN, target_language: null }),
      expect.objectContaining({ canonical: 'term alpha beta', variants: ['术语甲乙丙'], kind: 'translation', language: HAN, source_language: HAN, target_language: LATIN }),
    ]);

    const missing = candidate({ language: HAN, observed_term: '术语丁', canonical_term: 'term gamma delta', relation: 'translation' });
    const refused = await postImport(loaded, { layer: 'workspace', format: 'dictionary_candidates_jsonl', jsonl: missing });
    expect(refused.body.report.issues).toEqual([expect.objectContaining({ row: 1, code: 'invalid_translation', severity: 'error' })]);
  });

  it('adds a candidate variant to a stored entry instead of replacing it', async () => {
    state.layers[WORKSPACE_KEY]!.rows = [stored(WORKSPACE_KEY, 'term iota kappa', ['iotak'], { note: 'kept' })];
    const loaded = await load();
    await postImport(loaded, { layer: 'workspace', format: 'dictionary_candidates_jsonl', jsonl: candidate(), dry_run: false, expected_version: 1 });
    expect((applyCalls()[0]!.args.p_rows as Row[])[0]).toMatchObject({ variants: ['iotak', 'termiota'], note: 'kept' });
  });
});
