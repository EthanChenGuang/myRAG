/**
 * A tiny supabase-js stand-in over in-memory tables for the Nango deletion tests (06.3-05): select, delete and update
 * with eq/in/neq/limit filters, and rpc calls that are recorded and answered by an optional handler.
 */

export type Row = Record<string, unknown>;
type Filter = { kind: 'eq' | 'in' | 'neq'; column: string; value: unknown };

export interface RecordedOp {
  table: string;
  operation: 'select' | 'delete' | 'update' | 'insert' | 'upsert';
  filters: Filter[];
  values?: Row;
}

export interface RecordedRpc {
  name: string;
  args: Row;
}

export interface MemoryAdminOptions {
  /** Answers an rpc; the default returns one run id row. */
  rpc?: (name: string, args: Row) => { data: unknown; error: { code: string; message: string } | null };
  /** A delete on this table returns this error. */
  failDelete?: { table: string; error: { code: string; message: string } };
  /** Inserts store rows too (upserts always store and merge on their onConflict columns); off by default. */
  storeWrites?: boolean;
}

export function createNangoMemoryAdmin(seed: Record<string, Row[]>, options: MemoryAdminOptions = {}) {
  const tables: Record<string, Row[]> = { nango_connections: [], nango_sync_records: [], documents: [], document_chunks: [], ...seed };
  const ops: RecordedOp[] = [];
  const rpcs: RecordedRpc[] = [];
  let runCounter = 0;

  function from(table: string) {
    let operation: RecordedOp['operation'] = 'select';
    let values: Row | undefined;
    let limit: number | null = null;
    let conflict: string[] = [];
    const filters: Filter[] = [];
    const match = (row: Row) =>
      filters.every((entry) =>
        entry.kind === 'eq'
          ? row[entry.column] === entry.value
          : entry.kind === 'neq'
            ? row[entry.column] !== entry.value
            : (entry.value as unknown[]).includes(row[entry.column]),
      );
    const run = () => {
      ops.push({ table, operation, filters: filters.map((entry) => ({ ...entry })), ...(values ? { values } : {}) });
      const rows = tables[table] ?? [];
      const matched = rows.filter(match);
      if (operation === 'delete') {
        if (options.failDelete && options.failDelete.table === table) return { data: null, error: options.failDelete.error };
        tables[table] = rows.filter((row) => !matched.includes(row));
      } else if (operation === 'update' && values) {
        for (const row of matched) Object.assign(row, values);
      } else if ((operation === 'upsert' || (options.storeWrites && operation === 'insert')) && values) {
        const next = values;
        const existing = operation === 'upsert' && conflict.length > 0
          ? rows.find((row) => conflict.every((column) => row[column] === next[column]))
          : undefined;
        if (existing) Object.assign(existing, next);
        else tables[table] = [...rows, { ...next }];
      }
      return { data: limit === null ? matched : matched.slice(0, limit), error: null };
    };
    const builder = {
      select: () => builder,
      delete() {
        operation = 'delete';
        return builder;
      },
      update(next: Row) {
        operation = 'update';
        values = next;
        return builder;
      },
      insert(next: Row) {
        operation = 'insert';
        values = next;
        return builder;
      },
      upsert(next: Row, upsertOptions?: { onConflict?: string }) {
        operation = 'upsert';
        values = next;
        conflict = (upsertOptions?.onConflict ?? '').split(',').map((column) => column.trim()).filter(Boolean);
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push({ kind: 'neq', column, value });
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ kind: 'eq', column, value });
        return builder;
      },
      in(column: string, value: unknown[]) {
        filters.push({ kind: 'in', column, value: [...value] });
        return builder;
      },
      limit(count: number) {
        limit = count;
        return builder;
      },
      single() {
        const result = run();
        const found = Array.isArray(result.data) ? result.data[0] : undefined;
        return Promise.resolve({ data: found ?? null, error: found ? null : { message: 'not found' } });
      },
      maybeSingle() {
        const result = run();
        const found = Array.isArray(result.data) ? result.data[0] : undefined;
        return Promise.resolve({ data: found ?? null, error: null });
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(onFulfilled, onRejected),
    };
    return builder;
  }

  async function rpc(name: string, args: Row = {}) {
    rpcs.push({ name, args: JSON.parse(JSON.stringify(args)) as Row });
    if (options.rpc) return options.rpc(name, args);
    runCounter += 1;
    return { data: [{ run_id: `run-${runCounter}`, expires_at: null }], error: null };
  }

  return { tables, ops, rpcs, admin: { from, rpc } };
}
