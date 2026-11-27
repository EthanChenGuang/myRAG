import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMigrations, readProbeEnv, runGrants, SERVICE_CALLS } from '../scripts/rag/phase33-live-grants.mjs';

const TABLES = ['rag_section_rule_sets', 'rag_boilerplate_rules', 'rag_attribute_definitions', 'rag_attribute_header_templates', 'rag_staged_attributes'];
const config = {
  url: 'https://abcdefghijklmnopqrst.supabase.co',
  anonKey: 'placeholder-anon',
  userJwt: 'placeholder-user',
  serviceKey: 'placeholder-service',
  tenantKey: 's:default',
  actor: '00000000-0000-4000-8000-000000000001',
  projectRef: 'abcdefghijklmnopqrst',
};

function fakeFetch(open: Set<string> = new Set()) {
  const calls: { url: string; auth: string }[] = [];
  const impl = async (url: string, init: { headers: Record<string, string> }) => {
    const auth = init.headers.authorization;
    calls.push({ url, auth });
    const name = new URL(url).pathname.split('/').pop() as string;
    const service = auth === `Bearer ${config.serviceKey}`;
    const ok = service || open.has(name);
    return new Response(JSON.stringify(ok ? [] : { code: '42501', message: 'permission denied' }), { status: ok ? 200 : 401 });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

test('parses the Phase 3.3 tables and callable functions, without trigger functions', () => {
  const parsed = parseMigrations();
  assert.equal(parsed.files.length, 9);
  assert.deepEqual([...parsed.tables].sort(), [...TABLES].sort());
  const names = parsed.functions.map((fn) => fn.name);
  for (const trigger of ['rag_chunk_attribute_header_stamp', 'rag_chunks_x_document_attributes', 'rag_documents_x_attribute_insert_guard']) {
    assert.ok(!names.includes(trigger), trigger);
  }
  for (const fn of ['rag_import_document_attributes', 'rag_attribute_documents', 'rag_purge_hook_doc_attributes', 'rag_tenant_rule_data_delete']) {
    assert.ok(names.includes(fn), fn);
  }
  const header = parsed.functions.find((fn) => fn.name === 'rag_attribute_header_template_get');
  assert.deepEqual(header?.params, ['p_actor', 'p_tenant_key']);
  for (const call of SERVICE_CALLS) assert.ok(names.includes(call.name), call.name);
});

test('a locked-down project has no failures and at least five service-role checks', async () => {
  const { impl } = fakeFetch();
  const { rows, failures } = await runGrants({ fetchImpl: impl, config });
  assert.deepEqual(failures, []);
  assert.ok(rows.filter((row) => row.role !== 'service_role').every((row) => row.status >= 400 && row.denied));
  assert.ok(rows.filter((row) => row.role === 'service_role').length >= 5);
  assert.ok(rows.some((row) => row.kind === 'table' && row.op === 'insert' && row.role === 'authenticated'));
});

test('a client call that succeeds is a failure', async () => {
  const { impl } = fakeFetch(new Set(['rag_attribute_documents']));
  const { failures } = await runGrants({ fetchImpl: impl, config });
  assert.deepEqual(failures, ['anon execute rag_attribute_documents: 200', 'authenticated execute rag_attribute_documents: 200']);
});

test('rows carry names, roles and codes, never a key', async () => {
  const { impl, calls } = fakeFetch();
  const { rows } = await runGrants({ fetchImpl: impl, config });
  const blob = JSON.stringify(rows);
  for (const secret of [config.anonKey, config.userJwt, config.serviceKey, config.actor]) assert.ok(!blob.includes(secret));
  assert.ok(calls.some((call) => call.auth === `Bearer ${config.userJwt}`));
});

test('the probe refuses a URL of another project and missing keys', () => {
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: 'https://otherprojectref00000.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a',
    PHASE33_AUTH_JWT: 'b',
    SUPABASE_SERVICE_ROLE_KEY: 'c',
    PHASE33_TENANT_KEY: 's:default',
    PHASE33_ADMIN_ACTOR: config.actor,
    PHASE33_PROJECT_REF: config.projectRef,
  };
  assert.equal(readProbeEnv(env).ok, false);
  assert.equal(readProbeEnv({ ...env, NEXT_PUBLIC_SUPABASE_URL: config.url }).ok, true);
  const missing = readProbeEnv({ ...env, SUPABASE_SERVICE_ROLE_KEY: '' });
  assert.equal(missing.ok, false);
  assert.match(String((missing as { reason: string }).reason), /SUPABASE_SERVICE_ROLE_KEY/);
});
