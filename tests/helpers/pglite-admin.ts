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

  const admin = {
    queries,
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
