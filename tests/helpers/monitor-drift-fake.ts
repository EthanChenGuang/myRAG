/**
 * A small in-memory stand-in for the service-role client used by the drift route tests (plan 05.3-33). It filters table rows by
 * eq / neq / gte / lt / in, orders and limits them, and answers rpc calls through handlers the test supplies. Every call is recorded.
 */
type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface FakeCall {
  table: string;
  filters: Array<{ op: string; column: string; value: unknown }>;
}

export interface FakeAdmin {
  tables: Record<string, Row[]>;
  rpcs: Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>>;
  calls: FakeCall[];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  client: unknown;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return String(a) < String(b) ? -1 : 1;
}

function builder(admin: FakeAdmin, table: string) {
  const filters: Filter[] = [];
  const call: FakeCall = { table, filters: [] };
  admin.calls.push(call);
  let orderBy: { column: string; ascending: boolean } | null = null;
  let limitTo: number | null = null;
  let rangeOf: [number, number] | null = null;
  const run = (): Row[] => {
    let rows = (admin.tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    if (orderBy) {
      const { column, ascending } = orderBy;
      rows = [...rows].sort((a, b) => (ascending ? 1 : -1) * compare(a[column], b[column]));
    }
    if (rangeOf) rows = rows.slice(rangeOf[0], rangeOf[1] + 1);
    if (limitTo !== null) rows = rows.slice(0, limitTo);
    return rows;
  };
  const add = (op: string, column: string, value: unknown, f: Filter) => {
    call.filters.push({ op, column, value });
    filters.push(f);
  };
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => (add('eq', column, value, (row) => row[column] === value), chain),
    neq: (column: string, value: unknown) => (add('neq', column, value, (row) => row[column] !== value), chain),
    gte: (column: string, value: unknown) => (add('gte', column, value, (row) => compare(row[column], value) >= 0), chain),
    lt: (column: string, value: unknown) => (add('lt', column, value, (row) => compare(row[column], value) < 0), chain),
    in: (column: string, values: unknown[]) => (add('in', column, values, (row) => values.includes(row[column])), chain),
    not: () => chain,
    order: (column: string, options?: { ascending?: boolean }) => {
      orderBy = { column, ascending: options?.ascending !== false };
      return chain;
    },
    limit: (n: number) => ((limitTo = n), chain),
    range: (from: number, to: number) => ((rangeOf = [from, to]), chain),
    abortSignal: () => chain,
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: run(), error: null }).then(resolve, reject),
  };
  return chain;
}

export function fakeAdmin(tables: Record<string, Row[]> = {}): FakeAdmin {
  const admin: FakeAdmin = { tables, rpcs: {}, calls: [], rpcCalls: [], client: null };
  admin.client = {
    from: (table: string) => builder(admin, table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      admin.rpcCalls.push({ name, args });
      const handler = admin.rpcs[name];
      if (!handler) return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      return handler(args);
    },
  };
  return admin;
}
