import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from './fixture-embedder.mts';

export interface FakeEdgeError {
  method: string;
  url: string;
  status: number;
  message: string;
}

export interface FakeEdgeCall {
  method: string;
  path: string;
  model?: string;
}

export interface FakeEdge {
  url: string;
  errors: FakeEdgeError[];
  calls: FakeEdgeCall[];
  close(): Promise<void>;
}

const RPC_ARGUMENTS: Record<string, { vector: string; allowed: string[] }> = {
  match_document_chunks: {
    vector: 'query_embedding',
    allowed: ['query_embedding', 'match_count', 'similarity_threshold'],
  },
  match_documents_by_workspace: {
    vector: 'p_query_embedding',
    allowed: ['p_query_embedding', 'p_match_count', 'p_min_similarity', 'p_org_id', 'p_user_id'],
  },
};

const TABLE_COLUMNS: Record<string, string[]> = {
  documents: ['id', 'filename', 'content', 'metadata', 'created_at', 'source', 'source_provider', 'source_file_id', 'organization_id', 'user_id'],
  document_chunks: ['id', 'document_id', 'content', 'metadata', 'created_at', 'organization_id', 'chunk_index'],
  organization_members: ['id', 'organization_id', 'user_id', 'role', 'created_at'],
  organizations: ['id', 'name', 'slug', 'owner_id', 'is_personal', 'subscription_tier', 'created_at'],
};

type FilterOperator = 'eq' | 'in' | 'is.null';

const TABLE_FILTERS: Record<string, Record<string, FilterOperator[]>> = {
  documents: { id: ['eq', 'in'], organization_id: ['eq', 'is.null'], user_id: ['eq'] },
  document_chunks: { id: ['eq', 'in'], document_id: ['eq', 'in'] },
  organization_members: { id: ['eq'], organization_id: ['eq'], user_id: ['eq'] },
  organizations: { id: ['eq'] },
};

const OR_ILIKE_COLUMNS: Record<string, string> = {
  content: '"content"',
  'metadata->>name': `("metadata"->>'name')`,
  'metadata->>image_context': `("metadata"->>'image_context')`,
};
const IMAGE_URL_PARAM = 'metadata->>image_url';
const IMAGE_URL_SQL = `("metadata"->>'image_url')`;
const OR_TABLE = 'document_chunks';
const MAX_IN_VALUES = 1000;
const MAX_OR_CONDITIONS = 50;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VECTOR_TEXT_RE = /^\[[-+0-9eE.,\s]*\]$/;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_LIMIT = 1000;
const OBJECT_ACCEPT = 'application/vnd.pgrst.object+json';

class Rejection extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? Number(value) : value;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Rejection(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Rejection(400, 'request body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Rejection(400, 'request body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function toVectorText(value: unknown, argName: string): string {
  if (Array.isArray(value)) {
    if (!value.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Rejection(400, `${argName} must contain only finite numbers`);
    return `[${value.join(',')}]`;
  }
  if (typeof value === 'string' && VECTOR_TEXT_RE.test(value)) return value;
  throw new Rejection(400, `${argName} must be an array of numbers or pgvector text`);
}

function createHandlers(db: PGlite, calls: FakeEdgeCall[], extras: { documentFilenameFilter: boolean }) {
  function embeddings(body: Record<string, unknown>): { payload: unknown } {
    const { input, model, encoding_format: encodingFormat, dimensions } = body;
    if (dimensions !== undefined && dimensions !== 1536) throw new Rejection(400, 'only 1536 dimensions are supported');
    if (encodingFormat !== undefined && encodingFormat !== 'float' && encodingFormat !== 'base64') {
      throw new Rejection(400, `unsupported encoding_format: ${String(encodingFormat)}`);
    }
    const inputs = typeof input === 'string' ? [input] : input;
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((x) => typeof x === 'string')) {
      throw new Rejection(400, 'input must be a string or an array of strings');
    }
    calls.push({ method: 'POST', path: '/v1/embeddings', model: typeof model === 'string' ? model : undefined });
    const data = inputs.map((text: string, index: number) => {
      const vec = embedText(text);
      return {
        object: 'embedding',
        index,
        embedding: encodingFormat === 'base64' ? Buffer.from(new Float32Array(vec).buffer).toString('base64') : vec,
      };
    });
    const tokens = inputs.reduce((sum: number, text: string) => sum + Math.ceil(text.length / 4), 0);
    return {
      payload: { object: 'list', data, model: typeof model === 'string' ? model : 'fixture-ngram', usage: { prompt_tokens: tokens, total_tokens: tokens } },
    };
  }

  async function rpc(fn: string, body: Record<string, unknown>): Promise<unknown[]> {
    const spec = RPC_ARGUMENTS[fn];
    if (!spec) throw new Rejection(404, `unsupported rpc function: ${fn}`);
    const names = Object.keys(body);
    const unknown = names.filter((name) => !spec.allowed.includes(name));
    if (unknown.length > 0) throw new Rejection(400, `unsupported rpc argument(s) for ${fn}: ${unknown.join(', ')}`);
    const values = names.map((name) => (name === spec.vector ? toVectorText(body[name], name) : body[name]));
    calls.push({ method: 'POST', path: `/rest/v1/rpc/${fn}` });
    const sql = `SELECT * FROM ${fn}(${names.map((name, i) => `${name} => $${i + 1}`).join(', ')})`;
    try {
      return (await db.query(sql, values)).rows as unknown[];
    } catch (error) {
      throw new Rejection(400, `rpc ${fn} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function read(table: string, params: URLSearchParams, wantsObject: boolean): Promise<{ status: number; payload: unknown }> {
    const allowedColumns = TABLE_COLUMNS[table];
    if (!allowedColumns) throw new Rejection(404, `unsupported table: ${table}`);

    const filters = TABLE_FILTERS[table] ?? {};
    for (const key of new Set(params.keys())) {
      const filenameFilter = extras.documentFilenameFilter && table === 'documents' && key === 'filename';
      const supported = key === 'select' || key === 'limit' || key in filters || filenameFilter || (table === OR_TABLE && (key === 'or' || key === IMAGE_URL_PARAM));
      if (!supported) throw new Rejection(400, `unsupported query parameter: ${key}`);
    }
    const select = params.get('select');
    if (!select) throw new Rejection(400, 'select parameter is required');
    const columns = select.split(',').map((column) => column.trim());
    const badColumn = columns.find((column) => !allowedColumns.includes(column));
    if (badColumn !== undefined) throw new Rejection(400, `unsupported column for ${table}: ${badColumn || '(empty)'}`);

    const where: string[] = [];
    const values: string[] = [];
    const bind = (value: string, cast = ''): string => {
      values.push(value);
      return `$${values.length}${cast}`;
    };

    for (const [column, operators] of Object.entries(filters)) {
      const raw = params.get(column);
      if (raw === null) continue;
      if (raw === 'is.null' && operators.includes('is.null')) {
        where.push(`"${column}" IS NULL`);
      } else if (raw.startsWith('eq.') && operators.includes('eq')) {
        const value = raw.slice(3);
        if (!UUID_RE.test(value)) throw new Rejection(400, `${column} filter must be a uuid`);
        where.push(`"${column}" = ${bind(value, '::uuid')}`);
      } else if (raw.startsWith('in.(') && raw.endsWith(')') && operators.includes('in')) {
        const inner = raw.slice(4, -1);
        const list = inner === '' ? [] : inner.split(',').map((item) => item.trim());
        if (list.length > MAX_IN_VALUES) throw new Rejection(400, `${column} in-list is limited to ${MAX_IN_VALUES} values`);
        if (!list.every((item) => UUID_RE.test(item))) throw new Rejection(400, `${column} in-list must contain only uuids`);
        where.push(list.length === 0 ? 'FALSE' : `"${column}" IN (${list.map((item) => bind(item, '::uuid')).join(', ')})`);
      } else {
        throw new Rejection(400, `unsupported operator on ${column}: ${raw.split('.')[0]}`);
      }
    }

    const filenameRaw = extras.documentFilenameFilter && table === 'documents' ? params.get('filename') : null;
    if (filenameRaw !== null) {
      if (filenameRaw.startsWith('eq.')) where.push(`"filename" = ${bind(filenameRaw.slice(3))}`);
      else if (filenameRaw.startsWith('ilike.')) where.push(`"filename" ILIKE ${bind(filenameRaw.slice(6))}`);
      else throw new Rejection(400, `unsupported operator on filename: ${filenameRaw.split('.')[0]}`);
    }

    if (table === OR_TABLE) {
      const imageUrl = params.get(IMAGE_URL_PARAM);
      if (imageUrl !== null) {
        if (imageUrl !== 'not.is.null') throw new Rejection(400, `unsupported operator on ${IMAGE_URL_PARAM}: ${imageUrl.split('.')[0]}`);
        where.push(`${IMAGE_URL_SQL} IS NOT NULL`);
      }
      for (const orRaw of params.getAll('or')) {
        if (!orRaw.startsWith('(') || !orRaw.endsWith(')')) throw new Rejection(400, 'or filter must be wrapped in parentheses');
        const conditions = orRaw.slice(1, -1).split(',');
        if (conditions.length > MAX_OR_CONDITIONS) throw new Rejection(400, `or filter is limited to ${MAX_OR_CONDITIONS} conditions`);
        const clauses = conditions.map((condition) => {
          const match = /^(content|metadata->>name|metadata->>image_context)\.ilike\.(.+)$/s.exec(condition);
          if (!match) throw new Rejection(400, `unsupported or condition: ${condition}`);
          return `${OR_ILIKE_COLUMNS[match[1]]} ILIKE ${bind(match[2])}`;
        });
        where.push(`(${clauses.join(' OR ')})`);
      }
    }

    let limitSql = '';
    const limitRaw = params.get('limit');
    if (limitRaw !== null) {
      if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIMIT) throw new Rejection(400, `limit must be an integer between 1 and ${MAX_LIMIT}`);
      limitSql = ` LIMIT ${Number(limitRaw)}`;
    }

    calls.push({ method: 'GET', path: `/rest/v1/${table}` });
    const sql = `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id${limitSql}`;
    let rows: unknown[];
    try {
      rows = (await db.query(sql, values)).rows as unknown[];
    } catch (error) {
      throw new Rejection(400, `read of ${table} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!wantsObject) return { status: 200, payload: rows };
    if (rows.length !== 1) {
      return {
        status: 406,
        payload: {
          code: 'PGRST116',
          details: `The result contains ${rows.length} rows`,
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        },
      };
    }
    return { status: 200, payload: rows[0] };
  }

  return { embeddings, rpc, read };
}

export interface FakeEdgeOptions {
  db: PGlite;
  /** Opt in to filename eq / ilike filters on documents (the chat route resolves @mentions that way). Off by default. */
  documentFilenameFilter?: boolean;
}

export async function startFakeEdge(options: FakeEdgeOptions): Promise<FakeEdge> {
  const errors: FakeEdgeError[] = [];
  const calls: FakeEdgeCall[] = [];
  const handlers = createHandlers(options.db, calls, { documentFilenameFilter: options.documentFilenameFilter === true });

  let queue: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const send = (res: http.ServerResponse, status: number, payload: unknown, contentType = 'application/json') => {
    const body = JSON.stringify(payload, jsonReplacer);
    res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    const requestUrl = req.url ?? '/';
    try {
      const url = new URL(requestUrl, 'http://127.0.0.1');
      const pathname = url.pathname;
      const rpcMatch = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(pathname);
      const tableMatch = /^\/rest\/v1\/([A-Za-z0-9_]+)$/.exec(pathname);

      if (pathname === '/v1/embeddings') {
        if (method !== 'POST') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        const { payload } = handlers.embeddings(parseJsonObject(await readBody(req)));
        send(res, 200, payload);
      } else if (rpcMatch) {
        if (method !== 'POST') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        send(res, 200, await handlers.rpc(rpcMatch[1], parseJsonObject(await readBody(req))));
      } else if (tableMatch) {
        if (method !== 'GET') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        const wantsObject = String(req.headers.accept ?? '').includes(OBJECT_ACCEPT);
        const { status, payload } = await handlers.read(tableMatch[1], url.searchParams, wantsObject);
        send(res, status, payload, status === 200 && wantsObject ? OBJECT_ACCEPT : 'application/json');
      } else {
        throw new Rejection(404, `unsupported path: ${pathname}`);
      }
    } catch (error) {
      const status = error instanceof Rejection ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ method, url: requestUrl, status, message });
      if (!res.headersSent) send(res, status, { code: 'FAKE_EDGE_UNSUPPORTED', message });
      else res.end();
    }
  };

  const server = http.createServer((req, res) => {
    void enqueue(() => handle(req, res));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    errors,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export function fixtureProcessEnv(edgeUrl: string): Record<string, string> {
  return {
    NEXT_PUBLIC_SUPABASE_URL: edgeUrl,
    OPENAI_BASE_URL: `${edgeUrl}/v1`,
    OPENAI_API_KEY: 'sk-fixture-placeholder-key-0000000000',
    OPENROUTER_API_KEY: 'sk-or-abcdefghijklmnopqrstuvwxyzabcdef',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture-anon-key-placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key-placeholder',
  };
}
