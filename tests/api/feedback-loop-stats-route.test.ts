import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackLoopStatsSchema } from '@/lib/rag-eval/contracts.generated';
import { ADMIN_ID, USER_ID, silenceConsole } from '../helpers/admin-guard-fixture';

const TENANT_A = 'o:11111111-1111-4111-8111-111111111111';
const TENANT_B = 's:default';
const MARKER = 'synthetic marker sentence about a widget';

type Row = Record<string, unknown>;

interface State {
  session: { id: string } | null;
  authThrows: boolean;
  lookupFails: boolean;
  dataCalls: string[];
  failTable: string | null;
  tables: Record<string, Row[]>;
}

let state: State;

function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function log(tenant: string, created: string, extra: Row = {}): Row {
  return {
    id: `${tenant}-${created}-${Math.random()}`,
    tenant_key: tenant,
    created_at: created,
    channel: 'chat',
    outcome: 'answered',
    candidate_count: 5,
    top_score: 0.8,
    feedback_vote: null,
    feedback_kind: null,
    source_opened_count: 0,
    candidates: [{ chunk_id: 'c1', similarity: 0.8 }],
    query_masked: MARKER,
    ...extra,
  };
}

function item(tenant: string, extra: Row): Row {
  return { id: `${tenant}-${Math.random()}`, tenant_key: tenant, query_masked: MARKER, status: 'open', triage: [], labelled_at: null, ...extra };
}

/** Two tenants inside 2026-11-01..2026-11-08 plus rows outside the window that must not count. */
function fixtureTables(): Record<string, Row[]> {
  return {
    rag_retrieval_log: [
      log(TENANT_A, '2026-11-01T00:00:00.000Z', { feedback_vote: 1, feedback_kind: 'answer', source_opened_count: 2 }),
      log(TENANT_A, '2026-11-02T10:00:00.000Z', { feedback_vote: -1, feedback_kind: 'answer', top_score: 0.2 }),
      log(TENANT_A, '2026-11-03T10:00:00.000Z', {
        channel: 'embed',
        feedback_vote: -1,
        feedback_kind: 'embed',
        top_score: 0.1,
        candidates: [{ chunk_id: 'c1', similarity: 0.4, rerank_score: 0.1 }],
      }),
      log(TENANT_A, '2026-11-04T10:00:00.000Z', {
        outcome: 'refused_no_context',
        candidate_count: 0,
        top_score: null,
        candidates: [],
        feedback_vote: -1,
        feedback_kind: 'refusal',
      }),
      log(TENANT_A, '2026-11-05T10:00:00.000Z', { channel: 'voice', outcome: 'kb_unavailable', candidate_count: 0, top_score: null, candidates: [] }),
      log(TENANT_A, '2026-11-08T00:00:00.000Z', { feedback_vote: -1, feedback_kind: 'answer' }),
      log(TENANT_A, '2026-10-31T23:59:59.000Z', { feedback_vote: -1, feedback_kind: 'answer' }),
      log(TENANT_B, '2026-11-06T10:00:00.000Z', { outcome: 'refused_no_context', feedback_vote: 1, feedback_kind: 'refusal', top_score: 0.3 }),
      log(TENANT_B, '2026-11-07T10:00:00.000Z', { candidate_count: 0, outcome: 'degraded_answer', top_score: null, candidates: [] }),
      log(TENANT_B, '2026-11-07T11:00:00.000Z', { source_opened_count: 1, top_score: 0.5 }),
    ],
    rag_review_items: [
      item(TENANT_A, { mined_at: '2026-11-02T00:00:00.000Z' }),
      item(TENANT_A, {
        mined_at: '2026-11-02T00:00:00.000Z',
        status: 'labelled',
        triage: ['dictionary', 'golden'],
        labelled_at: '2026-11-03T00:00:00.000Z',
      }),
      item(TENANT_A, { mined_at: '2026-10-20T00:00:00.000Z', status: 'exported', triage: ['golden'], labelled_at: '2026-11-04T00:00:00.000Z' }),
      item(TENANT_A, { mined_at: '2026-11-03T00:00:00.000Z', status: 'skipped', labelled_at: '2026-11-05T00:00:00.000Z' }),
      item(TENANT_B, { mined_at: '2026-11-06T00:00:00.000Z', status: 'labelled', triage: ['kb_gap'], labelled_at: '2026-11-09T00:00:00.000Z' }),
      item(TENANT_B, { mined_at: '2026-11-09T00:00:00.000Z' }),
    ],
  };
}

function pick(row: Row, select: string): Row {
  const out: Row = {};
  for (const field of select.split(',')) {
    const [alias, expression] = field.includes(':') ? field.split(':') : [field, field];
    if (expression === 'candidates->0->rerank_score') {
      const first = (row.candidates as Row[] | undefined)?.[0];
      out[alias] = first && 'rerank_score' in first ? first.rerank_score : null;
    } else {
      out[alias] = row[expression];
    }
  }
  return out;
}

function fakeAdmin() {
  return {
    auth: { getUser: async () => ({ data: { user: null }, error: { message: 'invalid' } }) },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const predicates: Array<(row: Row) => boolean> = [];
      let select = '*';
      let range: [number, number] = [0, Number.MAX_SAFE_INTEGER];
      if (table !== 'admin_users') state.dataCalls.push(table);
      const builder: Record<string, unknown> = {};
      builder.abortSignal = () => builder;
      builder.order = () => builder;
      builder.select = (columns: string) => {
        select = columns;
        return builder;
      };
      builder.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      };
      builder.gte = (column: string, value: string) => {
        predicates.push((row) => typeof row[column] === 'string' && (row[column] as string) >= value);
        return builder;
      };
      builder.lt = (column: string, value: string) => {
        predicates.push((row) => typeof row[column] === 'string' && (row[column] as string) < value);
        return builder;
      };
      builder.not = (column: string) => {
        predicates.push((row) => row[column] !== null && row[column] !== undefined);
        return builder;
      };
      builder.range = (from: number, to: number) => {
        range = [from, to];
        return builder;
      };
      const settle = () => {
        if (table === 'admin_users') {
          if (state.lookupFails) return { data: null, error: { message: 'down' } };
          return { data: filters.id === ADMIN_ID ? { id: ADMIN_ID } : null, error: null };
        }
        if (state.failTable === table) return { data: null, error: { code: '42501', message: 'secret detail' } };
        const rows = (state.tables[table] ?? []).filter((row) => predicates.every((test) => test(row)));
        return { data: rows.slice(range[0], range[1] + 1).map((row) => pick(row, select)), error: null };
      };
      builder.maybeSingle = () => Promise.resolve(settle());
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(settle()).then(onFulfilled, onRejected);
      return builder;
    },
  };
}

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (state.authThrows) throw new Error('auth down');
          return { data: { user: state.session } };
        },
      },
    }),
  }));
  const admin = fakeAdmin();
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin, supabaseAdmin: admin, getSupabase: () => ({}) }));
  return import('@/app/api/rag/admin/feedback-loop/stats/route');
}

function req(query = '', headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/rag/admin/feedback-loop/stats${query}`, { method: 'GET', headers });
}

beforeEach(() => {
  state = { session: null, authThrows: false, lookupFails: false, dataCalls: [], failTable: null, tables: fixtureTables() };
  silenceConsole();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/supabase/server');
});

describe('GET /api/rag/admin/feedback-loop/stats (D-25)', () => {
  it('runs the admin guard first: 401, forged cookie 401, 403, 503, and reads nothing before it', async () => {
    const route = await loadRoute();
    const query = '?since=2026-11-01&until=2026-11-08';
    expect((await route.GET(req(query))).status).toBe(401);
    expect((await route.GET(req(query, { cookie: 'admin_session=forged-value' }))).status).toBe(401);
    state.session = { id: USER_ID };
    expect((await route.GET(req(query))).status).toBe(403);
    state.session = { id: ADMIN_ID };
    state.lookupFails = true;
    expect((await route.GET(req(query))).status).toBe(503);
    state.session = null;
    state.lookupFails = false;
    state.authThrows = true;
    expect((await route.GET(req(query))).status).toBe(503);
    expect(state.dataCalls).toEqual([]);
  });

  it('answers 400 for a 100-day window, a reversed window, a bad date or an unknown parameter, and reads nothing', async () => {
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    for (const query of [
      '?since=2026-08-01&until=2026-11-09',
      '?since=2026-11-08&until=2026-11-01',
      '?since=tomorrow',
      '?since=2026-02-30',
      '?since=2026-11-01&tenantKey=s:default',
    ]) {
      const response = await route.GET(req(query));
      expect(response.status, query).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(state.dataCalls).toEqual([]);
  });

  it('accepts a 92-day window', async () => {
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    const response = await route.GET(req('?since=2026-08-08&until=2026-11-08'));
    expect(response.status).toBe(200);
  });

  it('returns per-tenant-hash counts that match hand counts, with no tenant key or text', async () => {
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    const response = await route.GET(req('?since=2026-11-01&until=2026-11-08'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const json = await response.json();
    expect(json.success).toBe(true);
    const stats = FeedbackLoopStatsSchema.parse(json.stats);
    expect(stats.since).toBe('2026-11-01T00:00:00.000Z');
    expect(stats.until).toBe('2026-11-08T00:00:00.000Z');
    const tenants = stats.tenants ?? [];
    expect(tenants.map((tenant) => tenant.tenant_hash)).toEqual([hashOf(TENANT_A), hashOf(TENANT_B)].sort());
    const a = tenants.find((tenant) => tenant.tenant_hash === hashOf(TENANT_A))!;
    const b = tenants.find((tenant) => tenant.tenant_hash === hashOf(TENANT_B))!;

    expect(a.retrievals).toBe(5);
    expect(a.retrievals_by_channel).toEqual({ chat: 3, embed: 1, voice: 1 });
    expect(a.outcomes).toEqual({ answered: 3, refused_no_context: 1, kb_unavailable: 1, degraded_answer: 0, unknown: 0 });
    expect(a.refusal_rate).toBeCloseTo(1 / 5);
    expect(a.zero_result_rate).toBeCloseTo(1 / 5);
    expect(a.low_score_rate).toBeCloseTo(2 / 3);
    expect(a.votes).toEqual({ answer_up: 1, answer_down: 1, refusal_up: 0, refusal_down: 1, embed_up: 0, embed_down: 1 });
    expect(a.thumbs_down_rate).toBeCloseTo(3 / 4);
    expect(a.refusal_disputes).toBe(1);
    expect(a.source_open_rate).toBeCloseTo(1 / 3);
    expect([a.items_mined, a.items_labelled, a.items_skipped, a.items_exported]).toEqual([3, 2, 1, 1]);
    expect(a.triage).toEqual({ dictionary: 1, training: 0, golden: 2, kb_gap: 0, not_a_failure: 0 });

    expect(b.retrievals).toBe(3);
    expect(b.retrievals_by_channel).toEqual({ chat: 3, embed: 0, voice: 0 });
    expect(b.outcomes).toEqual({ answered: 1, refused_no_context: 1, kb_unavailable: 0, degraded_answer: 1, unknown: 0 });
    expect(b.zero_result_rate).toBeCloseTo(1 / 3);
    expect(b.low_score_rate).toBe(0);
    expect(b.votes).toEqual({ answer_up: 0, answer_down: 0, refusal_up: 1, refusal_down: 0, embed_up: 0, embed_down: 0 });
    expect(b.thumbs_down_rate).toBe(0);
    expect(b.refusal_disputes).toBe(0);
    expect(b.source_open_rate).toBe(1);
    expect([b.items_mined, b.items_labelled, b.items_skipped, b.items_exported]).toEqual([1, 0, 0, 0]);

    const text = JSON.stringify(json);
    expect(text).not.toContain(TENANT_A.slice(2));
    expect(text).not.toContain(TENANT_B);
    expect(text).not.toContain('widget');
    expect(state.dataCalls.sort()).toEqual(['rag_retrieval_log', 'rag_review_items', 'rag_review_items']);
  });

  it('defaults to the last 7 days', async () => {
    state.session = { id: ADMIN_ID };
    const route = await loadRoute();
    const response = await route.GET(req());
    expect(response.status).toBe(200);
    const stats = FeedbackLoopStatsSchema.parse((await response.json()).stats);
    expect(Date.parse(stats.until) - Date.parse(stats.since)).toBe(7 * 86_400_000);
  });

  it('answers 503 with the error code only when a read fails', async () => {
    state.session = { id: ADMIN_ID };
    state.failTable = 'rag_review_items';
    const route = await loadRoute();
    const response = await route.GET(req('?since=2026-11-01&until=2026-11-08'));
    expect(response.status).toBe(503);
    const text = JSON.stringify(await response.json());
    expect(text).toContain('42501');
    expect(text).not.toContain('secret detail');
  });
});

describe('computeFeedbackLoopStats paging', () => {
  it('reads every page and gives the same counts as one page', async () => {
    const { computeFeedbackLoopStats } = await import('@/lib/rag/feedback-loop/stats');
    const client = fakeAdmin() as never;
    const window = { since: new Date('2026-11-01T00:00:00Z'), until: new Date('2026-11-08T00:00:00Z') };
    const paged = await computeFeedbackLoopStats(window, { client, pageSize: 2 });
    const whole = await computeFeedbackLoopStats(window, { client, pageSize: 1000 });
    expect(paged).toEqual(whole);
    expect(paged.tenants?.[0]?.retrievals).toBeGreaterThan(0);
  });

  it('refuses a result larger than the row cap', async () => {
    const { computeFeedbackLoopStats, StatsError } = await import('@/lib/rag/feedback-loop/stats');
    const window = { since: new Date('2026-11-01T00:00:00Z'), until: new Date('2026-11-08T00:00:00Z') };
    await expect(computeFeedbackLoopStats(window, { client: fakeAdmin() as never, pageSize: 2, maxRows: 3 })).rejects.toBeInstanceOf(
      StatsError,
    );
  });
});
