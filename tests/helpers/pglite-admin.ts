import type { PGlite } from '@electric-sql/pglite';

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code: string; message: string } | null; count?: number | null };

export interface PgliteAdminOptions {
  /** Columns bound as jsonb on writes (defaults to metadata and processing_state). */
  jsonColumns?: string[];
  /** Run every statement as this authenticated user inside its own transaction, so RLS applies (a session-client stand-in). */
  asUser?: string;
}

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_JSON_COLUMNS = ['metadata', 'processing_state'];

function identifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) throw new Error(`[pglite-admin] bad identifier: ${name}`);
  return `"${name}"`;
}

function plain(rows: unknown[]): Row[] {
  return JSON.parse(JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? Number(value) : value))) as Row[];
}

/**
 * A supabase-js style query builder over a PGlite database, for route tests that need the real tables,
 * generated columns and triggers (the fake edge serves reads and RPCs only). It supports exactly the calls
 * the document, image and scraper routes make and refuses anything else, so an unsupported call fails loudly.
 */
export function createPgliteAdmin(db: PGlite, options: PgliteAdminOptions = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const JSON_COLUMNS = new Set(options.jsonColumns ?? DEFAULT_JSON_COLUMNS);
  const execute = async (sql: string, params: unknown[]) => {
    if (!options.asUser) return db.query(sql, params);
    const userId = options.asUser;
    return db.transaction(async (tx) => {
      await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
      await tx.exec('SET LOCAL ROLE authenticated');
      return tx.query(sql, params);
    });
  };

  const procCache = new Map<string, { retset: boolean; table: boolean }>();
  const procShape = async (fn: string) => {
    const cached = procCache.get(fn);
    if (cached) return cached;
    const result = await db.query<{ retset: boolean; table: boolean }>(
      `SELECT p.proretset AS retset, COALESCE('t' = ANY (p.proargmodes::text[]), false) AS table
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1`,
      [fn],
    );
    const shape = result.rows[0] ?? { retset: false, table: false };
    procCache.set(fn, shape);
    return shape;
  };

  const admin = {
    queries,
    /** supabase-js rpc over named arguments: objects and arrays bind as JSON, a scalar return is unwrapped. */
    async rpc(fn: string, args: Row = {}): Promise<Result> {
      const name = identifier(fn);
      const params: unknown[] = [];
      const named = Object.entries(args).map(([key, value]) => {
        params.push(value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
        return `${identifier(key)} => $${params.length}`;
      });
      const sql = `SELECT * FROM public.${name}(${named.join(', ')})`;
      queries.push({ sql, params: [...params] });
      try {
        const shape = await procShape(fn);
        const rows = plain((await execute(sql, params)).rows);
        if (shape.table) return { data: rows, error: null };
        if (shape.retset) return { data: rows.map((row) => row[fn]), error: null };
        return { data: rows[0]?.[fn] ?? null, error: null };
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'XX000';
        return { data: null, error: { code, message: error instanceof Error ? error.message : String(error) } };
      }
    },
    storage: {
      from: () => ({ remove: async () => ({ error: null }) }),
    },
    from(table: string) {
      const tableSql = identifier(table);
      const where: string[] = [];
      const params: unknown[] = [];
      let op: 'select' | 'delete' | 'update' | 'insert' = 'select';
      let returning = false;
      let conflict: { onConflict: string; ignoreDuplicates: boolean } | null = null;
      let insertRows: Row[] = [];
      let columns = '*';
      let head = false;
      let count = false;
      let orderSql = '';
      let limitSql = '';
      let payload: Row = {};

      const bind = (value: unknown, cast = ''): string => {
        params.push(value);
        return `$${params.length}${cast}`;
      };

      const run = async (single: boolean): Promise<Result> => {
        let sql: string;
        const bindValue = (column: string, value: unknown): string =>
          JSON_COLUMNS.has(column) && value !== null && value !== undefined ? bind(JSON.stringify(value), '::jsonb') : bind(value);
        const returningSql =
          returning && op !== 'select'
            ? ` RETURNING ${
                columns === '*'
                  ? '*'
                  : columns
                      .split(',')
                      .map((column) => identifier(column.trim()))
                      .join(', ')
              }`
            : '';
        if (op === 'insert') {
          const insertColumns = [...new Set(insertRows.flatMap((row) => Object.keys(row)))];
          const values = insertRows.map((row) => `(${insertColumns.map((column) => (column in row ? bindValue(column, row[column]) : 'DEFAULT')).join(', ')})`);
          const conflictSql = conflict
            ? ` ON CONFLICT (${conflict.onConflict
                .split(',')
                .map((column) => identifier(column.trim()))
                .join(', ')}) ${
                conflict.ignoreDuplicates
                  ? 'DO NOTHING'
                  : `DO UPDATE SET ${insertColumns.map((column) => `${identifier(column)} = EXCLUDED.${identifier(column)}`).join(', ')}`
              }`
            : '';
          sql = `INSERT INTO ${tableSql} (${insertColumns.map(identifier).join(', ')}) VALUES ${values.join(', ')}${conflictSql}${returningSql}`;
        } else if (op === 'delete') {
          sql = `DELETE FROM ${tableSql}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${returningSql}`;
        } else if (op === 'update') {
          const sets = Object.entries(payload).map(([column, value]) =>
            JSON_COLUMNS.has(column) ? `${identifier(column)} = ${bind(JSON.stringify(value), '::jsonb')}` : `${identifier(column)} = ${bind(value)}`,
          );
          sql = `UPDATE ${tableSql} SET ${sets.join(', ')}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${returningSql}`;
        } else if (head && count) {
          sql = `SELECT count(*)::int AS n FROM ${tableSql}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
        } else {
          const selected =
            columns === '*'
              ? '*'
              : columns
                  .split(',')
                  .map((column) => identifier(column.trim()))
                  .join(', ');
          sql = `SELECT ${selected} FROM ${tableSql}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${orderSql}${limitSql}`;
        }
        queries.push({ sql, params: [...params] });
        try {
          const result = await execute(sql, params);
          if (op !== 'select' && !returning) return { data: null, error: null };
          if (head && count) return { data: null, error: null, count: Number((result.rows[0] as { n: number }).n) };
          const rows = plain(result.rows);
          if (single) {
            if (rows.length > 1) {
              return { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' } };
            }
            return { data: rows[0] ?? null, error: null };
          }
          return { data: rows, error: null };
        } catch (error) {
          return { data: null, error: { code: 'XX000', message: error instanceof Error ? error.message : String(error) } };
        }
      };

      const builder = {
        select(next = '*', options?: { count?: 'exact'; head?: boolean }) {
          if (op !== 'select') returning = true;
          columns = next;
          head = options?.head === true;
          count = options?.count === 'exact';
          return builder;
        },
        delete() {
          op = 'delete';
          return builder;
        },
        update(next: Row) {
          op = 'update';
          payload = next;
          return builder;
        },
        insert(next: Row | Row[]) {
          op = 'insert';
          insertRows = Array.isArray(next) ? next : [next];
          return builder;
        },
        upsert(next: Row | Row[], upsertOptions?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          op = 'insert';
          insertRows = Array.isArray(next) ? next : [next];
          conflict = { onConflict: upsertOptions?.onConflict ?? 'id', ignoreDuplicates: upsertOptions?.ignoreDuplicates === true };
          return builder;
        },
        eq(column: string, value: unknown) {
          where.push(`${identifier(column)} = ${bind(value)}`);
          return builder;
        },
        neq(column: string, value: unknown) {
          where.push(`${identifier(column)} <> ${bind(value)}`);
          return builder;
        },
        is(column: string, value: null) {
          if (value !== null) throw new Error('[pglite-admin] is() takes null only');
          where.push(`${identifier(column)} IS NULL`);
          return builder;
        },
        gte(column: string, value: unknown) {
          where.push(`${identifier(column)} >= ${bind(value)}`);
          return builder;
        },
        gt(column: string, value: unknown) {
          where.push(`${identifier(column)} > ${bind(value)}`);
          return builder;
        },
        lte(column: string, value: unknown) {
          where.push(`${identifier(column)} <= ${bind(value)}`);
          return builder;
        },
        lt(column: string, value: unknown) {
          where.push(`${identifier(column)} < ${bind(value)}`);
          return builder;
        },
        range(from: number, to: number) {
          limitSql = ` LIMIT ${Math.trunc(to - from + 1)} OFFSET ${Math.trunc(from)}`;
          return builder;
        },
        in(column: string, values: unknown[]) {
          where.push(values.length === 0 ? 'FALSE' : `${identifier(column)} IN (${values.map((value) => bind(value)).join(', ')})`);
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orderSql += `${orderSql ? ', ' : ' ORDER BY '}${identifier(column)} ${options?.ascending === false ? 'DESC' : 'ASC'}`;
          return builder;
        },
        limit(n: number) {
          limitSql = ` LIMIT ${Math.trunc(n)}`;
          return builder;
        },
        abortSignal: () => builder,
        maybeSingle: () => run(true),
        then: (onFulfilled: (value: Result) => unknown, onRejected?: (reason: unknown) => unknown) =>
          run(false).then(onFulfilled, onRejected),
      };
      return builder;
    },
  };
  return admin;
}
