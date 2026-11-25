import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export interface AnswerDbQuery {
  client: 'session' | 'admin';
  table: string;
  op: 'select' | 'update';
  payload?: Row;
  filters: Array<[string, string, unknown]>;
}

export interface AnswerDbState {
  session: { id: string } | null;
  tables: Record<string, Row[]>;
  queries: AnswerDbQuery[];
  rpcs: Array<{ name: string; args: unknown }>;
  rpcResults: Record<string, { data: unknown; error: { code?: string; message: string } | null }>;
  failUpdates: boolean;
}

export function newAnswerDb(): AnswerDbState {
  return {
    session: null,
    tables: { rag_answer_records: [], chats: [], documents: [] },
    queries: [],
    rpcs: [],
    rpcResults: {},
    failUpdates: false,
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function visibleToSession(state: AnswerDbState, table: string, row: Row): boolean {
  if (table === 'rag_answer_records' || table === 'chats') return row.user_id === state.session?.id;
  return true;
}

function builder(state: AnswerDbState, kind: 'session' | 'admin', table: string) {
  const filters: Filter[] = [];
  const described: Array<[string, string, unknown]> = [];
  let op: 'select' | 'update' = 'select';
  let payload: Row = {};
  let limit = Infinity;
  let order: { column: string; ascending: boolean } | null = null;
  const run = (): { data: Row[] | null; error: { code: string } | null } => {
    state.queries.push({ client: kind, table, op, payload: op === 'update' ? payload : undefined, filters: described });
    if (op === 'update' && kind === 'session') throw new Error('session client must not write');
    if (op === 'update' && state.failUpdates) return { data: null, error: { code: 'PGRST500' } };
    const rows = state.tables[table] ?? [];
    let hit = rows.filter((row) => (kind === 'admin' || visibleToSession(state, table, row)) && filters.every((filter) => filter(row)));
    if (op === 'update') hit.forEach((row) => Object.assign(row, structuredClone(payload)));
    if (order) {
      const { column, ascending } = order;
      hit = [...hit].sort((x, y) => String(x[column]).localeCompare(String(y[column])) * (ascending ? 1 : -1));
    }
    return { data: hit.slice(0, limit).map((row) => structuredClone(row)), error: null };
  };
  const push = (name: string, column: string, value: unknown, filter: Filter) => {
    described.push([name, column, value]);
    filters.push(filter);
    return b;
  };
  const b = {
    select: () => b,
    update(next: Row) {
      op = 'update';
      payload = next;
      return b;
    },
    eq: (column: string, value: unknown) => push('eq', column, value, (row) => same(row[column], value)),
    neq: (column: string, value: unknown) => push('neq', column, value, (row) => !same(row[column], value)),
    is: (column: string, value: null) => push('is', column, value, (row) => row[column] === null || row[column] === undefined),
    in: (column: string, values: unknown[]) => push('in', column, values, (row) => values.includes(row[column])),
    gte: (column: string, value: string) => push('gte', column, value, (row) => String(row[column]) >= value),
    lte: (column: string, value: string) => push('lte', column, value, (row) => String(row[column]) <= value),
    order(column: string, options?: { ascending?: boolean }) {
      order = { column, ascending: options?.ascending !== false };
      return b;
    },
    limit(n: number) {
      limit = n;
      return b;
    },
    abortSignal: () => b,
    maybeSingle: () =>
      Promise.resolve().then(() => {
        const result = run();
        return { data: result.data?.[0] ?? null, error: result.error };
      }),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve()
        .then(() => run())
        .then(onFulfilled, onRejected),
  };
  return b;
}

export function sessionClient(state: AnswerDbState): SupabaseClient {
  return {
    auth: { getUser: async () => ({ data: { user: state.session }, error: null }) },
    from: (table: string) => builder(state, 'session', table),
  } as unknown as SupabaseClient;
}

export function adminClient(state: AnswerDbState): SupabaseClient {
  return {
    from: (table: string) => builder(state, 'admin', table),
    rpc: async (name: string, args: unknown) => {
      state.rpcs.push({ name, args });
      return state.rpcResults[name] ?? { data: null, error: { code: 'PGRST202', message: 'unknown function' } };
    },
  } as unknown as SupabaseClient;
}
