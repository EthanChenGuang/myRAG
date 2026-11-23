import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const CHAT_A = '00000000-0000-4000-8000-00000000c0a1';
const CHAT_B = '00000000-0000-4000-8000-00000000c0b1';
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000';

type Row = Record<string, unknown>;

const state = {
  session: null as { id: string } | null,
  authThrows: false,
  chats: [] as Row[],
  states: [] as Row[],
  writes: 0,
};

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([column, value]) => row[column] === value);
}

function admin() {
  return {
    from(table: string) {
      const rows = table === 'chats' ? state.chats : state.states;
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      let limit = Infinity;
      const run = () => {
        if (op === 'insert') {
          state.writes += 1;
          const row = { id: `row-${state.states.length + 1}`, created_at: new Date().toISOString(), ...payload };
          rows.push(row);
          return [row];
        }
        const hit = rows.filter((row) => matches(row, filters));
        if (op === 'update') {
          state.writes += 1;
          hit.forEach((row) => Object.assign(row, payload));
        }
        return hit.slice(0, limit);
      };
      const builder = {
        select: () => builder,
        insert(next: Row) {
          op = 'insert';
          payload = next;
          return builder;
        },
        update(next: Row) {
          op = 'update';
          payload = next;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        order: () => builder,
        limit(n: number) {
          limit = n;
          return builder;
        },
        maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
        single() {
          const hit = run();
          return Promise.resolve(hit.length === 1 ? { data: hit[0], error: null } : { data: null, error: { message: 'no single row' } });
        },
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: run(), error: null }).then(onFulfilled, onRejected),
      };
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
  vi.doMock('@/lib/supabase', () => ({ supabaseAdmin: admin(), getSupabaseAdmin: () => admin() }));
  return import('@/app/api/tool-execution-state/route');
}

function req(method: 'GET' | 'POST' | 'PUT', query = '', body?: Row) {
  return new NextRequest(`http://localhost/api/tool-execution-state${query}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('tool-execution-state route', () => {
  beforeEach(() => {
    state.session = null;
    state.authThrows = false;
    state.writes = 0;
    state.chats = [
      { id: CHAT_A, user_id: USER_A },
      { id: CHAT_B, user_id: USER_B },
    ];
    state.states = [
      {
        id: 'state-b',
        chat_id: CHAT_B,
        message_id: 1,
        tool_call_id: 'call-b',
        tool_name: 'tool_b',
        status: 'pending',
        user_id: USER_B,
        tool_params: { secret: 'placeholder-b' },
        created_at: '2026-01-01',
      },
      {
        id: 'state-placeholder-b',
        chat_id: PLACEHOLDER,
        message_id: 2,
        tool_call_id: 'call-b-anon',
        tool_name: 'tool_b',
        status: 'pending',
        user_id: USER_B,
        tool_params: { secret: 'placeholder-b2' },
        created_at: '2026-01-02',
      },
      {
        id: 'state-a',
        chat_id: CHAT_A,
        message_id: 3,
        tool_call_id: 'call-a',
        tool_name: 'tool_a',
        status: 'pending',
        user_id: USER_A,
        tool_params: { q: 'placeholder-a' },
        created_at: '2026-01-03',
      },
    ];
    delete (globalThis as { toolApprovalState?: unknown }).toolApprovalState;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/lib/supabase');
    vi.doUnmock('@/lib/supabase/server');
    delete (globalThis as { toolApprovalState?: unknown }).toolApprovalState;
  });

  it('answers 401 on every method with no session and touches nothing', async () => {
    const { GET, POST, PUT } = await loadRoute();
    expect((await GET(req('GET', `?chat_id=${CHAT_B}`))).status).toBe(401);
    expect(
      (await POST(req('POST', '', { chat_id: CHAT_A, message_id: 9, tool_call_id: 'x', tool_name: 't' }))).status,
    ).toBe(401);
    expect((await PUT(req('PUT', '', { tool_call_id: 'call-b', status: 'cancelled' }))).status).toBe(401);
    expect(state.writes).toBe(0);
    expect(state.states.find((row) => row.id === 'state-b')?.status).toBe('pending');
  });

  it('answers 503 when the session lookup throws', async () => {
    state.authThrows = true;
    const { GET } = await loadRoute();
    expect((await GET(req('GET', `?chat_id=${CHAT_A}`))).status).toBe(503);
  });

  it('answers 404 when user A reads the state of user B chat', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoute();
    const response = await GET(req('GET', `?chat_id=${CHAT_B}`));
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain('placeholder-b');
  });

  it('never returns another user rows for the placeholder chat id', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoute();
    const byChat = await GET(req('GET', `?chat_id=${PLACEHOLDER}`));
    expect(byChat.status).toBe(404);
    expect(JSON.stringify(await byChat.json())).not.toContain('placeholder-b2');
    const byMessage = await GET(req('GET', `?chat_id=${PLACEHOLDER}&message_id=2`));
    expect(byMessage.status).toBe(404);
  });

  it('hides user B state when user A asks by tool_call_id', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoute();
    const response = await GET(req('GET', '?tool_call_id=call-b'));
    expect(await response.json()).toBeNull();
  });

  it('does not build a state from another user pending approval entry', async () => {
    state.session = { id: USER_A };
    (globalThis as { toolApprovalState?: unknown }).toolApprovalState = {
      'call-new': { toolCall: { name: 'tool_b', params: {} }, ownerUserId: USER_B },
    };
    const { GET } = await loadRoute();
    const response = await GET(req('GET', '?tool_call_id=call-new'));
    expect(await response.json()).toBeNull();
    expect(state.writes).toBe(0);
  });

  it('lets the owner read their own chat states and tool call state', async () => {
    state.session = { id: USER_A };
    const { GET } = await loadRoute();
    const byChat = await GET(req('GET', `?chat_id=${CHAT_A}`));
    expect(byChat.status).toBe(200);
    expect((await byChat.json()).map((row: Row) => row.id)).toEqual(['state-a']);
    const byCall = await GET(req('GET', '?tool_call_id=call-a'));
    expect((await byCall.json()).id).toBe('state-a');
  });

  it('answers 404 to a PUT on another user state and changes nothing', async () => {
    state.session = { id: USER_A };
    const { PUT } = await loadRoute();
    const response = await PUT(req('PUT', '', { tool_call_id: 'call-b', status: 'cancelled' }));
    expect(response.status).toBe(404);
    expect(state.writes).toBe(0);
    expect(state.states.find((row) => row.id === 'state-b')?.status).toBe('pending');
  });

  it('applies only allowlisted fields on PUT and leaves the rest unchanged', async () => {
    state.session = { id: USER_A };
    const { PUT } = await loadRoute();
    const before = { ...state.states.find((row) => row.id === 'state-a') };
    const response = await PUT(
      req('PUT', '', {
        tool_call_id: 'call-a',
        status: 'cancelled',
        chat_id: CHAT_B,
        user_id: USER_B,
        tool_name: 'hijacked',
        id: 'other',
        message_id: 99,
        created_at: '1999-01-01',
      }),
    );
    expect(response.status).toBe(200);
    const after = state.states.find((row) => row.id === 'state-a')!;
    expect(after.status).toBe('cancelled');
    for (const field of ['id', 'chat_id', 'user_id', 'tool_name', 'message_id', 'created_at', 'tool_call_id']) {
      expect(after[field]).toBe(before[field]);
    }
  });

  it('rejects a PUT that carries no allowlisted field', async () => {
    state.session = { id: USER_A };
    const { PUT } = await loadRoute();
    const response = await PUT(req('PUT', '', { tool_call_id: 'call-a', chat_id: CHAT_B }));
    expect(response.status).toBe(400);
    expect(state.writes).toBe(0);
  });

  it('refuses to create a state inside another user chat', async () => {
    state.session = { id: USER_A };
    const { POST } = await loadRoute();
    const response = await POST(req('POST', '', { chat_id: CHAT_B, message_id: 5, tool_call_id: 'call-x', tool_name: 't' }));
    expect(response.status).toBe(404);
    expect(state.writes).toBe(0);
  });

  it('stamps the session user on a state created in an owned chat', async () => {
    state.session = { id: USER_A };
    const { POST } = await loadRoute();
    const response = await POST(req('POST', '', { chat_id: CHAT_A, message_id: 5, tool_call_id: 'call-x', tool_name: 't' }));
    expect(response.status).toBe(200);
    expect(state.states.find((row) => row.tool_call_id === 'call-x')?.user_id).toBe(USER_A);
  });

  it('allows the placeholder chat only when the pending approval entry belongs to the caller', async () => {
    state.session = { id: USER_A };
    const { POST } = await loadRoute();
    const body = { chat_id: PLACEHOLDER, message_id: 6, tool_call_id: 'call-p', tool_name: 't' };
    expect((await POST(req('POST', '', body))).status).toBe(404);
    (globalThis as { toolApprovalState?: unknown }).toolApprovalState = {
      'call-p': { toolCall: { name: 't', params: {} }, ownerUserId: USER_B },
    };
    expect((await POST(req('POST', '', body))).status).toBe(404);
    (globalThis as { toolApprovalState?: unknown }).toolApprovalState = {
      'call-p': { toolCall: { name: 't', params: {} }, ownerUserId: USER_A },
    };
    expect((await POST(req('POST', '', body))).status).toBe(200);
  });
});
