import { vi } from 'vitest';

/** Shared fakes for the Phase 7 admin routes: the real admin guard over a fake Supabase client, and a scripted service-role RPC client. */

export const ADMIN_ID = '00000000-0000-4000-8000-0000000015a9';
export const USER_ID = '00000000-0000-4000-8000-0000000015b9';

export type RpcOutcome = { data: unknown; error: { code?: string; message: string } | null };

export const harness = {
  admins: [] as string[],
  session: null as { id: string } | null,
  tokens: {} as Record<string, string>,
  sessionThrows: false,
  guardAvailable: true,
  rpcAvailable: true,
  env: {} as Record<string, string>,
  outcomes: {} as Record<string, RpcOutcome | ((args: Record<string, unknown>) => RpcOutcome)>,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** Rows the service-role client's table reads answer with (any filter), by table. */
  tables: {} as Record<string, unknown[]>,
  logged: [] as string[],
};

export function resetHarness(): void {
  harness.admins = [ADMIN_ID];
  harness.session = null;
  harness.tokens = { 'token-admin': ADMIN_ID, 'token-user': USER_ID };
  harness.sessionThrows = false;
  harness.guardAvailable = true;
  harness.rpcAvailable = true;
  harness.env = {};
  harness.outcomes = {};
  harness.rpcCalls = [];
  harness.tables = {};
  harness.logged = [];
  for (const method of ['warn', 'error', 'log', 'info'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      harness.logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    });
  }
}

function fakeGuardClient() {
  return {
    auth: {
      getUser: async (token: string) => {
        const id = harness.tokens[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
      },
      admin: { getUserById: async () => ({ data: { user: null }, error: { message: 'none' } }) },
    },
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        abortSignal: () => builder,
        eq(column: string, value: unknown) {
          filters[column] = value;
          return builder;
        },
        maybeSingle() {
          if (table !== 'admin_users') throw new Error(`the guard read ${table}`);
          return Promise.resolve({ data: harness.admins.includes(filters.id as string) ? { id: filters.id } : null, error: null });
        },
      };
      return builder;
    },
  };
}

function fakeRpcClient() {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      harness.rpcCalls.push({ fn, args });
      const configured = harness.outcomes[fn];
      const outcome = typeof configured === 'function' ? configured(args) : (configured ?? { data: [], error: null });
      const request = {
        abortSignal: () => request,
        then: (onFulfilled: (value: RpcOutcome) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(outcome).then(onFulfilled, onRejected),
      };
      return request;
    },
    from(table: string) {
      const result = { data: harness.tables[table] ?? [], error: null };
      const builder: Record<string, unknown> = {
        then: (onFulfilled: (value: typeof result) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled, onRejected),
      };
      for (const method of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'abortSignal']) builder[method] = () => builder;
      return builder;
    },
  };
}

/** Loads a route module fresh with the guard and the RAG deps pointed at the fakes. */
export async function loadRoute<T>(importRoute: () => Promise<T>): Promise<T> {
  vi.resetModules();
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => {
          if (harness.sessionThrows) throw new Error('auth down');
          return { data: { user: harness.session } };
        },
      },
    }),
  }));
  vi.doMock('@/lib/supabase', () => ({
    getSupabaseAdmin: () => (harness.guardAvailable ? fakeGuardClient() : null),
    getSupabase: () => ({}),
  }));
  const ragDeps = await import('@/lib/rag/deps');
  ragDeps.setRagDepsForTests({
    adminClient: () => (harness.rpcAvailable ? (fakeRpcClient() as never) : null),
    ragEnv: () => ({ ...harness.env }),
  });
  return importRoute();
}

export function headersFor(auth: 'admin' | 'user' | 'none' | 'forged'): Record<string, string> {
  if (auth === 'admin') return { authorization: 'Bearer token-admin' };
  if (auth === 'user') return { authorization: 'Bearer token-user' };
  if (auth === 'forged') return { cookie: 'admin_session=forged', authorization: 'Bearer admin' };
  return {};
}
