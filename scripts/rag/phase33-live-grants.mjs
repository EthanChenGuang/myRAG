#!/usr/bin/env node
// Plan 03.3-26 Task 2 (D-02, D-38): PostgREST lockdown probe of migrations 1001-1009 on the eval project.
// Every new function and table is called as anon and as an authenticated user (expect permission denied), and the
// tenant list/read functions as service role for an empty test tenant (expect 200). Writes grants.json: names, roles,
// status codes and error codes only. Keys come from the shell environment and are never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
export const PHASE33_MIGRATION = /^100[1-9]_.+\.sql$/;
const DENIED_CODES = new Set(['42501']);

export const SERVICE_CALLS = [
  { name: 'rag_section_rule_sets_list', body: (t, a) => ({ p_actor: a, p_tenant_key: t }) },
  { name: 'rag_boilerplate_rules_list', body: (t, a) => ({ p_actor: a, p_tenant_key: t }) },
  { name: 'rag_attribute_definitions_list', body: (t, a) => ({ p_actor: a, p_tenant_key: t }) },
  { name: 'rag_attribute_header_template_get', body: (t, a) => ({ p_actor: a, p_tenant_key: t }) },
  { name: 'rag_staged_attributes_read', body: (t) => ({ p_tenant_key: t, p_source: 'upload', p_source_keys: [] }) },
  { name: 'rag_document_attributes_read', body: (t) => ({ p_tenant_key: t, p_document_ids: [] }) },
];

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Functions (callable, not trigger functions) and tables created by the Phase 3.3 migrations, in file order. */
export function parseMigrations(dir = MIGRATIONS_DIR) {
  const functions = new Map();
  const tables = new Set();
  const files = fs.readdirSync(dir).filter((file) => PHASE33_MIGRATION.test(file)).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi)) tables.add(match[1]);
    const pattern = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(/gi;
    for (const match of sql.matchAll(pattern)) {
      let depth = 1;
      let index = match.index + match[0].length;
      const start = index;
      while (depth > 0 && index < sql.length) {
        if (sql[index] === '(') depth += 1;
        if (sql[index] === ')') depth -= 1;
        index += 1;
      }
      const params = splitTopLevel(sql.slice(start, index - 1)).map((param) => param.split(/\s+/)[0].toLowerCase());
      const returns = /^\s*RETURNS\s+([a-z]+)/i.exec(sql.slice(index))?.[1]?.toLowerCase();
      if (returns === 'trigger') continue;
      functions.set(match[1], { name: match[1], params, file });
    }
  }
  return { functions: [...functions.values()], tables: [...tables], files };
}

async function call(fetchImpl, url, init) {
  const res = await fetchImpl(url, { redirect: 'error', ...init });
  let code = null;
  try {
    const body = await res.json();
    if (body && typeof body === 'object' && typeof body.code === 'string') code = body.code;
  } catch {
    code = null;
  }
  return { status: res.status, code };
}

function denied({ status, code }) {
  return status === 401 || status === 403 || (code !== null && DENIED_CODES.has(code));
}

export function readProbeEnv(env) {
  const missing = [];
  const pick = (name) => {
    const value = env[name]?.trim();
    if (!value) missing.push(name);
    return value ?? '';
  };
  const config = {
    url: pick('NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/, ''),
    anonKey: pick('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    userJwt: pick('PHASE33_AUTH_JWT'),
    serviceKey: pick('SUPABASE_SERVICE_ROLE_KEY'),
    tenantKey: pick('PHASE33_TENANT_KEY'),
    actor: pick('PHASE33_ADMIN_ACTOR'),
    projectRef: pick('PHASE33_PROJECT_REF'),
  };
  if (missing.length > 0) return { ok: false, reason: `missing environment: ${missing.join(', ')}` };
  let host;
  try {
    host = new URL(config.url).host;
  } catch {
    return { ok: false, reason: 'NEXT_PUBLIC_SUPABASE_URL is not a URL' };
  }
  if (host !== `${config.projectRef}.supabase.co`) {
    return { ok: false, reason: 'NEXT_PUBLIC_SUPABASE_URL is not the project named by PHASE33_PROJECT_REF' };
  }
  return { ok: true, config };
}

export async function runGrants({ fetchImpl = fetch, config, migrations = parseMigrations() }) {
  const rows = [];
  const clients = [
    { role: 'anon', bearer: config.anonKey },
    { role: 'authenticated', bearer: config.userJwt },
  ];
  for (const client of clients) {
    const headers = { apikey: config.anonKey, authorization: `Bearer ${client.bearer}`, 'content-type': 'application/json' };
    for (const fn of migrations.functions) {
      const body = Object.fromEntries(fn.params.map((param) => [param, null]));
      const result = await call(fetchImpl, `${config.url}/rest/v1/rpc/${fn.name}`, { method: 'POST', headers, body: JSON.stringify(body) });
      rows.push({ name: fn.name, kind: 'function', op: 'execute', role: client.role, ...result, denied: denied(result) });
    }
    for (const table of migrations.tables) {
      const select = await call(fetchImpl, `${config.url}/rest/v1/${table}?select=*&limit=1`, { method: 'GET', headers });
      rows.push({ name: table, kind: 'table', op: 'select', role: client.role, ...select, denied: denied(select) });
      const insert = await call(fetchImpl, `${config.url}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...headers, prefer: 'return=minimal' },
        body: JSON.stringify({}),
      });
      rows.push({ name: table, kind: 'table', op: 'insert', role: client.role, ...insert, denied: denied(insert) });
    }
  }
  const serviceHeaders = { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' };
  for (const entry of SERVICE_CALLS) {
    const result = await call(fetchImpl, `${config.url}/rest/v1/rpc/${entry.name}`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify(entry.body(config.tenantKey, config.actor)),
    });
    rows.push({ name: entry.name, kind: 'function', op: 'execute', role: 'service_role', ...result, denied: denied(result) });
  }
  const clientRows = rows.filter((row) => row.role !== 'service_role');
  const serviceRows = rows.filter((row) => row.role === 'service_role');
  const failures = [
    ...clientRows.filter((row) => !row.denied).map((row) => `${row.role} ${row.op} ${row.name}: ${row.status} ${row.code ?? ''}`.trim()),
    ...serviceRows.filter((row) => row.status < 200 || row.status >= 300).map((row) => `service_role ${row.name}: ${row.status} ${row.code ?? ''}`.trim()),
  ];
  return { rows, failures };
}

async function main(argv) {
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (!out) {
    console.error('[Phase33 Live] usage: node scripts/rag/phase33-live-grants.mjs --out <grants.json>');
    return 2;
  }
  const env = readProbeEnv(process.env);
  if (!env.ok) {
    console.error(`[Phase33 Live] ${env.reason}`);
    return 2;
  }
  const migrations = parseMigrations();
  const { rows, failures } = await runGrants({ config: env.config, migrations });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), `${JSON.stringify(rows, null, 2)}\n`);
  console.log(
    `[Phase33 Live] ${migrations.functions.length} functions, ${migrations.tables.length} tables; ${rows.length} calls; ${failures.length} failure(s)`,
  );
  for (const line of failures) console.log(`[Phase33 Live] not refused or failed: ${line}`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[Phase33 Live] internal error: ${error?.name ?? 'Error'}`);
      process.exit(70);
    },
  );
}
