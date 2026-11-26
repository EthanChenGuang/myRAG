import type { PGlite } from '@electric-sql/pglite';

/**
 * A small Supabase-js shaped client over PGlite for route tests that need real RLS. Each query runs in its own transaction as the
 * given role, with request.jwt.claim.sub set to the user, so the policies and SECURITY DEFINER helpers decide as on Supabase.
 * Supported: select (plain column list), update (with select for RETURNING), eq, in, contains, lt, or (the mined_at/id keyset grammar),
 * order, limit, maybeSingle; auth.admin.getUserById reads auth.users as service_role.
 * Every query is appended to `calls` as `<label>:<table>`.
 */

type Role = 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

export interface PgliteClientOptions {
  role: Role;
  userId?: string | null;
  label: string;
  calls: string[];
}

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`[pglite-rest] unsupported identifier ${name}`);
  return `"${name}"`;
}

/** Splits a PostgREST logic list at top-level commas, keeping double-quoted values and parentheses intact. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '(') depth += 1;
    if (!quoted && char === ')') depth -= 1;
    if (!quoted && depth === 0 && char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current !== '') parts.push(current);
  return parts;
}

const OPS: Record<string, string> = { eq: '=', lt: '<', gt: '>', lte: '<=', gte: '>=' };

function logicSql(expr: string, params: unknown[], joiner: 'OR' | 'AND'): string {
  const terms = splitTopLevel(expr).map((term) => {
    const nested = /^(and|or)\((.*)\)$/.exec(term);
    if (nested) return `(${logicSql(nested[2], params, nested[1] === 'and' ? 'AND' : 'OR')})`;
    const match = /^([a-z_]+)\.(eq|lt|gt|lte|gte)\.(.*)$/.exec(term);
    if (!match) throw new Error(`[pglite-rest] unsupported logic term ${term}`);
    const raw = match[3];
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    params.push(value);
    return `${ident(match[1])} ${OPS[match[2]]} $${params.length}`;
  });
  return terms.join(` ${joiner} `);
}

class Query implements PromiseLike<{ data: unknown; error: unknown }> {
  private columns = '*';
  private readonly where: string[] = [];
  private readonly params: unknown[] = [];
  private readonly orders: string[] = [];
  private limitCount: number | null = null;
  private single = false;
  private updateValues: Row | null = null;

  constructor(
    private readonly db: PGlite,
    private readonly table: string,
    private readonly options: PgliteClientOptions,
  ) {}

  select(columns: string): this {
    this.columns = columns
      .split(',')
      .map((column) => ident(column.trim()))
      .join(', ');
    return this;
  }

  update(values: Row): this {
    this.updateValues = values;
    return this;
  }

  abortSignal(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.params.push(value);
    this.where.push(`${ident(column)} = $${this.params.length}`);
    return this;
  }

  lt(column: string, value: unknown): this {
    this.params.push(value);
    this.where.push(`${ident(column)} < $${this.params.length}`);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.params.push(values.map(String));
    this.where.push(`${ident(column)}::text = ANY($${this.params.length}::text[])`);
    return this;
  }

  contains(column: string, values: unknown[]): this {
    this.params.push(values.map(String));
    this.where.push(`${ident(column)} @> $${this.params.length}::text[]`);
    return this;
  }

  or(expr: string): this {
    this.where.push(`(${logicSql(expr, this.params, 'OR')})`);
    return this;
  }

  order(column: string, options: { ascending?: boolean } = {}): this {
    this.orders.push(`${ident(column)} ${options.ascending === false ? 'DESC' : 'ASC'}`);
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    this.single = true;
    return this.run();
  }

  then<A = { data: unknown; error: unknown }, B = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<{ data: unknown; error: unknown }> {
    this.options.calls.push(`${this.options.label}:${this.table}`);
    const sql = this.updateValues ? this.updateSql(this.updateValues) : this.selectSql();
    return this.execute(sql);
  }

  private updateSql(values: Row): string {
    const sets = Object.entries(values).map(([column, value]) => {
      this.params.push(value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value);
      return `${ident(column)} = $${this.params.length}`;
    });
    return (
      `WITH t AS (UPDATE public.${ident(this.table)} SET ${sets.join(', ')}` +
      (this.where.length > 0 ? ` WHERE ${this.where.join(' AND ')}` : '') +
      ` RETURNING ${this.columns}) SELECT to_jsonb(t) AS row FROM t`
    );
  }

  private selectSql(): string {
    return (
      `SELECT to_jsonb(t) AS row FROM (SELECT ${this.columns} FROM public.${ident(this.table)}` +
      (this.where.length > 0 ? ` WHERE ${this.where.join(' AND ')}` : '') +
      (this.orders.length > 0 ? ` ORDER BY ${this.orders.join(', ')}` : '') +
      (this.limitCount !== null ? ` LIMIT ${Math.trunc(this.limitCount)}` : '') +
      ') t'
    );
  }

  private async execute(sql: string): Promise<{ data: unknown; error: unknown }> {
    try {
      const rows = await this.db.transaction(async (tx) => {
        await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [this.options.userId ?? '']);
        await tx.exec(`SET LOCAL ROLE ${this.options.role}`);
        return (await tx.query<{ row: Row }>(sql, this.params)).rows.map((r) => r.row);
      });
      if (this.single) {
        if (rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' } };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    } catch (error) {
      const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'unknown';
      return { data: null, error: { code, message: (error as Error).message } };
    }
  }
}

export function pgliteClient(db: PGlite, options: PgliteClientOptions) {
  return {
    from: (table: string) => new Query(db, table, options),
    auth: {
      getUser: async () => ({ data: { user: options.userId ? { id: options.userId } : null }, error: null }),
      admin: {
        getUserById: async (id: string) => {
          if (options.role !== 'service_role') return { data: { user: null }, error: { message: 'not allowed' } };
          const found = await db.query<{ id: string }>('SELECT id::text AS id FROM auth.users WHERE id::text = $1', [id]);
          const user = found.rows[0] ? { id: found.rows[0].id } : null;
          return { data: { user }, error: user ? null : { message: 'User not found' } };
        },
      },
    },
  };
}
