import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN = 'admin-caller';
const ORG_A = '00000000-0000-4000-8000-00000000a0a0';
const ORG_B = '00000000-0000-4000-8000-00000000b0b0';
const TENANT_A = `o:${ORG_A}`;

interface State {
  queue: Map<string, Set<string>>;
  rpcCalls: number;
  guardCalls: number;
}

let state: State;
const logged: string[] = [];

function fakeAdmin() {
  return {
    from(_table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        in(_column: string, values: string[]) {
          const known = state.queue.get(String(filters.tenant_key)) ?? new Set<string>();
          return Promise.resolve({ data: values.filter((value) => known.has(value)).map((value) => ({ query_fingerprint: value })), error: null });
        },
      };
      return builder;
    },
    async rpc(_fn: string, args: { p_tenant_key: string; p_rows: Array<{ query_fingerprint: string }> }) {
      state.rpcCalls += 1;
      const known = state.queue.get(args.p_tenant_key) ?? new Set<string>();
      state.queue.set(args.p_tenant_key, known);
      let inserted = 0;
      for (const row of args.p_rows) {
        if (!known.has(row.query_fingerprint)) {
          known.add(row.query_fingerprint);
          inserted += 1;
        }
      }
      return { data: inserted, error: null };
    },
  };
}

async function loadRoute() {
  vi.resetModules();
  const admin = fakeAdmin();
  vi.doMock('@/lib/supabase', () => ({ getSupabaseAdmin: () => admin, supabaseAdmin: admin, getSupabase: () => ({}) }));
  vi.doMock('@/lib/admin-route-auth', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/admin-route-auth')>()),
    checkAdminOrOrgAdmin: async (request: Request, organizationId: string | null | undefined) => {
      state.guardCalls += 1;
      if (request.headers.get('x-test-caller') !== ADMIN) return { ok: false, status: 401, reason: 'unauthenticated' };
      if (organizationId !== ORG_A) return { ok: false, status: 403, reason: 'workspace_forbidden' };
      return { ok: true, userId: '00000000-0000-4000-8000-0000000000a1', via: 'organization_admin', tenantKey: TENANT_A, organizationId: ORG_A };
    },
  }));
  return (await import('@/app/api/rag/admin/questions-import/route')).POST;
}

function questions(count: number, length: number): string[] {
  return Array.from({ length: count }, (_, index) => `question-${String(index).padStart(4, '0')} `.padEnd(length, 'x'));
}

function post(body: unknown, caller = ADMIN, raw?: string): Request {
  const text = raw ?? JSON.stringify(body);
  return new Request('http://localhost/api/rag/admin/questions-import', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-caller': caller },
    body: text,
  });
}

function batch(rows: unknown, overrides: Record<string, unknown> = {}) {
  return { organizationId: ORG_A, format: 'csv', column: 'question', dry_run: false, rows, ...overrides };
}

beforeEach(() => {
  state = { queue: new Map(), rpcCalls: 0, guardCalls: 0 };
  logged.length = 0;
  vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'true');
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase');
  vi.doUnmock('@/lib/admin-route-auth');
});

describe('POST /api/rag/admin/questions-import', () => {
  it('answers 404 with expert review off, before the guard', async () => {
    vi.stubEnv('RAG_DOMAIN_EXPERT_REVIEW', 'false');
    const POST = await loadRoute();
    const response = await POST(post(batch(['question-0001'])));
    expect(response.status).toBe(404);
    expect(state.guardCalls).toBe(0);
  });

  it('a 50 KB dry-run batch of 300 questions answers counts and writes nothing; the real run adds; a repeat adds nothing', async () => {
    const POST = await loadRoute();
    const rows = questions(300, 160);
    expect(JSON.stringify(rows).length).toBeGreaterThan(45_000);

    const dry = await POST(post(batch(rows, { dry_run: true })));
    expect(dry.status).toBe(200);
    const dryBody = await dry.json();
    expect(dryBody).toMatchObject({ success: true, dry_run: true, read: 300, added: 300, duplicates: 0, rejected_pii: 0, truncated: 0, empty: 0 });
    expect(state.rpcCalls).toBe(0);

    const real = await POST(post(batch(rows)));
    expect(await real.json()).toMatchObject({ success: true, dry_run: false, read: 300, added: 300, duplicates: 0 });
    expect(state.queue.get(TENANT_A)?.size).toBe(300);

    const again = await POST(post(batch(rows)));
    const againBody = await again.json();
    expect(againBody).toMatchObject({ added: 0, duplicates: 300 });

    const text = JSON.stringify([dryBody, againBody]) + logged.join('\n');
    expect(text).not.toContain('question-0001');
    expect(logged.some((line) => line.startsWith('[Monitor]'))).toBe(true);
  });

  it('answers 413 for a body over 60 KB', async () => {
    const POST = await loadRoute();
    const response = await POST(post(batch(questions(400, 160))));
    expect(response.status).toBe(413);
    expect(state.rpcCalls).toBe(0);
  });

  it('answers 413 from content-length before reading the body', async () => {
    const POST = await loadRoute();
    const request = new Request('http://localhost/api/rag/admin/questions-import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(70 * 1024), 'x-test-caller': ADMIN },
      body: JSON.stringify(batch(['question-0001'])),
    });
    expect((await POST(request)).status).toBe(413);
  });

  it('answers 400 for a body that is not the batch shape, an extra field or more than 2000 rows', async () => {
    const POST = await loadRoute();
    expect((await POST(post(null, ADMIN, '{not json'))).status).toBe(400);
    expect((await POST(post(batch('question-0001')))).status).toBe(400);
    expect((await POST(post(batch([1, 2])))).status).toBe(400);
    expect((await POST(post(batch(['question-0001'], { format: 'xlsx' })))).status).toBe(400);
    expect((await POST(post(batch(['question-0001'], { tenant_key: 's:default' })))).status).toBe(400);
    expect((await POST(post(batch(Array.from({ length: 2001 }, () => 'q'))))).status).toBe(400);
    expect(state.rpcCalls).toBe(0);
  });

  it('answers the forbidden answer for an organization the admin does not administer, and 401 without a caller', async () => {
    const POST = await loadRoute();
    expect((await POST(post(batch(['question-0001'], { organizationId: ORG_B })))).status).toBe(403);
    expect((await POST(post(batch(['question-0001']), 'nobody'))).status).toBe(401);
    expect(state.rpcCalls).toBe(0);
  });

  it('masks before storing and counts rows the masker still changes', async () => {
    const POST = await loadRoute();
    const response = await POST(post(batch(['Where is the sample report for person@example.invalid?', 'reach +10 0000 0000ABCDEF00A00A000A today', ''])));
    const body = await response.json();
    expect(body).toMatchObject({ read: 3, added: 1, rejected_pii: 1, empty: 1 });
    expect(JSON.stringify(body)).not.toContain('example.invalid');
  });
});
