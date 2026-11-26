import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const MODES: DeploymentMode[] = ['multi-tenant', 'single-tenant'];
const PHASE33_FILE = 'supabase/migrations/1001_phase33_schema.sql';
const NEW_TABLES = [
  'rag_section_rule_sets',
  'rag_boilerplate_rules',
  'rag_attribute_definitions',
  'rag_attribute_header_templates',
  'rag_staged_attributes',
] as const;
type NewTable = (typeof NEW_TABLES)[number];
const NEW_DOCUMENT_COLUMNS: Record<string, string> = { attributes: 'jsonb', attribute_header: 'text', attribute_header_stamp: 'text' };
const NEW_CHUNK_COLUMNS: Record<string, string> = { attributes: 'jsonb', attribute_header_stamp: 'text' };
const RULES = (headings: number): string => JSON.stringify({ headings: Array.from({ length: headings }, (_, i) => ({ pattern: `^part ${i}\\b`, flags: 'u' })) });

const stem = (file: string): string => path.basename(file).slice(0, 4);
const filesBefore = (mode: DeploymentMode, limit: string): string[] => migrationFiles(mode).filter((file) => stem(file) < limit);

function sqlState(error: unknown): string {
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return sqlState(error) || String(error);
  }
}

async function tableExists(db: PGlite, table: string): Promise<boolean> {
  const result = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`]);
  return result.rows[0]?.present === true;
}

async function columnTypes(db: PGlite, table: string): Promise<Record<string, string>> {
  const result = await db.query<{ column: string; type: string }>(
    `SELECT a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type
     FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    [`public.${table}`],
  );
  return Object.fromEntries(result.rows.map((row) => [row.column, row.type]));
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated' | 'service_role', run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [FIXTURE_USER_ID]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function schemaDump(db: PGlite): Promise<string[]> {
  const queries = [
    `SELECT 'col' AS k, c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attnum > 0 AND NOT a.attisdropped`,
    `SELECT 'con' AS k, conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    `SELECT 'idx' AS k, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    `SELECT 'trg' AS k, tgrelid::regclass::text, tgname, pg_get_triggerdef(oid) FROM pg_trigger
     WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)`,
    `SELECT 'tbl' AS k, c.relname, c.relrowsecurity, c.relacl::text FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`,
    `SELECT 'pol' AS k, tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public'`,
  ];
  const out: string[] = [];
  for (const sql of queries) for (const row of (await db.query(sql)).rows) out.push(JSON.stringify(row));
  return out.sort();
}

for (const mode of MODES) {
  describe(`Phase 3.3 schema 1001 (${mode})`, () => {
    let db: PGlite;
    const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
    const secondTenant = `u:${crypto.randomUUID()}`;
    const orgTenant = `o:${crypto.randomUUID()}`;
    const otherModeTenant = mode === 'multi-tenant' ? 's:default' : `u:${crypto.randomUUID()}`;
    let preDocumentId = '';
    let preChunkId = '';

    async function insertDocument(): Promise<string> {
      const id = crypto.randomUUID();
      await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'p33.md', 'neutral body', $2)", [id, FIXTURE_USER_ID]);
      return id;
    }

    async function insertChunk(documentId: string): Promise<string> {
      const id = crypto.randomUUID();
      await db.query("INSERT INTO document_chunks (id, document_id, content, metadata) VALUES ($1, $2, 'neutral chunk text', '{}'::jsonb)", [id, documentId]);
      return id;
    }

    /** A valid row of each table for the given tenant; `n` keeps names and keys unique. */
    function seed(table: NewTable, tenantKey: string, n: number): [string, unknown[]] {
      switch (table) {
        case 'rag_section_rule_sets':
          return ['INSERT INTO rag_section_rule_sets (tenant_key, name, rules, enabled) VALUES ($1, $2, $3::jsonb, false)', [tenantKey, `set-${n}`, RULES(1)]];
        case 'rag_boilerplate_rules':
          return ["INSERT INTO rag_boilerplate_rules (tenant_key, name, kind, pattern, flags) VALUES ($1, $2, 'line', '^footer line$', 'u')", [tenantKey, `rule-${n}`]];
        case 'rag_attribute_definitions':
          return ["INSERT INTO rag_attribute_definitions (tenant_key, key, type) VALUES ($1, $2, 'text')", [tenantKey, `key_${n}`]];
        case 'rag_attribute_header_templates':
          return ["INSERT INTO rag_attribute_header_templates (tenant_key, template) VALUES ($1, '{alpha_code}') ON CONFLICT (tenant_key) DO NOTHING", [tenantKey]];
        case 'rag_staged_attributes':
          return ["INSERT INTO rag_staged_attributes (tenant_key, source, source_key, attributes) VALUES ($1, 'upload', $2, '{}'::jsonb)", [tenantKey, `item-${n}`]];
      }
    }

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false })).db;
      await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'fixture-user@example.invalid') ON CONFLICT (id) DO NOTHING", [FIXTURE_USER_ID]);
      await applyMigrationFiles(db, filesBefore(mode, '1001'));
      preDocumentId = await insertDocument();
      preChunkId = await insertChunk(preDocumentId);
      await applyMigrationFiles(db, migrationFiles(mode).filter((file) => stem(file) >= '1001'));
    });

    after(async () => {
      await db?.close();
    });

    test('the five tables exist, RLS on with zero policies, service_role only, and empty', async () => {
      for (const table of NEW_TABLES) {
        assert.ok(await tableExists(db, table), `${table} exists`);
        const rls = await db.query<{ enabled: boolean; policies: number; rows: number }>(
          `SELECT c.relrowsecurity AS enabled, (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = $1) AS policies
           FROM pg_class c WHERE c.oid = to_regclass($2)`,
          [table, `public.${table}`],
        );
        assert.deepEqual(rls.rows[0], { enabled: true, policies: 0 }, table);
        const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(count.rows[0]?.n, 0, `${table} is empty without a write`);
        const privileges = await db.query<{ role: string; select: boolean; insert: boolean; update: boolean; delete: boolean }>(
          `SELECT r.role, has_table_privilege(r.role, $1, 'SELECT') AS select, has_table_privilege(r.role, $1, 'INSERT') AS insert,
                  has_table_privilege(r.role, $1, 'UPDATE') AS update, has_table_privilege(r.role, $1, 'DELETE') AS delete
           FROM unnest(ARRAY['public', 'anon', 'authenticated', 'service_role']) AS r(role)`,
          [`public.${table}`],
        );
        for (const row of privileges.rows) {
          const expected = row.role === 'service_role';
          assert.deepEqual([row.select, row.insert, row.update, row.delete], [expected, expected, expected, expected], `${table} ${row.role}`);
        }
        const trigger = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = to_regclass($1) AND tgname = $2 AND tgfoid = 'public.rag_row_tenant_key_guard()'::regprocedure`,
          [`public.${table}`, `${table}_tenant_key_guard`],
        );
        assert.equal(trigger.rows[0]?.n, 1, `${table} tenant key guard`);
      }
    });

    test('anon and authenticated can neither read nor write the tables; service_role can insert, select, update and delete', async () => {
      let n = 100;
      for (const table of NEW_TABLES) {
        for (const role of ['anon', 'authenticated'] as const) {
          assert.equal(await asRole(db, role, () => failure(db, `SELECT 1 FROM ${table} LIMIT 1`)), '42501', `${role} select ${table}`);
          const [sql, params] = seed(table, tenant, (n += 1));
          assert.equal(await asRole(db, role, () => failure(db, sql, params)), '42501', `${role} insert ${table}`);
        }
        await asRole(db, 'service_role', async () => {
          const [sql, params] = seed(table, tenant, (n += 1));
          await db.query(sql, params);
          assert.ok(((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? 0) >= 1, `service_role reads ${table}`);
          const updated = await db.query(`UPDATE ${table} SET tenant_key = tenant_key WHERE tenant_key = $1`, [tenant]);
          assert.ok((updated.affectedRows ?? 0) >= 1, `service_role updates ${table}`);
          await db.query(`DELETE FROM ${table} WHERE tenant_key = $1`, [tenant]);
          assert.equal((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_key = $1`, [tenant])).rows[0]?.n, 0);
        });
      }
    });

    test('tenant keys: rows of separate tenants are independent, keys of the other mode and malformed keys are rejected', async () => {
      const accepted = mode === 'multi-tenant' ? [tenant, secondTenant, orgTenant] : [tenant];
      const rejected = mode === 'multi-tenant' ? ['s:default'] : [secondTenant, orgTenant];
      let n = 200;
      for (const table of NEW_TABLES) {
        for (const key of accepted) {
          const [sql, params] = seed(table, key, 1);
          await db.query(sql, params);
        }
        const counts = await db.query<{ tenant_key: string; n: number }>(`SELECT tenant_key, count(*)::int AS n FROM ${table} GROUP BY tenant_key ORDER BY 1`);
        assert.deepEqual(counts.rows.map((row) => [row.tenant_key, row.n]), [...accepted].sort().map((key) => [key, 1]), `${table} one row per tenant`);
        for (const key of [...rejected, 'not-a-tenant', 'u:XYZ']) {
          const [sql, params] = seed(table, key, (n += 1));
          assert.equal(await failure(db, sql, params), '22023', `${table} rejects ${key}`);
        }
        assert.equal(await failure(db, `UPDATE ${table} SET tenant_key = $1 WHERE tenant_key = $2`, [otherModeTenant, tenant]), '22023', `${table} update to other mode`);
        await db.query(`DELETE FROM ${table}`);
      }
    });

    test('rag_section_rule_sets: name, rules and binding limits, defaults', async () => {
      const insert = 'INSERT INTO rag_section_rule_sets (tenant_key, name, rules, doc_type, source, enabled) VALUES ($1, $2, $3::jsonb, $4, $5, $6)';
      const row = await db.query<{ version: number; enabled: boolean }>(
        "INSERT INTO rag_section_rule_sets (tenant_key, name, rules) VALUES ($1, 'set-a', $2::jsonb) RETURNING version, enabled",
        [tenant, RULES(1)],
      );
      assert.deepEqual(row.rows[0], { version: 1, enabled: true });
      assert.equal(await failure(db, insert, [tenant, '   ', RULES(1), null, null, false]), '23514', 'blank name');
      assert.equal(await failure(db, insert, [tenant, 'n'.repeat(81), RULES(1), null, null, false]), '23514', 'name of 81');
      assert.equal(await failure(db, insert, [tenant, 'set-b', '[]', null, null, false]), '23514', 'rules not an object');
      assert.equal(await failure(db, insert, [tenant, 'set-b', '"text"', null, null, false]), '23514', 'rules a string');
      assert.equal(await failure(db, insert, [tenant, 'set-b', '{"levels": []}', null, null, false]), '23514', 'no headings');
      assert.equal(await failure(db, insert, [tenant, 'set-b', '{"headings": {}}', null, null, false]), '23514', 'headings not an array');
      assert.equal(await failure(db, insert, [tenant, 'set-b', RULES(0), null, null, false]), '23514', '0 headings');
      assert.equal(await failure(db, insert, [tenant, 'set-b', RULES(61), null, null, false]), '23514', '61 headings');
      await db.query(insert, [tenant, 'set-60', RULES(60), null, null, false]);
      await db.query(insert, [tenant, 'n'.repeat(80), RULES(1), null, null, false]);
      assert.equal(await failure(db, insert, [tenant, 'set-a', RULES(1), null, null, false]), '23505', 'same name in one tenant');
      if (mode === 'multi-tenant') await db.query(insert, [secondTenant, 'set-a', RULES(1), null, null, true]);
      assert.equal(await failure(db, insert, [tenant, 'set-c', RULES(1), null, null, true]), '23505', 'second enabled tenant-wide binding');
      await db.query(insert, [tenant, 'set-d', RULES(1), 'kind_a', null, true]);
      assert.equal(await failure(db, insert, [tenant, 'set-e', RULES(1), 'kind_a', null, true]), '23505', 'second enabled type binding');
      await db.query(insert, [tenant, 'set-f', RULES(1), 'kind_a', null, false]);
      await db.query(insert, [tenant, 'set-g', RULES(1), 'kind_a', 'upload', true]);
      await db.query(insert, [tenant, 'set-h', RULES(1), null, 'upload', true]);
      assert.equal(await failure(db, insert, [tenant, 'set-i', RULES(1), null, 'upload', true]), '23505', 'second enabled source binding');
      assert.equal(await failure(db, insert, [tenant, 'set-j', RULES(1), 'Kind A', null, false]), '23514', 'doc_type shape');
      assert.equal(await failure(db, insert, [tenant, 'set-k', RULES(1), null, 's'.repeat(65), false]), '23514', 'source length');
      assert.equal(await failure(db, 'UPDATE rag_section_rule_sets SET version = 0 WHERE name = $1', ['set-a']), '23514', 'version at least 1');
      await db.query('DELETE FROM rag_section_rule_sets');
    });

    test('rag_boilerplate_rules: a line rule or a fragment rule, never both', async () => {
      const insert =
        'INSERT INTO rag_boilerplate_rules (tenant_key, name, kind, pattern, flags, max_length, min_page_share) VALUES ($1, $2, $3, $4, $5, $6, $7)';
      await db.query(insert, [tenant, 'line-a', 'line', '^page [0-9]+$', 'iu', null, null]);
      await db.query(insert, [tenant, 'frag-a', 'fragment', null, null, 200, 1]);
      await db.query(insert, [tenant, 'line-b', 'line', 'p'.repeat(200), 'u', null, null]);
      const cases: [string, unknown[]][] = [
        ['other kind', ['k1', 'block', '^x$', 'u', null, null]],
        ['line without pattern', ['k2', 'line', null, 'u', null, null]],
        ['line pattern of 201', ['k3', 'line', 'p'.repeat(201), 'u', null, null]],
        ['line flags g', ['k4', 'line', '^x$', 'g', null, null]],
        ['line without flags', ['k5', 'line', '^x$', null, null, null]],
        ['line with max length', ['k6', 'line', '^x$', 'u', 10, null]],
        ['line with page share', ['k7', 'line', '^x$', 'u', null, 0.5]],
        ['fragment with pattern', ['k8', 'fragment', '^x$', null, 10, 0.5]],
        ['fragment with flags', ['k9', 'fragment', null, 'u', 10, 0.5]],
        ['fragment max length 0', ['k10', 'fragment', null, null, 0, 0.5]],
        ['fragment max length 201', ['k11', 'fragment', null, null, 201, 0.5]],
        ['fragment page share 0', ['k12', 'fragment', null, null, 10, 0]],
        ['fragment page share above 1', ['k13', 'fragment', null, null, 10, 1.01]],
        ['fragment without page share', ['k14', 'fragment', null, null, 10, null]],
        ['blank name', ['  ', 'line', '^x$', 'u', null, null]],
        ['name of 81', ['n'.repeat(81), 'line', '^x$', 'u', null, null]],
      ];
      for (const [label, params] of cases) assert.equal(await failure(db, insert, [tenant, ...params]), '23514', label);
      assert.equal(await failure(db, insert, [tenant, 'line-a', 'line', '^y$', 'u', null, null]), '23505', 'same name');
      const defaults = await db.query<{ enabled: boolean; version: number }>("SELECT enabled, version FROM rag_boilerplate_rules WHERE name = 'line-a'");
      assert.deepEqual(defaults.rows[0], { enabled: true, version: 1 });
      await db.query('DELETE FROM rag_boilerplate_rules');
    });

    test('rag_attribute_definitions: key pattern, types, identifier-index flag, uniqueness and defaults', async () => {
      const insert = 'INSERT INTO rag_attribute_definitions (tenant_key, key, type, in_identifier_index) VALUES ($1, $2, $3, $4)';
      const row = await db.query<Record<string, boolean>>(
        "INSERT INTO rag_attribute_definitions (tenant_key, key, type) VALUES ($1, 'alpha_code', 'code') RETURNING filterable, in_header, in_identifier_index, soft",
        [tenant],
      );
      assert.deepEqual(row.rows[0], { filterable: false, in_header: false, in_identifier_index: false, soft: false });
      await db.query(insert, [tenant, 'beta_code', 'code', true]);
      await db.query(insert, [tenant, 'g'.repeat(40), 'text_list', false]);
      assert.equal(await failure(db, insert, [tenant, 'Alpha', 'text', false]), '23514', 'upper case');
      assert.equal(await failure(db, insert, [tenant, '1alpha', 'text', false]), '23514', 'leading digit');
      assert.equal(await failure(db, insert, [tenant, 'g'.repeat(41), 'text', false]), '23514', '41 characters');
      assert.equal(await failure(db, insert, [tenant, 'gamma', 'number', false]), '23514', 'unknown type');
      assert.equal(await failure(db, insert, [tenant, 'delta', 'text', true]), '23514', 'identifier index on text');
      assert.equal(await failure(db, insert, [tenant, 'epsilon', 'text_list', true]), '23514', 'identifier index on text_list');
      assert.equal(await failure(db, insert, [tenant, 'alpha_code', 'code', false]), '23505', 'same key');
      if (mode === 'multi-tenant') await db.query(insert, [secondTenant, 'alpha_code', 'code', false]);
      await db.query('DELETE FROM rag_attribute_definitions');
    });

    test('rag_attribute_header_templates: one per tenant, 1 to 200 characters', async () => {
      const insert = 'INSERT INTO rag_attribute_header_templates (tenant_key, template) VALUES ($1, $2)';
      await db.query(insert, [tenant, 't'.repeat(200)]);
      assert.equal(await failure(db, insert, [tenant, '{alpha_code}']), '23505', 'second row');
      if (mode === 'multi-tenant') await db.query(insert, [secondTenant, '{alpha_code}']);
      assert.equal(await failure(db, 'UPDATE rag_attribute_header_templates SET template = $1 WHERE tenant_key = $2', ['', tenant]), '23514', 'empty');
      assert.equal(await failure(db, 'UPDATE rag_attribute_header_templates SET template = $1 WHERE tenant_key = $2', ['t'.repeat(201), tenant]), '23514', '201');
      const version = await db.query<{ version: number }>('SELECT version FROM rag_attribute_header_templates WHERE tenant_key = $1', [tenant]);
      assert.equal(version.rows[0]?.version, 1);
      await db.query('DELETE FROM rag_attribute_header_templates');
    });

    test('rag_staged_attributes: key per tenant, source and source key; attributes an object within the byte bound', async () => {
      const insert = 'INSERT INTO rag_staged_attributes (tenant_key, source, source_key, attributes) VALUES ($1, $2, $3, $4::jsonb)';
      await db.query(insert, [tenant, 'upload', 'item-1', '{"alpha_code": "A-1"}']);
      assert.equal(await failure(db, insert, [tenant, 'upload', 'item-1', '{}']), '23505', 'same key');
      await db.query(insert, [tenant, 'google-drive', 'item-1', '{}']);
      if (mode === 'multi-tenant') await db.query(insert, [secondTenant, 'upload', 'item-1', '{}']);
      for (const value of ['[]', '"text"', '1', 'null']) {
        assert.equal(await failure(db, insert, [tenant, 'upload', `item-${value}`, value]), '23514', `attributes ${value}`);
      }
      assert.equal(await failure(db, insert, [tenant, 'Upload', 'item-2', '{}']), '23514', 'source shape');
      assert.equal(await failure(db, insert, [tenant, 'upload', '', '{}']), '23514', 'empty source key');
      const huge = JSON.stringify({ alpha: 'x'.repeat(2_000_001) });
      assert.equal(await failure(db, insert, [tenant, 'upload', 'item-3', huge]), '23514', 'byte bound');
      const largest = JSON.stringify(
        Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`key_${k}`, Array.from({ length: 50 }, (_, v) => `${v}`.padEnd(200, 'v'))])),
      );
      await db.query(insert, [tenant, 'upload', 'item-4', largest]);
      const staged = await db.query<{ staged: boolean }>("SELECT staged_at IS NOT NULL AS staged FROM rag_staged_attributes WHERE source_key = 'item-1' AND source = 'upload' AND tenant_key = $1", [tenant]);
      assert.equal(staged.rows[0]?.staged, true);
      await db.query('DELETE FROM rag_staged_attributes');
    });

    test('no new table refers to a document, chunk or lineage', async () => {
      for (const table of NEW_TABLES) {
        const columns = Object.keys(await columnTypes(db, table));
        for (const forbidden of ['document_id', 'chunk_id', 'lineage_id']) assert.ok(!columns.includes(forbidden), `${table}.${forbidden}`);
        const references = await db.query<{ target: string }>(
          "SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = 'f'",
          [`public.${table}`],
        );
        for (const row of references.rows) assert.ok(!['documents', 'document_chunks', 'document_parents'].includes(row.target), `${table} -> ${row.target}`);
      }
    });

    test('document and chunk columns exist with their types, nullable without default, null on rows written before 1001', async () => {
      for (const [table, expected] of [['documents', NEW_DOCUMENT_COLUMNS], ['document_chunks', NEW_CHUNK_COLUMNS]] as const) {
        const types = await columnTypes(db, table);
        for (const [column, type] of Object.entries(expected)) assert.equal(types[column], type, `${table}.${column}`);
        const shape = await db.query<{ column: string; notnull: boolean; hasdefault: boolean }>(
          `SELECT attname AS "column", attnotnull AS notnull, atthasdef AS hasdefault FROM pg_attribute
           WHERE attrelid = to_regclass($1) AND attname = ANY ($2::text[])`,
          [`public.${table}`, Object.keys(expected)],
        );
        for (const row of shape.rows) assert.deepEqual([row.notnull, row.hasdefault], [false, false], `${table}.${row.column}`);
      }
      const doc = await db.query('SELECT attributes, attribute_header, attribute_header_stamp FROM documents WHERE id = $1', [preDocumentId]);
      assert.deepEqual(doc.rows[0], { attributes: null, attribute_header: null, attribute_header_stamp: null });
      const chunk = await db.query('SELECT attributes, attribute_header_stamp FROM document_chunks WHERE id = $1', [preChunkId]);
      assert.deepEqual(chunk.rows[0], { attributes: null, attribute_header_stamp: null });
      const fresh = await insertDocument();
      const freshChunk = await insertChunk(fresh);
      const freshRow = await db.query('SELECT attributes, attribute_header_stamp FROM document_chunks WHERE id = $1', [freshChunk]);
      assert.deepEqual(freshRow.rows[0], { attributes: null, attribute_header_stamp: null });
    });

    test('attributes must be an object and a stamp at most 64 characters; the chunk attributes have a GIN index', async () => {
      const documentId = await insertDocument();
      const chunkId = await insertChunk(documentId);
      for (const [table, id] of [['documents', documentId], ['document_chunks', chunkId]] as const) {
        for (const value of ['[]', '"text"', '7']) {
          assert.equal(await failure(db, `UPDATE ${table} SET attributes = $1::jsonb WHERE id = $2`, [value, id]), '23514', `${table} attributes ${value}`);
        }
        assert.equal(await failure(db, `UPDATE ${table} SET attribute_header_stamp = $1 WHERE id = $2`, ['s'.repeat(65), id]), '23514', `${table} stamp`);
        await db.query(`UPDATE ${table} SET attributes = '{"alpha_code": "A-1"}'::jsonb, attribute_header_stamp = $1 WHERE id = $2`, ['s'.repeat(64), id]);
      }
      const gin = await db.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'document_chunks_attributes_gin'");
      assert.equal(gin.rows.length, 1);
      assert.match(gin.rows[0]?.indexdef ?? '', /ON public\.document_chunks USING gin \(attributes\)$/);
      const noDocumentIndex = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'documents' AND indexdef ILIKE '%(attributes)%'",
      );
      assert.equal(noDocumentIndex.rows[0]?.n, 0);
    });

    test('a signed-in user cannot change the new columns through the tables; filename stays editable; service_role can', async () => {
      const documentId = await insertDocument();
      const chunkId = await insertChunk(documentId);
      const attempts: [string, string, string, unknown][] = [
        ['documents', documentId, 'attributes', '{"alpha_code": "B-2"}'],
        ['documents', documentId, 'attribute_header', 'header line'],
        ['documents', documentId, 'attribute_header_stamp', 'v1.abc'],
        ['document_chunks', chunkId, 'attributes', '{"alpha_code": "B-2"}'],
        ['document_chunks', chunkId, 'attribute_header_stamp', 'v1.abc'],
      ];
      for (const [table, id, column, value] of attempts) {
        const cast = column === 'attributes' ? '::jsonb' : '';
        const outcome = await asRole(db, 'authenticated', async () => {
          try {
            const result = await db.query(`UPDATE ${table} SET ${column} = $1${cast} WHERE id = $2`, [value, id]);
            return `rows:${result.affectedRows ?? 0}`;
          } catch (error) {
            return sqlState(error);
          }
        });
        assert.ok(outcome === '42501' || outcome === 'rows:0', `${table}.${column} authenticated: ${outcome}`);
        const stored = await db.query<{ v: unknown }>(`SELECT ${column} AS v FROM ${table} WHERE id = $1`, [id]);
        assert.equal(stored.rows[0]?.v, null, `${table}.${column} unchanged`);
      }
      const rename = await asRole(db, 'authenticated', () => db.query("UPDATE documents SET filename = 'renamed.md' WHERE id = $1", [documentId]));
      assert.equal(rename.affectedRows, 1, 'owner can still rename');
      await asRole(db, 'service_role', async () => {
        for (const [table, id, column, value] of attempts) {
          const cast = column === 'attributes' ? '::jsonb' : '';
          const result = await db.query(`UPDATE ${table} SET ${column} = $1${cast} WHERE id = $2`, [value, id]);
          assert.equal(result.affectedRows, 1, `service_role ${table}.${column}`);
        }
      });
      const triggers = await db.query<{ rel: string; def: string }>(
        "SELECT tgrelid::regclass::text AS rel, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'rag_guard_phase33_columns' ORDER BY 1",
      );
      assert.deepEqual(triggers.rows.map((row) => row.rel), ['document_chunks', 'documents']);
      const phase3 = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'rag_guard_ingest_state'");
      assert.equal(phase3.rows[0]?.n, 2, 'the Phase 3 guard triggers are kept');
    });

    test('1001 defines no function', async () => {
      const sql = await import('node:fs').then((fs) => fs.readFileSync(path.resolve(PHASE33_FILE), 'utf8'));
      assert.doesNotMatch(sql, /CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
      assert.doesNotMatch(sql, /CREATE\s+POLICY/i);
    });
  });

  describe(`Phase 3.3 migration 1001 precheck and idempotence (${mode})`, () => {
    test('applied after 0853 only, 1001 stops with 55000 and creates no table', async () => {
      const db = (await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false })).db;
      try {
        await applyMigrationFiles(db, filesBefore(mode, '0854'));
        let code = '';
        try {
          await applyMigrationFiles(db, [PHASE33_FILE]);
        } catch (error) {
          code = sqlState(error);
          assert.match(String((error as Error).message), /1001: apply 0854 first/);
        }
        assert.equal(code, '55000');
        await db.exec('ROLLBACK').catch(() => undefined);
        for (const table of NEW_TABLES) assert.equal(await tableExists(db, table), false, `${table} absent`);
        assert.ok(!('attributes' in (await columnTypes(db, 'document_chunks'))));
      } finally {
        await db.close();
      }
    });

    test('every migration applied twice leaves the schema dump unchanged', async () => {
      const db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      try {
        for (const table of NEW_TABLES) assert.ok(await tableExists(db, table), `${table} exists`);
        const first = await schemaDump(db);
        await applyMigrationFiles(db, migrationFiles(mode));
        assert.deepEqual(await schemaDump(db), first);
        await applyMigrationFiles(db, [PHASE33_FILE]);
        assert.deepEqual(await schemaDump(db), first);
      } finally {
        await db.close();
      }
    });
  });
}
