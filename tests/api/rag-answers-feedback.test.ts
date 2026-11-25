import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminClient, newAnswerDb, sessionClient, type AnswerDbState, type Row } from '../helpers/answer-db-fake';

const USER_A = '00000000-0000-4000-8000-0000000021a2';
const USER_B = '00000000-0000-4000-8000-0000000021b2';
const SECRET_COMMENT = 'reach me at jane.doe@example.com';

let db: AnswerDbState;
let authThrows = false;
const LANGFUSE_VARS = ['LANGFUSE_ENABLED', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'];

async function loadRoute() {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => {
      const client = sessionClient(db) as unknown as { auth: { getUser: () => Promise<unknown> } };
      return {
        ...client,
        auth: {
          getUser: async () => {
            if (authThrows) throw new Error('auth down');
            return { data: { user: db.session }, error: null };
          },
        },
      };
    },
  }));
  const admin = adminClient(db);
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: admin, getSupabaseAdmin: () => admin }));
  return import('@/app/api/rag/answers/[answerId]/feedback/route');
}

function record(over: Row = {}): Row {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    user_id: USER_A,
    organization_id: null,
    chat_id: null,
    trace_id: 'c'.repeat(32),
    model_id: 'placeholder/model',
    citation_strategy: 'chunk-alias',
    rag_mode: 'strict',
    answer_language: 'en',
    invalid_citations: 0,
    citations: [],
    groundedness: { status: 'pending', truncated: false },
    feedback: null,
    review_reasons: [],
    created_at: now,
    updated_at: now,
    ...over,
  };
}

function post(answerId: string, body: unknown, contentType = 'application/json') {
  return new NextRequest(`http://localhost/api/rag/answers/${answerId}/feedback`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const params = (answerId: string) => ({ params: Promise.resolve({ answerId }) });

describe('POST /api/rag/answers/{answerId}/feedback', () => {
  const logs: string[] = [];

  beforeEach(() => {
    db = newAnswerDb();
    db.session = { id: USER_A };
    authThrows = false;
    logs.length = 0;
    process.env.RAG_ANSWER_FEEDBACK = 'true';
    for (const name of LANGFUSE_VARS) delete process.env[name];
    for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
    delete process.env.RAG_ANSWER_FEEDBACK;
    for (const name of LANGFUSE_VARS) delete process.env[name];
  });

  it('answers 404 with the switch off, before looking at the session or the record', async () => {
    const row = record();
    db.tables.rag_answer_records.push(row);
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      if (value === undefined) delete process.env.RAG_ANSWER_FEEDBACK;
      else process.env.RAG_ANSWER_FEEDBACK = value;
      const route = await loadRoute();
      const response = await route.POST(post(String(row.id), { vote: 'helpful' }), params(String(row.id)));
      expect(response.status).toBe(404);
    }
    expect(row.feedback).toBe(null);
    expect(db.queries).toHaveLength(0);
  });

  it('answers 401 without a session and 503 when the session lookup throws', async () => {
    db.session = null;
    const route = await loadRoute();
    const id = crypto.randomUUID();
    expect((await route.POST(post(id, { vote: 'helpful' }), params(id))).status).toBe(401);
    authThrows = true;
    expect((await route.POST(post(id, { vote: 'helpful' }), params(id))).status).toBe(503);
  });

  it('answers 415 for a body that is not JSON', async () => {
    const row = record();
    db.tables.rag_answer_records.push(row);
    const route = await loadRoute();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const response = await route.POST(post(String(row.id), 'vote=helpful', type), params(String(row.id)));
      expect(response.status).toBe(415);
    }
    const charset = await route.POST(post(String(row.id), { vote: 'helpful' }, 'application/json; charset=utf-8'), params(String(row.id)));
    expect(charset.status).toBe(200);
  });

  it('answers 400 with structured details for a body that fails the schema, including query or answer fields', async () => {
    const row = record();
    db.tables.rag_answer_records.push(row);
    const route = await loadRoute();
    const bodies = [
      { vote: 'maybe' },
      {},
      { vote: 'not_helpful', query: 'injected question', answer: 'injected answer' },
      { vote: 'not_helpful', reasons: ['wrong', 'wrong'] },
      { vote: 'not_helpful', comment: 'x'.repeat(501) },
    ];
    for (const body of bodies) {
      const response = await route.POST(post(String(row.id), body), params(String(row.id)));
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.success).toBe(false);
      expect(typeof json.error).toBe('string');
      expect(Array.isArray(json.details)).toBe(true);
    }
    expect(row.feedback).toBe(null);
  });

  it('answers 400 for malformed JSON without echoing the body in the response or the logs', async () => {
    const row = record();
    db.tables.rag_answer_records.push(row);
    const route = await loadRoute();
    const response = await route.POST(post(String(row.id), `{"vote": "helpful", "comment": "${SECRET_COMMENT}"`), params(String(row.id)));
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toContain('jane.doe');
    expect(logs.join('\n')).not.toContain('jane.doe');
  });

  it("answers identical 404 bodies for another user's record, a missing record and a malformed id, never 403", async () => {
    const foreign = record({ user_id: USER_B });
    db.tables.rag_answer_records.push(foreign);
    const route = await loadRoute();
    const missingId = crypto.randomUUID();
    const other = await route.POST(post(String(foreign.id), { vote: 'not_helpful' }), params(String(foreign.id)));
    const missing = await route.POST(post(missingId, { vote: 'not_helpful' }), params(missingId));
    const malformed = await route.POST(post('nope', { vote: 'not_helpful' }), params('nope'));
    expect([other.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
    const body = await other.json();
    expect(await missing.json()).toEqual(body);
    expect(await malformed.json()).toEqual(body);
    expect(foreign.feedback).toBe(null);
    expect(foreign.review_reasons).toEqual([]);
  });

  it('stores the vote, returns it, and writes the [RAG Feedback] fallback with Langfuse off and no comment text in logs', async () => {
    const row = record();
    db.tables.rag_answer_records.push(row);
    const route = await loadRoute();
    const response = await route.POST(post(String(row.id), { vote: 'not_helpful', reasons: ['wrong'], comment: SECRET_COMMENT }), params(String(row.id)));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.feedback).toMatchObject({ vote: 'not_helpful', reasons: ['wrong'], comment: SECRET_COMMENT });
    expect((row.feedback as Row).vote).toBe('not_helpful');
    expect(row.review_reasons).toEqual(['feedback_negative']);
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith('[RAG Feedback]'))).toBe(true));
    expect(logs.join('\n')).not.toContain('jane.doe');
  });

  it('answers within the request while Langfuse hangs, and the vote is stored', async () => {
    const held: http.ServerResponse[] = [];
    const server = http.createServer((_req, res) => {
      held.push(res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    process.env.LANGFUSE_ENABLED = 'true';
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-placeholder';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-placeholder';
    process.env.LANGFUSE_BASE_URL = `http://127.0.0.1:${port}`;
    try {
      const row = record();
      db.tables.rag_answer_records.push(row);
      const route = await loadRoute();
      const started = Date.now();
      const response = await route.POST(post(String(row.id), { vote: 'helpful' }), params(String(row.id)));
      expect(response.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(1000);
      expect((row.feedback as Row).vote).toBe('helpful');
    } finally {
      for (const res of held) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('answers 503 and keeps nothing half-written when the store is unavailable', async () => {
    const row = record();
    db.tables.rag_answer_records.push(row);
    db.failUpdates = true;
    const route = await loadRoute();
    const response = await route.POST(post(String(row.id), { vote: 'helpful' }), params(String(row.id)));
    expect(response.status).toBe(503);
    expect(row.feedback).toBe(null);
  });
});
