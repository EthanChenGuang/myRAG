import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigChangeRecordSchema } from '@/lib/rag-eval/contracts.generated';
import { RAG_AFFECTING_NAMES, ragSettingsHash } from '@/lib/rag';
import { adminClient, newAnswerDb, type AnswerDbState, type Row } from '../helpers/answer-db-fake';

const ADMIN = '00000000-0000-4000-8000-0000000c0a01';
const PLAIN = '00000000-0000-4000-8000-0000000c0a02';
const SHA = 'a'.repeat(40);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const REASON = 'Release accepted by the operator after review.';
const CONTRACT_KEYS = Object.keys(ConfigChangeRecordSchema.shape).sort();

let db: AnswerDbState;
let changes: Row[];
let inserts: Row[];
let changeReads: number;
let failInsert: boolean;
let failSelect: boolean;

function changeTable() {
  const ops: Array<[string, ...unknown[]]> = [];
  let since = '';
  let limit = Infinity;
  const run = () => {
    const insert = ops.find((op) => op[0] === 'insert');
    if (insert) {
      if (failInsert) return { data: null, error: { code: 'PGRST500', message: 'down' } };
      const row = { ...(insert[1] as Row), id: crypto.randomUUID(), created_at: '2026-11-26T12:00:00+00:00' };
      inserts.push(row);
      changes.push(row);
      return { data: { id: row.id }, error: null };
    }
    changeReads += 1;
    if (failSelect) return { data: null, error: { code: 'PGRST500', message: 'down' } };
    const rows = changes
      .filter((row) => String(row.created_at) >= since)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
    return { data: structuredClone(rows), error: null };
  };
  const b = {
    insert: (row: Row) => (ops.push(['insert', row]), b),
    select: (columns: string) => (ops.push(['select', columns]), b),
    gte: (_column: string, value: string) => ((since = value), b),
    order: () => b,
    limit: (n: number) => ((limit = n), b),
    single: () => Promise.resolve().then(run),
    then: (ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) => Promise.resolve().then(run).then(ok, bad),
  };
  return b;
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({ auth: { getUser: async () => ({ data: { user: db.session }, error: null }) } }),
  }));
  const base = adminClient(db) as unknown as { from: (table: string) => unknown };
  const admin = {
    ...base,
    from: (table: string) => (table === 'rag_config_change_records' ? changeTable() : base.from(table)),
  } as unknown as SupabaseClient;
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: admin, getSupabaseAdmin: () => admin, getSupabase: () => ({}) }));
  return import('@/app/api/rag/admin/config-changes/route');
}

const get = (query: string) => new NextRequest(`http://localhost/api/rag/admin/config-changes${query}`, { method: 'GET' });
const post = (body: unknown) =>
  new NextRequest('http://localhost/api/rag/admin/config-changes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function stored(over: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    created_at: '2026-11-10T10:00:00+00:00',
    actor: ADMIN,
    source: 'config_ui',
    changed_keys: ['RAG_RERANKER'],
    before_hash: H1,
    after_hash: H2,
    retrieval_config_hash: null,
    gate_result: 'pass',
    gate_summary: { checks: 2, failed: 0, skipped: 0, offenders: [], layers: { deterministic: 'pass' } },
    override_reason: null,
    uncalibrated_cells: [],
    ...over,
  };
}

const RELEASE = { source: 'release_override', gate_result: 'fail', override_reason: REASON, release_sha: SHA, github_actor: 'octo-operator' };

describe('/api/rag/admin/config-changes', () => {
  beforeEach(() => {
    db = newAnswerDb();
    db.tables.admin_users = [{ id: ADMIN }];
    changes = [];
    inserts = [];
    changeReads = 0;
    failInsert = false;
    failSelect = false;
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
  });

  it('runs the admin guard first on GET and POST', async () => {
    changes.push(stored());
    const route = await loadRoute();
    expect((await route.GET(get('?since=2026-11-01'))).status).toBe(401);
    expect((await route.POST(post(RELEASE))).status).toBe(401);
    db.session = { id: PLAIN };
    expect((await route.GET(get('?since=2026-11-01'))).status).toBe(403);
    expect((await route.POST(post(RELEASE))).status).toBe(403);
    expect(changeReads).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('lists records since a date, newest first, with the reason capped at 200 characters and counts by source and result', async () => {
    const long = `${'Operator note. '.repeat(30)}`.trim();
    changes.push(
      stored({ created_at: '2026-10-30T10:00:00+00:00' }),
      stored({ created_at: '2026-11-05T10:00:00+00:00', source: 'release_override', gate_result: 'fail', override_reason: long.slice(0, 450) }),
      stored({ created_at: '2026-11-20T10:00:00+00:00', source: 'config_ui', gate_result: 'skipped' }),
      stored({ created_at: '2026-11-21T10:00:00+00:00', source: 'cli', gate_result: 'skipped', extra_column: 'not in the contract' }),
    );
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const response = await route.GET(get('?since=2026-11-01'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['counts', 'records']);
    expect(body.records.map((r: Row) => r.created_at)).toEqual(['2026-11-20T10:00:00+00:00', '2026-11-05T10:00:00+00:00']);
    for (const record of body.records) expect(Object.keys(record).sort()).toEqual(CONTRACT_KEYS);
    expect(body.records[1].override_reason).toHaveLength(200);
    expect(body.counts).toEqual({ by_source: { config_ui: 1, release_override: 1 }, by_result: { fail: 1, skipped: 1 } });
  });

  it('accepts a full timestamp for since and applies the limit', async () => {
    changes.push(stored({ created_at: '2026-11-20T10:00:00+00:00' }), stored({ created_at: '2026-11-21T10:00:00+00:00' }));
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const body = await (await route.GET(get('?since=2026-11-01T00:00:00Z&limit=1'))).json();
    expect(body.records).toHaveLength(1);
    expect(body.records[0].created_at).toBe('2026-11-21T10:00:00+00:00');
  });

  it('answers 400 for a missing or invalid since and a limit outside 1 to 500, before any read', async () => {
    db.session = { id: ADMIN };
    const route = await loadRoute();
    for (const query of ['', '?since=yesterday', '?since=2026-13-45', '?since=2026-11-01&limit=501', '?since=2026-11-01&limit=0', '?since=2026-11-01&limit=x']) {
      const response = await route.GET(get(query));
      expect(response.status, query).toBe(400);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(Array.isArray(body.details)).toBe(true);
    }
    expect(changeReads).toBe(0);
  });

  it('answers 503 when the list read fails', async () => {
    failSelect = true;
    db.session = { id: ADMIN };
    const route = await loadRoute();
    expect((await route.GET(get('?since=2026-11-01'))).status).toBe(503);
  });

  it('records a release override with the admin as actor and returns the record id', async () => {
    vi.stubEnv('RAG_PIPELINE', 'distinctive-pipeline-value');
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const response = await route.POST(post({ ...RELEASE, override_reason: `  ${REASON}  ` }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(inserts).toHaveLength(1);
    expect(body).toEqual({ record_id: inserts[0].id });
    const row = inserts[0];
    expect(row.actor).toBe(ADMIN);
    expect(row.source).toBe('release_override');
    expect(row.gate_result).toBe('fail');
    expect(row.override_reason).toBe(REASON);
    expect(row.gate_summary).toMatchObject({ release_sha: SHA, github_actor: 'octo-operator' });
    const current = ragSettingsHash(process.env, RAG_AFFECTING_NAMES);
    expect(row.before_hash).toBe(current);
    expect(row.after_hash).toBe(current);
    expect(JSON.stringify(row)).not.toContain('distinctive-pipeline-value');
    expect(ConfigChangeRecordSchema.safeParse(row).success).toBe(true);
  });

  it('records a cli change with the given key names and hashes', async () => {
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const response = await route.POST(
      post({ source: 'cli', gate_result: 'skipped', changed_keys: ['RAG_PIPELINE'], before_hash: H1, after_hash: H2, override_reason: 'Changed in the host settings.' }),
    );
    expect(response.status).toBe(201);
    expect(inserts[0]).toMatchObject({ source: 'cli', changed_keys: ['RAG_PIPELINE'], before_hash: H1, after_hash: H2 });
  });

  it('refuses config_ui, unknown fields, a release override without a reason, release fields on cli and bad bounds', async () => {
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const bodies: unknown[] = [
      { ...RELEASE, source: 'config_ui' },
      { ...RELEASE, source: 'profile_activation' },
      { ...RELEASE, value: 'x' },
      { ...RELEASE, override_reason: undefined },
      { ...RELEASE, override_reason: '  short  ' },
      { ...RELEASE, override_reason: 'r'.repeat(501) },
      { source: 'cli', gate_result: 'skipped', release_sha: SHA },
      { ...RELEASE, release_sha: 'abc' },
      { ...RELEASE, github_actor: '-bad login-' },
      { ...RELEASE, gate_result: 'maybe' },
      { source: 'cli', gate_result: 'skipped', changed_keys: ['lower_case'] },
      { source: 'cli', gate_result: 'skipped', before_hash: 'xyz' },
      '{ not json',
      [],
    ];
    for (const body of bodies) {
      const response = await route.POST(post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).success).toBe(false);
    }
    expect(inserts).toHaveLength(0);
  });

  it('answers 503 rag_gate_record_failed when the insert fails and writes nothing', async () => {
    failInsert = true;
    db.session = { id: ADMIN };
    const route = await loadRoute();
    const response = await route.POST(post(RELEASE));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: 'rag_gate_record_failed' });
    expect(changes).toHaveLength(0);
  });

  it('logs [Config Gate] with the record id and source only', async () => {
    db.session = { id: ADMIN };
    const route = await loadRoute();
    await route.POST(post(RELEASE));
    const logged = vi.mocked(console.log).mock.calls.filter((call) => String(call[0]).includes('[Config Gate]'));
    expect(logged).toHaveLength(1);
    expect(logged[0][1]).toEqual({ recordId: inserts[0].id, source: 'release_override' });
    expect(JSON.stringify(logged)).not.toContain(REASON);
  });
});
