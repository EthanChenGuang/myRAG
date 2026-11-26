import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TRACE_REFUSED = 'a'.repeat(32);
const TRACE_UNAVAILABLE = 'b'.repeat(32);
const TRACE_ANSWERED = 'c'.repeat(32);
const TRACE_FOREIGN = 'd'.repeat(32);
const TRACE_UNKNOWN = 'e'.repeat(32);

interface Row {
  trace_id: string;
  user_id: string;
  outcome: string;
  feedback_vote: number | null;
  feedback_kind: string | null;
  feedback_reasons: string[];
  feedback_at: string | null;
  source_opened_count: number;
}

type Filter = { op: 'eq' | 'in'; column: string; value: unknown };

const state = {
  rows: [] as Row[],
  session: null as { id: string } | null,
  authThrows: false,
  dbCalls: 0,
};

function row(trace: string, user: string, outcome: string): Row {
  return { trace_id: trace, user_id: user, outcome, feedback_vote: null, feedback_kind: null, feedback_reasons: [], feedback_at: null, source_opened_count: 0 };
}

function adminFake() {
  const matches = (target: Row, filters: Filter[]) =>
    filters.every((filter) => {
      const value = (target as unknown as Record<string, unknown>)[filter.column];
      return filter.op === 'eq' ? value === filter.value : (filter.value as unknown[]).includes(value);
    });
  return {
    from() {
      const filters: Filter[] = [];
      let values: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        update(next: Record<string, unknown>) {
          values = next;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ op: 'eq', column, value });
          return builder;
        },
        in(column: string, value: unknown[]) {
          filters.push({ op: 'in', column, value });
          return builder;
        },
        select() {
          return builder;
        },
        then(resolve: (value: unknown) => unknown) {
          state.dbCalls += 1;
          const hit = state.rows.filter((target) => matches(target, filters));
          for (const target of hit) Object.assign(target, values);
          return Promise.resolve({ data: hit.map((target) => ({ trace_id: target.trace_id })), error: null }).then(resolve);
        },
      };
      return builder;
    },
    rpc(_name: string, args: { p_trace_id: string; p_user_id: string }) {
      state.dbCalls += 1;
      const target = state.rows.find((candidate) => candidate.trace_id === args.p_trace_id && candidate.user_id === args.p_user_id);
      if (!target) return Promise.resolve({ data: null, error: null });
      if (target.source_opened_count < 20) target.source_opened_count += 1;
      return Promise.resolve({ data: target.source_opened_count, error: null });
    },
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        if (state.authThrows) throw new Error('auth down');
        return { data: { user: state.session }, error: null };
      },
    },
  }),
}));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => adminFake() }));

const feedbackRoute = await import('@/app/api/rag/retrieval/[traceId]/feedback/route');
const signalRoute = await import('@/app/api/rag/retrieval/[traceId]/signal/route');

function post(kind: 'feedback' | 'signal', traceId: string, body: unknown, contentType = 'application/json') {
  return new NextRequest(`http://localhost/api/rag/retrieval/${traceId}/${kind}`, {
    method: 'POST',
    headers: { 'content-type': contentType, origin: 'https://elsewhere.example' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const params = (traceId: string) => ({ params: Promise.resolve({ traceId }) });
const vote = (traceId: string, body: unknown, contentType?: string) => feedbackRoute.POST(post('feedback', traceId, body, contentType), params(traceId));
const signal = (traceId: string, body: unknown = { kind: 'source_opened' }, contentType?: string) =>
  signalRoute.POST(post('signal', traceId, body, contentType), params(traceId));

const logs: string[] = [];
const saved = { refusal: process.env.RAG_REFUSAL_FEEDBACK, signal: process.env.RAG_SOURCE_OPEN_SIGNAL };

beforeEach(() => {
  state.rows = [
    row(TRACE_REFUSED, OWNER, 'refused_no_context'),
    row(TRACE_UNAVAILABLE, OWNER, 'kb_unavailable'),
    row(TRACE_ANSWERED, OWNER, 'answered'),
    row(TRACE_FOREIGN, OTHER, 'refused_no_context'),
  ];
  state.session = { id: OWNER };
  state.authThrows = false;
  state.dbCalls = 0;
  logs.length = 0;
  process.env.RAG_REFUSAL_FEEDBACK = 'true';
  process.env.RAG_SOURCE_OPEN_SIGNAL = 'true';
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of [['RAG_REFUSAL_FEEDBACK', saved.refusal], ['RAG_SOURCE_OPEN_SIGNAL', saved.signal]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('POST /api/rag/retrieval/{traceId}/feedback (D-08)', () => {
  it('a valid expected_answer vote on the caller refusal returns 200 with vote, reasons and time and updates only that row', async () => {
    const response = await vote(TRACE_REFUSED, { vote: 'expected_answer', reasons: ['answer_exists'] });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    const body = await response.json();
    expect(body).toEqual({ vote: 'expected_answer', reasons: ['answer_exists'], at: expect.any(String) });
    expect(Number.isNaN(Date.parse(body.at))).toBe(false);
    expect(state.rows[0]).toMatchObject({ feedback_vote: -1, feedback_kind: 'refusal', feedback_reasons: ['answer_exists'] });
    expect(state.rows.slice(1).every((target) => target.feedback_vote === null)).toBe(true);
  });

  it('correct_refusal on a kb_unavailable row stores +1; a later vote replaces it', async () => {
    expect((await vote(TRACE_UNAVAILABLE, { vote: 'correct_refusal' })).status).toBe(200);
    expect(state.rows[1]!.feedback_vote).toBe(1);
    expect((await vote(TRACE_UNAVAILABLE, { vote: 'expected_answer', reasons: ['other'] })).status).toBe(200);
    expect(state.rows[1]).toMatchObject({ feedback_vote: -1, feedback_reasons: ['other'] });
  });

  it('no session answers 401 and touches nothing', async () => {
    state.session = null;
    const response = await vote(TRACE_REFUSED, { vote: 'expected_answer' });
    expect(response.status).toBe(401);
    expect(state.dbCalls).toBe(0);
  });

  it('a failed session lookup answers 503 and touches nothing', async () => {
    state.authThrows = true;
    const response = await vote(TRACE_REFUSED, { vote: 'expected_answer' });
    expect(response.status).toBe(503);
    expect(state.dbCalls).toBe(0);
  });

  it('non-JSON answers 415', async () => {
    const response = await vote(TRACE_REFUSED, 'vote=expected_answer', 'application/x-www-form-urlencoded');
    expect(response.status).toBe(415);
    expect(state.dbCalls).toBe(0);
  });

  it.each([
    { name: 'a query field', body: { vote: 'expected_answer', query: 'synthetic question' } },
    { name: 'a free-text comment', body: { vote: 'expected_answer', comment: 'free text' } },
    { name: 'an unknown reason', body: { vote: 'expected_answer', reasons: ['wrong'] } },
    { name: 'an unknown vote', body: { vote: 'helpful' } },
    { name: 'malformed JSON', body: '{"vote":' },
  ])('$name answers 400 with details and touches nothing', async ({ body }) => {
    const response = await vote(TRACE_REFUSED, body);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.success).toBe(false);
    expect(Array.isArray(json.details)).toBe(true);
    expect(JSON.stringify(json)).not.toContain('synthetic question');
    expect(state.dbCalls).toBe(0);
  });

  it('another user row, an answered row, an unknown trace, a malformed trace and the switch off all answer the same 404', async () => {
    const bodies: string[] = [];
    for (const traceId of [TRACE_FOREIGN, TRACE_ANSWERED, TRACE_UNKNOWN, 'not-a-trace', 'A'.repeat(32)]) {
      const response = await vote(traceId, { vote: 'expected_answer' });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      bodies.push(await response.text());
    }
    process.env.RAG_REFUSAL_FEEDBACK = 'false';
    const off = await vote(TRACE_REFUSED, { vote: 'expected_answer' });
    expect(off.status).toBe(404);
    bodies.push(await off.text());
    delete process.env.RAG_REFUSAL_FEEDBACK;
    const unset = await vote(TRACE_REFUSED, { vote: 'expected_answer' });
    expect(unset.status).toBe(404);
    bodies.push(await unset.text());

    expect(new Set(bodies).size).toBe(1);
    expect(state.rows.every((target) => target.feedback_vote === null)).toBe(true);
  });

  it('the switch off answers 404 before any session lookup', async () => {
    process.env.RAG_REFUSAL_FEEDBACK = 'false';
    state.session = null;
    expect((await vote(TRACE_REFUSED, { vote: 'expected_answer' })).status).toBe(404);
  });

  it('logs one [Feedback Loop] line per accepted vote with the vote, reason count and a trace hash, never the trace id or text', async () => {
    await vote(TRACE_REFUSED, { vote: 'expected_answer', reasons: ['answer_exists', 'wrong_language'] });
    const lines = logs.filter((line) => line.includes('[Feedback Loop]'));
    expect(lines).toHaveLength(1);
    const hash = createHash('sha256').update(TRACE_REFUSED).digest('hex').slice(0, 12);
    expect(lines[0]).toContain(hash);
    expect(lines[0]).toContain('expected_answer');
    expect(lines[0]).toContain('"reasons":2');
    expect(logs.join('\n')).not.toContain(TRACE_REFUSED);

    logs.length = 0;
    await vote(TRACE_FOREIGN, { vote: 'expected_answer' });
    expect(logs.filter((line) => line.includes('[Feedback Loop]'))).toHaveLength(0);
  });
});

describe('POST /api/rag/retrieval/{traceId}/signal (D-12)', () => {
  it('returns 204 for the owner and increments the count, up to 20', async () => {
    for (let i = 0; i < 22; i += 1) {
      const response = await signal(TRACE_ANSWERED);
      expect(response.status).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(state.rows[2]!.source_opened_count).toBe(20);
  });

  it('another user row, an unknown trace, a malformed trace and the switch off all answer the same 404', async () => {
    const bodies: string[] = [];
    for (const traceId of [TRACE_FOREIGN, TRACE_UNKNOWN, 'x'.repeat(32)]) {
      const response = await signal(traceId);
      expect(response.status).toBe(404);
      bodies.push(await response.text());
    }
    process.env.RAG_SOURCE_OPEN_SIGNAL = 'false';
    const off = await signal(TRACE_ANSWERED);
    expect(off.status).toBe(404);
    bodies.push(await off.text());
    expect(new Set(bodies).size).toBe(1);
    expect(state.rows.every((target) => target.source_opened_count === 0)).toBe(true);
  });

  it('no session answers 401; non-JSON 415; an invalid body 400', async () => {
    state.session = null;
    expect((await signal(TRACE_ANSWERED)).status).toBe(401);
    state.session = { id: OWNER };
    expect((await signal(TRACE_ANSWERED, 'kind=source_opened', 'text/plain')).status).toBe(415);
    expect((await signal(TRACE_ANSWERED, { kind: 'clicked' })).status).toBe(400);
    expect((await signal(TRACE_ANSWERED, { kind: 'source_opened', query: 'synthetic question' })).status).toBe(400);
    expect(state.dbCalls).toBe(0);
  });
});

describe('route surface', () => {
  it('both routes run on nodejs and never answer 403', async () => {
    const fs = await import('node:fs');
    expect(feedbackRoute.runtime).toBe('nodejs');
    expect(signalRoute.runtime).toBe('nodejs');
    for (const file of ['feedback', 'signal']) {
      const source = fs.readFileSync(`src/app/api/rag/retrieval/[traceId]/${file}/route.ts`, 'utf8');
      expect(source).not.toMatch(/status:\s*403/);
      expect(source).not.toMatch(/Access-Control-Allow/i);
    }
  });
});
