import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintEmbedFeedbackToken } from '@/lib/rag/feedback-loop/embed-token';

const SECRET = 's'.repeat(48);
const TRACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_TRACE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TENANT_A = 'o:11111111-1111-4111-8111-111111111111';
const TENANT_B = 'o:22222222-2222-4222-8222-222222222222';

interface Row extends Record<string, unknown> {
  trace_id: string;
  tenant_key: string;
  channel: string;
}

interface State {
  rows: Row[];
  updates: Array<{ values: Record<string, unknown>; filters: Record<string, unknown> }>;
  tables: string[];
  failUpdate: boolean;
  ssrCalls: number;
}

let state: State;
const env = process.env as Record<string, string | undefined>;
const saved: Record<string, string | undefined> = {};
const MANAGED = [
  'RAG_EMBED_FEEDBACK',
  'RAG_EMBED_FEEDBACK_SECRET',
  'NEXT_PUBLIC_EMBED_ENABLED',
  'NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS',
  'EMBED_RATE_LIMIT',
  'RAG_EMBED_TENANT',
];

function fakeAdmin() {
  return {
    from(table: string) {
      state.tables.push(table);
      const filters: Record<string, unknown> = {};
      let values: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      builder.update = (next: Record<string, unknown>) => {
        values = next;
        return builder;
      };
      builder.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      };
      builder.select = () => builder;
      builder.abortSignal = () => builder;
      const settle = () => {
        if (state.failUpdate) return { data: null, error: { code: '57014', message: 'timeout' } };
        if (!values) return { data: [], error: null };
        state.updates.push({ values, filters: { ...filters } });
        const matched = state.rows.filter((row) => Object.entries(filters).every(([column, value]) => row[column] === value));
        for (const row of matched) Object.assign(row, values);
        return { data: matched.map((row) => ({ id: row.id })), error: null };
      };
      builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(settle()).then(onFulfilled, onRejected);
      return builder;
    },
  };
}

async function loadRoute() {
  vi.resetModules();
  const admin = fakeAdmin();
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin, supabaseAdmin: admin, getSupabase: () => ({}) }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => {
      state.ssrCalls += 1;
      throw new Error('the embed feedback route must not read a session');
    },
  }));
  return import('@/app/api/embed/feedback/route');
}

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/embed/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.4', cookie: 'sb-access-token=placeholder', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function token(traceId = TRACE, tenantKey = TENANT_A, now = Date.now()): string {
  const minted = mintEmbedFeedbackToken({ traceId, tenantKey }, { secret: SECRET, now });
  if (!minted) throw new Error('token should mint');
  return minted;
}

describe('POST /api/embed/feedback (D-11)', () => {
  let logs: string[];

  beforeEach(() => {
    for (const name of MANAGED) saved[name] = env[name];
    env.RAG_EMBED_FEEDBACK = 'true';
    env.RAG_EMBED_FEEDBACK_SECRET = SECRET;
    env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    env.NEXT_PUBLIC_EMBED_ALLOWED_DOMAINS = '*';
    env.EMBED_RATE_LIMIT = '1000';
    state = {
      rows: [
        { id: 'row-a', trace_id: TRACE, tenant_key: TENANT_A, channel: 'embed', feedback_vote: null },
        { id: 'row-chat', trace_id: OTHER_TRACE, tenant_key: TENANT_A, channel: 'chat', feedback_vote: null },
      ],
      updates: [],
      tables: [],
      failUpdate: false,
      ssrCalls: 0,
    };
    logs = [];
    const capture = (...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(() => {
    for (const name of MANAGED) {
      if (saved[name] === undefined) delete env[name];
      else env[name] = saved[name];
    }
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
  });

  it('OPTIONS answers the CORS preflight like the embed chat route', async () => {
    const { OPTIONS } = await loadRoute();
    const response = await OPTIONS();
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type');
  });

  it('a valid token and vote update only the embed row of the token tenant and trace', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post({ token: token(), vote: 'not_helpful', reasons: ['wrong', 'incomplete'] }));
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({ success: true });
    expect(state.tables).toEqual(['rag_retrieval_log']);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].filters).toEqual({ trace_id: TRACE, tenant_key: TENANT_A, channel: 'embed' });
    expect(state.updates[0].values).toMatchObject({ feedback_vote: -1, feedback_kind: 'embed', feedback_reasons: ['wrong', 'incomplete'] });
    expect(typeof state.updates[0].values.feedback_at).toBe('string');
    expect(Object.keys(state.updates[0].values).sort()).toEqual(['feedback_at', 'feedback_kind', 'feedback_reasons', 'feedback_vote']);
    expect(state.rows[0]).toMatchObject({ feedback_vote: -1, feedback_kind: 'embed' });
    expect(state.ssrCalls).toBe(0);
  });

  it('latest vote wins and a helpful vote without reasons stores +1 and no reasons', async () => {
    const { POST } = await loadRoute();
    expect((await POST(post({ token: token(), vote: 'not_helpful', reasons: ['not_relevant'] }))).status).toBe(200);
    expect((await POST(post({ token: token(), vote: 'helpful' }))).status).toBe(200);
    expect(state.rows[0]).toMatchObject({ feedback_vote: 1, feedback_kind: 'embed', feedback_reasons: [] });
  });

  it('logs one [Feedback Loop] line per accepted vote without the token or the trace id', async () => {
    const { POST } = await loadRoute();
    const minted = token();
    await POST(post({ token: minted, vote: 'helpful' }));
    const lines = logs.filter((line) => line.includes('[Feedback Loop]'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(minted);
    expect(lines[0]).not.toContain(TRACE);
    expect(lines[0]).not.toContain(SECRET);
  });

  it('a token for tenant A cannot update a row of tenant B with the same trace id', async () => {
    state.rows = [{ id: 'row-b', trace_id: TRACE, tenant_key: TENANT_B, channel: 'embed', feedback_vote: null }];
    const { POST } = await loadRoute();
    const response = await POST(post({ token: token(TRACE, TENANT_A), vote: 'not_helpful' }));
    expect(response.status).toBe(404);
    expect(state.rows[0].feedback_vote).toBeNull();
    expect(state.updates.every((update) => update.filters.tenant_key === TENANT_A)).toBe(true);
  });

  it('a token for a chat row of the same tenant updates nothing', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post({ token: token(OTHER_TRACE), vote: 'not_helpful' }));
    expect(response.status).toBe(404);
    expect(state.rows[1].feedback_vote).toBeNull();
  });

  it('every failure answers 404 with one body and reads no row for a bad token', async () => {
    const { POST } = await loadRoute();
    const bodies: string[] = [];
    const expired = token(TRACE, TENANT_A, Date.now() - 25 * 3600 * 1000);
    const forged = mintEmbedFeedbackToken({ traceId: TRACE, tenantKey: TENANT_A }, { secret: 'x'.repeat(48) }) as string;
    for (const bad of [expired, forged, 'not.a-token']) {
      const response = await POST(post({ token: bad, vote: 'helpful' }));
      expect(response.status).toBe(404);
      bodies.push(await response.text());
    }
    expect(state.updates).toHaveLength(0);
    state.rows = [];
    const missing = await POST(post({ token: token(), vote: 'helpful' }));
    expect(missing.status).toBe(404);
    bodies.push(await missing.text());
    state.failUpdate = true;
    const failed = await POST(post({ token: token(), vote: 'helpful' }));
    expect(failed.status).toBe(404);
    bodies.push(await failed.text());
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/expired|signature|tenant|trace|token/i);
  });

  it('switch off, secret too short or embed disabled answer 404 and touch no table', async () => {
    const cases: Array<Record<string, string>> = [
      { RAG_EMBED_FEEDBACK: 'false' },
      { RAG_EMBED_FEEDBACK_SECRET: 'short' },
      { NEXT_PUBLIC_EMBED_ENABLED: 'false' },
    ];
    let reference: string | null = null;
    for (const overrides of cases) {
      Object.assign(env, overrides);
      const { POST } = await loadRoute();
      const response = await POST(post({ token: token(), vote: 'helpful' }));
      expect(response.status, JSON.stringify(overrides)).toBe(404);
      const body = await response.text();
      reference ??= body;
      expect(body).toBe(reference);
      env.RAG_EMBED_FEEDBACK = 'true';
      env.RAG_EMBED_FEEDBACK_SECRET = SECRET;
      env.NEXT_PUBLIC_EMBED_ENABLED = 'true';
    }
    expect(state.tables).toHaveLength(0);
  });

  it('rate limit exceeded answers 429 with the embed headers', async () => {
    env.EMBED_RATE_LIMIT = '2';
    const { POST } = await loadRoute();
    const headers = { 'x-forwarded-for': '198.51.100.77' };
    expect((await POST(post({ token: token(), vote: 'helpful' }, headers))).status).toBe(200);
    expect((await POST(post({ token: token(), vote: 'helpful' }, headers))).status).toBe(200);
    const limited = await POST(post({ token: token(), vote: 'helpful' }, headers));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('x-ratelimit-limit')).toBe('2');
    expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(limited.headers.get('x-ratelimit-reset')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(limited.headers.get('access-control-allow-origin')).toBe('*');
    expect(state.updates).toHaveLength(2);
  });

  it('a body with free text, an unknown reason, a bad vote or invalid JSON answers 400', async () => {
    const { POST } = await loadRoute();
    for (const body of [
      { token: token(), vote: 'not_helpful', comment: 'free text from a visitor' },
      { token: token(), vote: 'not_helpful', reasons: ['answer_exists'] },
      { token: token(), vote: 'meh' },
      { vote: 'helpful' },
      '{not json',
    ]) {
      const response = await POST(post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
    }
    expect(state.updates).toHaveLength(0);
  });
});
