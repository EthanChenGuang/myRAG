import { randomBytes } from 'node:crypto';
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

const GENERIC_RPC_NAME = /^(?:rag_[a-z0-9_]+|match_chunks_by_profile)$/;
const VECTOR_ARGUMENT_TYPES = new Set(['vector', 'halfvec']);
const JSON_ARGUMENT_TYPES = new Set(['json', 'jsonb']);
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const SQLSTATE_STATUS: Record<string, number> = { '42501': 403, '23503': 409, '23505': 409, '42883': 404 };

// Input arguments of the public function with this name (PostgREST resolves named arguments against the same list); one row per overload.
const RPC_SIGNATURE_SQL = `
SELECT COALESCE(jsonb_agg(jsonb_build_object('name', a.name, 'type', format_type(a.type, NULL)) ORDER BY a.ord) FILTER (WHERE a.name IS NOT NULL), '[]'::jsonb) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
LEFT JOIN LATERAL (
  SELECT t.ord, t.type, nm.name
  FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY AS t(type, ord)
  LEFT JOIN unnest(p.proargnames) WITH ORDINALITY AS nm(name, ord) ON nm.ord = t.ord
  LEFT JOIN unnest(p.proargmodes::text[]) WITH ORDINALITY AS md(mode, ord) ON md.ord = t.ord
  WHERE COALESCE(md.mode, 'i') IN ('i', 'b', 'v')
) a ON true
WHERE p.proname = $1 AND p.prokind = 'f'
GROUP BY p.oid`;

interface RpcSignature {
  args: Map<string, string>;
}

const TABLE_COLUMNS: Record<string, string[]> = {
  documents: [
    'id',
    'filename',
    'content',
    'metadata',
    'created_at',
    'source',
    'source_provider',
    'source_file_id',
    'organization_id',
    'user_id',
    'is_current',
    'status',
    'tenant_key',
    'lineage_id',
    'version',
    'doc_type',
  ],
  document_chunks: ['id', 'document_id', 'content', 'metadata', 'created_at', 'organization_id', 'chunk_index', 'is_current', 'status', 'tenant_key', 'version', 'doc_type'],
  organization_members: ['id', 'organization_id', 'user_id', 'role', 'created_at'],
  organizations: ['id', 'name', 'slug', 'owner_id', 'is_personal', 'subscription_tier', 'created_at'],
};

type FilterOperator = 'eq' | 'in' | 'is.null';

const TABLE_FILTERS: Record<string, Record<string, FilterOperator[]>> = {
  documents: {
    id: ['eq', 'in'],
    organization_id: ['eq', 'is.null'],
    user_id: ['eq'],
    is_current: ['eq'],
    status: ['eq'],
    tenant_key: ['eq'],
    lineage_id: ['eq'],
    version: ['eq'],
    doc_type: ['eq'],
  },
  document_chunks: { id: ['eq', 'in'], document_id: ['eq', 'in'], is_current: ['eq'], status: ['eq'], tenant_key: ['eq'], version: ['eq'], doc_type: ['eq'] },
  organization_members: { id: ['eq'], organization_id: ['eq'], user_id: ['eq'] },
  organizations: { id: ['eq'] },
};

/** Value type of a filtered column; a column that is not listed holds a uuid. */
const FILTER_VALUE_TYPES: Record<string, 'boolean' | 'integer' | 'text'> = {
  is_current: 'boolean',
  version: 'integer',
  status: 'text',
  tenant_key: 'text',
  doc_type: 'text',
};
const BOOLEAN_FILTER_RE = /^(true|false)$/;
const INTEGER_FILTER_RE = /^-?\d{1,9}$/;

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
/** Matches `OBJECT_KEY_PATTERN` in src/lib/rag/ingest/object-store.ts (duplicated to avoid loading app env). */
const OBJECT_KEY_PATTERN = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/;
const DEFAULT_JWT_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fixture-default-signature-placeholder';
const DEFAULT_ANON_KEY = 'fixture-anon-key-placeholder';
const STORAGE_OBJECT_PATH = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/;
const STORAGE_LIST_PATH = /^\/storage\/v1\/object\/list\/([^/]+)$/;

function defaultServiceKeys(): string[] {
  return [DEFAULT_JWT_SERVICE_KEY, `sb_secret_${randomBytes(12).toString('hex')}`];
}

function isJwtShapedServiceKey(key: string): boolean {
  return key.startsWith('eyJ') && key.split('.').length === 3;
}

function assertStorageObjectKey(key: string): void {
  if (key === '' || key.includes('..') || !OBJECT_KEY_PATTERN.test(key) || key.startsWith('/')) {
    throw new Rejection(400, 'invalid object key');
  }
  for (const segment of key.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new Rejection(400, 'invalid object key');
  }
}

function storageMapKey(bucket: string, objectKey: string): string {
  return `${bucket}\0${objectKey}`;
}

function resolveStorageServiceKey(
  req: http.IncomingMessage,
  serviceKeys: string[],
  anonKey: string,
): string {
  const apiKeyRaw = req.headers.apikey;
  const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw : undefined;
  const authRaw = req.headers.authorization;
  const bearerMatch = typeof authRaw === 'string' ? /^Bearer\s+(.+)$/i.exec(authRaw) : null;
  const bearer = bearerMatch?.[1];

  if (!apiKey && bearer?.startsWith('sb_secret_')) {
    throw new Rejection(401, 'invalid api key');
  }

  const candidates = new Set<string>();
  if (apiKey) candidates.add(apiKey);
  if (bearer && isJwtShapedServiceKey(bearer)) candidates.add(bearer);

  if (candidates.size === 0) throw new Rejection(401, 'missing api key');

  for (const candidate of candidates) {
    if (candidate === anonKey) throw new Rejection(401, 'anon key cannot access storage');
    if (serviceKeys.includes(candidate)) return candidate;
  }

  throw new Rejection(401, 'invalid api key');
}

function readBodyBuffer(req: http.IncomingMessage): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

class Rejection extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

function databaseRejection(fn: string, error: unknown): Rejection {
  const failure = error as { code?: unknown; detail?: unknown; hint?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  if (typeof failure.code === 'string' && SQLSTATE_RE.test(failure.code)) {
    const status = SQLSTATE_STATUS[failure.code] ?? 400;
    const details = typeof failure.detail === 'string' ? failure.detail : null;
    const hint = typeof failure.hint === 'string' ? failure.hint : null;
    return new Rejection(status, message, { code: failure.code, message, details, hint });
  }
  return new Rejection(400, `rpc ${fn} failed: ${message}`);
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
  const signatures = new Map<string, RpcSignature>();

  async function signatureOf(fn: string): Promise<RpcSignature | null> {
    const cached = signatures.get(fn);
    if (cached) return cached;
    const result = await db.query<{ args: Array<{ name: string; type: string }> }>(RPC_SIGNATURE_SQL, [fn]);
    if (result.rows.length === 0) return null;
    if (result.rows.length > 1) throw new Rejection(400, `overloaded rpc function is not supported: ${fn}`);
    const signature: RpcSignature = { args: new Map(result.rows[0].args.map((arg) => [arg.name, arg.type])) };
    signatures.set(fn, signature);
    return signature;
  }

  function bindArgument(name: string, type: string, value: unknown): unknown {
    if (value === null) return null;
    if (VECTOR_ARGUMENT_TYPES.has(type)) return toVectorText(value, name);
    if (JSON_ARGUMENT_TYPES.has(type)) return JSON.stringify(value);
    return value;
  }

  function vendorEmbeddings(kind: 'voyage' | 'deepinfra' | 'openrouter', body: Record<string, unknown>): { payload: unknown } {
    const { input, model, output_dimension: outputDimension, input_type: inputType } = body;
    const inputs = typeof input === 'string' ? [input] : input;
    if (!Array.isArray(inputs) || inputs.length === 0 || !inputs.every((x) => typeof x === 'string')) {
      throw new Rejection(400, 'input must be a string or an array of strings');
    }
    const path =
      kind === 'voyage'
        ? '/voyage/v1/embeddings'
        : kind === 'deepinfra'
          ? '/deepinfra/v1/openai/embeddings'
          : '/openrouter/api/v1/embeddings';
    const voyageDims = kind === 'voyage' ? Number(outputDimension ?? 1024) : null;
    const qwenDims =
      kind === 'voyage'
        ? null
        : String(model).includes('Qwen') || String(model).includes('qwen')
          ? 4096
          : 1536;
    const size = voyageDims ?? qwenDims ?? 1536;
    calls.push({
      method: 'POST',
      path,
      model: typeof model === 'string' ? model : undefined,
    });
    const data = inputs.map((text: string, index: number) => {
      const vec = embedText(text, size);
      return { object: 'embedding', index, embedding: vec };
    });
    const tokens = inputs.reduce((sum: number, text: string) => sum + Math.ceil(text.length / 4), 0);
    const responseModel =
      kind === 'voyage'
        ? 'voyage-4-large'
        : typeof model === 'string'
          ? model
          : 'fixture-qwen';
    const payload: Record<string, unknown> = {
      object: 'list',
      data,
      model: responseModel,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    };
    if (kind === 'voyage' && inputType !== undefined) payload.input_type = inputType;
    if (kind === 'voyage' && outputDimension !== undefined) payload.output_dimension = outputDimension;
    return { payload };
  }

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
    if (!spec) return genericRpc(fn, body);
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

  async function genericRpc(fn: string, body: Record<string, unknown>): Promise<unknown[]> {
    if (!GENERIC_RPC_NAME.test(fn)) throw new Rejection(404, `unsupported rpc function: ${fn}`);
    const signature = await signatureOf(fn);
    if (!signature) throw new Rejection(404, `unsupported rpc function: ${fn}`);
    const names = Object.keys(body);
    const unknown = names.filter((name) => !signature.args.has(name));
    if (unknown.length > 0) throw new Rejection(400, `unsupported rpc argument(s) for ${fn}: ${unknown.join(', ')}`);
    const values = names.map((name) => bindArgument(name, signature.args.get(name) as string, body[name]));
    calls.push({ method: 'POST', path: `/rest/v1/rpc/${fn}` });
    const sql = `SELECT * FROM ${fn}(${names.map((name, i) => `${name} => $${i + 1}`).join(', ')})`;
    try {
      return (await db.query(sql, values)).rows as unknown[];
    } catch (error) {
      throw databaseRejection(fn, error);
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
        const valueType = FILTER_VALUE_TYPES[column];
        if (valueType === 'boolean') {
          if (!BOOLEAN_FILTER_RE.test(value)) throw new Rejection(400, `${column} filter must be true or false`);
          where.push(`"${column}" = ${bind(value, '::boolean')}`);
        } else if (valueType === 'integer') {
          if (!INTEGER_FILTER_RE.test(value)) throw new Rejection(400, `${column} filter must be an integer`);
          where.push(`"${column}" = ${bind(value, '::integer')}`);
        } else if (valueType === 'text') {
          if (value === '') throw new Rejection(400, `${column} filter must not be empty`);
          where.push(`"${column}" = ${bind(value)}`);
        } else {
          if (!UUID_RE.test(value)) throw new Rejection(400, `${column} filter must be a uuid`);
          where.push(`"${column}" = ${bind(value, '::uuid')}`);
        }
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

  return { embeddings, vendorEmbeddings, rpc, read };
}

export interface FakeEdgeOptions {
  db: PGlite;
  /** Opt in to filename eq / ilike filters on documents (the chat route resolves @mentions that way). Off by default. */
  documentFilenameFilter?: boolean;
  /** Service-role keys accepted on Storage routes (default: one JWT-shaped and one sb_secret_ placeholder). */
  serviceKeys?: string[];
  /** Anon key rejected on Storage routes. */
  anonKey?: string;
}

export async function startFakeEdge(options: FakeEdgeOptions): Promise<FakeEdge> {
  const errors: FakeEdgeError[] = [];
  const calls: FakeEdgeCall[] = [];
  const handlers = createHandlers(options.db, calls, { documentFilenameFilter: options.documentFilenameFilter === true });
  const serviceKeys = options.serviceKeys ?? defaultServiceKeys();
  const anonKey = options.anonKey ?? DEFAULT_ANON_KEY;
  const storageObjects = new Map<string, Buffer>();

  const sendBytes = (res: http.ServerResponse, status: number, body: Buffer, extraHeaders?: Record<string, string>) => {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      ...extraHeaders,
    };
    res.writeHead(status, headers);
    res.end(body);
  };

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
      const pathname = (requestUrl.split('?')[0] ?? url.pathname).replace(/\/+/g, '/');
      const rpcMatch = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(pathname);
      const tableMatch = /^\/rest\/v1\/([A-Za-z0-9_]+)$/.exec(pathname);
      const storageListMatch = STORAGE_LIST_PATH.exec(pathname);
      const storageObjectMatch = STORAGE_OBJECT_PATH.exec(pathname);

      if (pathname.startsWith('/storage/v1/')) {
        resolveStorageServiceKey(req, serviceKeys, anonKey);
      }

      if (storageListMatch) {
        if (method !== 'POST') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        const bucket = decodeURIComponent(storageListMatch[1]);
        const body = parseJsonObject(await readBody(req));
        const prefix = typeof body.prefix === 'string' ? body.prefix : '';
        const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.min(body.limit, MAX_LIMIT) : MAX_LIMIT;
        calls.push({ method: 'POST', path: `/storage/v1/object/list/${bucket}` });
        const names: string[] = [];
        for (const mapKey of storageObjects.keys()) {
          const [b, ...rest] = mapKey.split('\0');
          const name = rest.join('\0');
          if (b !== bucket) continue;
          if (prefix && !name.startsWith(prefix)) continue;
          names.push(name);
        }
        names.sort();
        send(res, 200, names.slice(0, limit).map((name) => ({ name })));
      } else if (storageObjectMatch) {
        const bucket = decodeURIComponent(storageObjectMatch[1]);
        const objectKey = storageObjectMatch[2]
          .split('/')
          .map((part) => decodeURIComponent(part))
          .join('/');
        assertStorageObjectKey(objectKey);
        const mapKey = storageMapKey(bucket, objectKey);
        const storagePath = `/storage/v1/object/${bucket}/${objectKey}`;
        calls.push({ method, path: storagePath });

        if (method === 'GET') {
          const found = storageObjects.get(mapKey);
          if (!found) throw new Rejection(404, 'object not found');
          sendBytes(res, 200, found);
        } else if (method === 'HEAD') {
          const found = storageObjects.get(mapKey);
          if (!found) throw new Rejection(404, 'object not found');
          res.writeHead(200, { 'content-length': String(found.length), 'content-type': 'application/octet-stream' });
          res.end();
        } else if (method === 'DELETE') {
          storageObjects.delete(mapKey);
          send(res, 200, { message: 'deleted' });
        } else if (method === 'POST' || method === 'PUT') {
          const bytes = await readBodyBuffer(req);
          storageObjects.set(mapKey, bytes);
          send(res, 200, { Key: objectKey });
        } else {
          throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        }
      } else if (pathname.startsWith('/storage/v1/')) {
        throw new Rejection(404, `unsupported path: ${pathname}`);
      } else if (pathname === '/v1/embeddings') {
        if (method !== 'POST') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        const { payload } = handlers.embeddings(parseJsonObject(await readBody(req)));
        send(res, 200, payload);
      } else if (pathname === '/voyage/v1/embeddings') {
        if (method !== 'POST') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        const { payload } = handlers.vendorEmbeddings('voyage', parseJsonObject(await readBody(req)));
        send(res, 200, payload);
      } else if (pathname === '/deepinfra/v1/openai/embeddings') {
        if (method !== 'POST') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        const { payload } = handlers.vendorEmbeddings('deepinfra', parseJsonObject(await readBody(req)));
        send(res, 200, payload);
      } else if (pathname === '/openrouter/api/v1/embeddings') {
        if (method !== 'POST') throw new Rejection(405, `unsupported method ${method} for ${pathname}`);
        const { payload } = handlers.vendorEmbeddings('openrouter', parseJsonObject(await readBody(req)));
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
      const body = error instanceof Rejection && error.body !== undefined ? error.body : { code: 'FAKE_EDGE_UNSUPPORTED', message };
      if (!res.headersSent) send(res, status, body);
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

export function fixtureProcessEnv(edgeUrl: string, options?: { vendorEmbeddingRoutes?: boolean }): Record<string, string> {
  const env: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: edgeUrl,
    OPENAI_BASE_URL: `${edgeUrl}/v1`,
    OPENAI_API_KEY: 'sk-fixture-placeholder-key-0000000000',
    OPENROUTER_API_KEY: 'sk-or-abcdefghijklmnopqrstuvwxyzabcdef',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture-anon-key-placeholder',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key-placeholder',
    VOYAGE_API_KEY: 'voyage-fixture-placeholder-key-00000000',
    DEEPINFRA_API_KEY: 'deepinfra-fixture-placeholder-key-00',
  };
  if (options?.vendorEmbeddingRoutes) {
    env.VOYAGE_BASE_URL = `${edgeUrl}/voyage/v1`;
    env.DEEPINFRA_BASE_URL = `${edgeUrl}/deepinfra/v1/openai`;
  }
  return env;
}
