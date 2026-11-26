import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles, type MigrationMode } from '../../eval/harness/migrations.mts';

/**
 * Migration 1002 (TPL-01, TPL-02, TPL-08; D-02, D-12, D-16, D-18): list, upsert and delete of section rule sets and boilerplate rules
 * for an admin of the tenant, and the pipeline's read for a binding. Two organizations whose admins are not deployment admins, the
 * single-tenant block, grants and the function catalog. Names and patterns are invented and shape-only.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/1002_tenant_rule_functions.sql';

const ORG_A = '00000000-0000-4000-8000-0000000071c1';
const ORG_B = '00000000-0000-4000-8000-0000000071c2';
const A_ADMIN = '00000000-0000-4000-8000-0000000071f1';
const B_ADMIN = '00000000-0000-4000-8000-0000000071f2';
const A_MEMBER = '00000000-0000-4000-8000-0000000071f3';
const KEY_A = `o:${ORG_A}`;
const KEY_B = `o:${ORG_B}`;

const FUNCTIONS = [
  'rag_section_rule_sets_list(uuid, text)',
  'rag_section_rule_set_upsert(uuid, text, jsonb, uuid)',
  'rag_section_rule_set_delete(uuid, text, uuid)',
  'rag_boilerplate_rules_list(uuid, text)',
  'rag_boilerplate_rule_upsert(uuid, text, jsonb, uuid)',
  'rag_boilerplate_rule_delete(uuid, text, uuid)',
  'rag_tenant_rules_for(text, text, text)',
] as const;

type Row = Record<string, unknown>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  try {
    return (await db.query<Row>(sql, params)).rows;
  } catch (error) {
    return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
  }
}

interface Failure {
  message: string;
  code: string | null;
  detail: string | null;
}

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<Failure | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    const e = error as { code?: string; detail?: string };
    return { message: messageOf(error), code: e.code ?? null, detail: e.detail ?? null };
  }
}

const SET_UPSERT = 'SELECT * FROM rag_section_rule_set_upsert(p_actor => $1, p_tenant_key => $2, p_rule_set => $3::jsonb, p_id => $4::uuid)';
const SET_LIST = 'SELECT * FROM rag_section_rule_sets_list(p_actor => $1, p_tenant_key => $2)';
const SET_DELETE = 'SELECT * FROM rag_section_rule_set_delete(p_actor => $1, p_tenant_key => $2, p_id => $3::uuid)';
const BP_UPSERT = 'SELECT * FROM rag_boilerplate_rule_upsert(p_actor => $1, p_tenant_key => $2, p_rule => $3::jsonb, p_id => $4::uuid)';
const BP_LIST = 'SELECT * FROM rag_boilerplate_rules_list(p_actor => $1, p_tenant_key => $2)';
const BP_DELETE = 'SELECT * FROM rag_boilerplate_rule_delete(p_actor => $1, p_tenant_key => $2, p_id => $3::uuid)';
const RULES_FOR = 'SELECT * FROM rag_tenant_rules_for(p_tenant_key => $1, p_doc_type => $2, p_source => $3)';

let sequence = 0;
const next = (label: string): string => `${label} ${++sequence}`;

function heading(index = 0): Row {
  return { pattern: `^${index}\\d+\\. `, flags: 'u', name: `Part ${index}`, level: 1 };
}

function ruleSet(overrides: Row = {}): Row {
  return { name: next('Rule set'), headings: [heading()], ...overrides };
}

function lineRule(overrides: Row = {}): Row {
  return { name: next('Line rule'), kind: 'line', pattern: '^Zorvex page \\d+$', flags: 'u', ...overrides };
}

function fragmentRule(overrides: Row = {}): Row {
  return { name: next('Fragment rule'), kind: 'fragment', max_length: 40, min_page_share: 0.5, ...overrides };
}

async function saveSet(db: PGlite, actor: string, key: string, body: Row, id: string | null = null): Promise<Row> {
  return (await rows(db, SET_UPSERT, [actor, key, JSON.stringify(body), id]))[0] as Row;
}

async function saveRule(db: PGlite, actor: string, key: string, body: Row, id: string | null = null): Promise<Row> {
  return (await rows(db, BP_UPSERT, [actor, key, JSON.stringify(body), id]))[0] as Row;
}

async function count(db: PGlite, table: string, key?: string): Promise<number> {
  const found = key
    ? await rows(db, `SELECT count(*)::int AS n FROM public.${table} WHERE tenant_key = $1`, [key])
    : await rows(db, `SELECT count(*)::int AS n FROM public.${table}`);
  return Number(found[0]?.n);
}

async function multiTenantDatabase(): Promise<PGlite> {
  const { db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' });
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
    A_ADMIN,
    'a-admin@example.invalid',
    B_ADMIN,
    'b-admin@example.invalid',
    A_MEMBER,
    'a-member@example.invalid',
  ]);
  await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false), ($5, $6, $7, $8, false)', [
    ORG_A,
    'Tenant A',
    'tenant-a-71',
    A_ADMIN,
    ORG_B,
    'Tenant B',
    'tenant-b-71',
    B_ADMIN,
  ]);
  await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $4, 'owner'), ($1, $5, 'member')", [
    ORG_A,
    A_ADMIN,
    ORG_B,
    B_ADMIN,
    A_MEMBER,
  ]);
  return db;
}

describe('migration 1002 file', () => {
  test('defines the seven functions as invoker code with the tenant assertion first and touches no function of another phase', () => {
    const file = path.join(REPO_ROOT, MIGRATION);
    const sql = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    assert.ok(sql.length > 0, `${MIGRATION} is missing`);
    assert.equal((sql.match(/SECURITY DEFINER/g) ?? []).length, 0);
    assert.ok((sql.match(/rag_assert_tenant_key/g) ?? []).length >= 7);
    assert.ok(sql.includes('rag_upload_approval_keys'));
    assert.doesNotMatch(sql, /FUNCTION public\.(hybrid_search_chunks|rag_write_chunks|rag_write_profile_chunks|rag_set_document_fields)\(/);
    assert.doesNotMatch(sql, /pattern\s*(~|~\*|!~|SIMILAR TO|LIKE)/i);
    for (const signature of FUNCTIONS) {
      assert.ok(sql.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`), signature);
      assert.ok(sql.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`), signature);
    }
  });
});

describe('section rule sets (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = await multiTenantDatabase();
  });

  after(async () => {
    await db?.close();
  });

  test('off state: after all migrations both tables are empty', async () => {
    assert.equal(await count(db, 'rag_section_rule_sets'), 0);
    assert.equal(await count(db, 'rag_boilerplate_rules'), 0);
  });

  test('an admin creates, lists, replaces and deletes a rule set; the version rises on every replace', async () => {
    const body = ruleSet({ doc_type: 'general', headings: [heading(1), { ...heading(2), flags: 'iu', level: 2, required: true, restart: true }] });
    const created = await saveSet(db, A_ADMIN, KEY_A, body);
    assert.equal(created.version, 1);
    assert.equal(created.name, body.name);
    assert.equal(created.doc_type, 'general');
    assert.equal(created.source, null);
    assert.equal(created.enabled, true);
    const rules = created.rules as Row;
    assert.equal((rules.headings as Row[]).length, 2);
    assert.deepEqual((rules.headings as Row[])[1], { pattern: '^2\\d+\\. ', flags: 'iu', name: 'Part 2', level: 2, required: true, restart: true });
    assert.deepEqual((rules.headings as Row[])[0], { pattern: '^1\\d+\\. ', flags: 'u', name: 'Part 1', level: 1, required: false, restart: false });
    assert.equal(rules.skip_toc, true);
    assert.equal(rules.toc_min_run, 3);
    assert.equal(rules.require_increasing_numbers, false);
    assert.ok(created.updated_at);

    const second = await saveSet(db, A_ADMIN, KEY_A, ruleSet({ enabled: false }));
    assert.deepEqual((await rows(db, SET_LIST, [A_ADMIN, KEY_A])).map((row) => row.id), [created.id, second.id]);

    const replaced = await saveSet(db, A_ADMIN, KEY_A, { ...body, skip_toc: false, toc_min_run: 5 }, String(created.id));
    assert.equal(replaced.id, created.id);
    assert.equal(replaced.version, 2);
    assert.equal((replaced.rules as Row).skip_toc, false);
    assert.equal((await saveSet(db, A_ADMIN, KEY_A, body, String(created.id))).version, 3);

    const deleted = await rows(db, SET_DELETE, [A_ADMIN, KEY_A, created.id]);
    assert.equal(deleted.length, 1);
    assert.deepEqual((await rows(db, SET_LIST, [A_ADMIN, KEY_A])).map((row) => row.id), [second.id]);
    await rows(db, SET_DELETE, [A_ADMIN, KEY_A, second.id]);
  });

  test('a name is unique within a tenant, not across tenants', async () => {
    const name = next('Shared name');
    const first = await saveSet(db, A_ADMIN, KEY_A, ruleSet({ name, enabled: false }));
    assert.match((await failure(db, SET_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(ruleSet({ name, enabled: false })), null]))?.message ?? '', /^name_exists/);
    const other = await saveSet(db, B_ADMIN, KEY_B, ruleSet({ name, enabled: false }));
    assert.equal(other.name, name);
    const renamed = await saveSet(db, A_ADMIN, KEY_A, ruleSet({ name, enabled: false }), String(first.id));
    assert.equal(renamed.version, 2);
    await rows(db, SET_DELETE, [A_ADMIN, KEY_A, first.id]);
    await rows(db, SET_DELETE, [B_ADMIN, KEY_B, other.id]);
  });

  test('limits: 10 rule sets per tenant, 60 heading patterns, one enabled rule set per binding; the other tenant does not count', async () => {
    await saveSet(db, B_ADMIN, KEY_B, ruleSet({ enabled: false }));
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) ids.push(String((await saveSet(db, A_ADMIN, KEY_A, ruleSet({ enabled: false }))).id));
    const eleventh = await failure(db, SET_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(ruleSet({ enabled: false })), null]);
    assert.match(eleventh?.message ?? '', /^limit_reached/);
    assert.equal(eleventh?.detail, 'rule_sets');
    assert.equal(await count(db, 'rag_section_rule_sets', KEY_A), 10);
    for (const id of ids.slice(1)) await rows(db, SET_DELETE, [A_ADMIN, KEY_A, id]);

    const many = Array.from({ length: 61 }, (_, index) => heading(index));
    const tooMany = await failure(db, SET_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(ruleSet({ headings: many })), null]);
    assert.match(tooMany?.message ?? '', /^limit_reached/);
    assert.equal(tooMany?.detail, 'heading_patterns');
    assert.equal((await saveSet(db, A_ADMIN, KEY_A, ruleSet({ headings: many.slice(0, 60), enabled: false }))).version, 1);

    const bound = await saveSet(db, A_ADMIN, KEY_A, ruleSet({ doc_type: 'general', source: 'upload' }));
    const twice = await failure(db, SET_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(ruleSet({ doc_type: 'general', source: 'upload' })), null]);
    assert.match(twice?.message ?? '', /^limit_reached/);
    assert.equal(twice?.detail, 'binding');
    const disabled = await saveSet(db, A_ADMIN, KEY_A, ruleSet({ doc_type: 'general', source: 'upload', enabled: false }));
    const enable = await failure(db, SET_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(ruleSet({ doc_type: 'general', source: 'upload' })), disabled.id]);
    assert.equal(enable?.detail, 'binding');
    assert.equal((await saveSet(db, A_ADMIN, KEY_A, ruleSet({ doc_type: 'general', source: 'upload' }), String(bound.id))).version, 2);
    assert.equal((await saveSet(db, B_ADMIN, KEY_B, ruleSet({ doc_type: 'general', source: 'upload' }))).enabled, true);
    await db.query('DELETE FROM public.rag_section_rule_sets');
  });

  test('two inserts at the limit store exactly one row', async () => {
    for (let index = 0; index < 9; index += 1) await saveSet(db, A_ADMIN, KEY_A, ruleSet({ enabled: false }));
    const outcomes = await Promise.all([0, 1].map(() => failure(db, SET_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(ruleSet({ enabled: false })), null])));
    assert.equal(outcomes.filter((outcome) => outcome === null).length, 1);
    assert.match(outcomes.find((outcome) => outcome !== null)?.message ?? '', /^limit_reached/);
    assert.equal(await count(db, 'rag_section_rule_sets', KEY_A), 10);
    await db.query('DELETE FROM public.rag_section_rule_sets');
  });

  test('malformed arguments raise 22023 and write nothing', async () => {
    const cases: Row[] = [
      ruleSet({ name: '' }),
      ruleSet({ name: '   ' }),
      ruleSet({ name: 'n'.repeat(81) }),
      ruleSet({ headings: [] }),
      ruleSet({ headings: [{ ...heading(), pattern: '' }] }),
      ruleSet({ headings: [{ ...heading(), pattern: `^${'a'.repeat(200)}` }] }),
      ruleSet({ headings: [{ ...heading(), flags: 'g' }] }),
      ruleSet({ headings: [{ ...heading(), flags: 'giu' }] }),
      ruleSet({ headings: [{ ...heading(), level: 0 }] }),
      ruleSet({ headings: [{ ...heading(), level: 7 }] }),
      ruleSet({ headings: [{ ...heading(), name: '' }] }),
      ruleSet({ headings: [heading(), heading()] }),
      ruleSet({ headings: ['^1'] }),
      ruleSet({ doc_type: 'General' }),
      ruleSet({ source: 's'.repeat(65) }),
      ruleSet({ source: '1upload' }),
      ruleSet({ toc_min_run: 1 }),
      ruleSet({ skip_toc: 'yes' }),
      ruleSet({ enabled: 'true' }),
      ruleSet({ extra: 1 }),
    ];
    for (const body of cases) {
      const outcome = await failure(db, SET_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(body), null]);
      assert.equal(outcome?.code, '22023', JSON.stringify(body).slice(0, 120));
    }
    for (const payload of ['[]', '"text"', 'null']) {
      assert.equal((await failure(db, SET_UPSERT, [A_ADMIN, KEY_A, payload, null]))?.code, '22023', payload);
    }
    assert.equal((await failure(db, SET_DELETE, [A_ADMIN, KEY_A, null]))?.code, '22023');
    assert.equal(await count(db, 'rag_section_rule_sets'), 0);
  });

  test("an unknown id or the other tenant's id is not_found and changes nothing", async () => {
    const own = await saveSet(db, A_ADMIN, KEY_A, ruleSet({ enabled: false }));
    const foreign = await saveSet(db, B_ADMIN, KEY_B, ruleSet({ enabled: false }));
    const unknown = '00000000-0000-4000-8000-00000000ffff';
    for (const id of [unknown, String(foreign.id)]) {
      assert.match((await failure(db, SET_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(ruleSet()), id]))?.message ?? '', /^not_found/);
      assert.match((await failure(db, SET_DELETE, [A_ADMIN, KEY_A, id]))?.message ?? '', /^not_found/);
    }
    const kept = (await rows(db, SET_LIST, [B_ADMIN, KEY_B]))[0] as Row;
    assert.equal(kept.version, 1);
    assert.equal(kept.name, foreign.name);
    assert.match((await failure(db, SET_DELETE, [B_ADMIN, KEY_B, own.id]))?.message ?? '', /^not_found/);
    await db.query('DELETE FROM public.rag_section_rule_sets');
  });

  test("a member who is not an admin, and the other tenant's admin, are refused and see nothing", async () => {
    const own = await saveSet(db, A_ADMIN, KEY_A, ruleSet({ enabled: false }));
    for (const actor of [A_MEMBER, B_ADMIN]) {
      assert.deepEqual(await rows(db, SET_LIST, [actor, KEY_A]), []);
      assert.match((await failure(db, SET_UPSERT, [actor, KEY_A, JSON.stringify(ruleSet()), null]))?.message ?? '', /^not_admin/);
      assert.match((await failure(db, SET_UPSERT, [actor, KEY_A, JSON.stringify(ruleSet()), own.id]))?.message ?? '', /^not_admin/);
      assert.match((await failure(db, SET_DELETE, [actor, KEY_A, own.id]))?.message ?? '', /^not_admin/);
      assert.deepEqual(await rows(db, BP_LIST, [actor, KEY_A]), []);
      assert.match((await failure(db, BP_UPSERT, [actor, KEY_A, JSON.stringify(lineRule()), null]))?.message ?? '', /^not_admin/);
      assert.match((await failure(db, BP_DELETE, [actor, KEY_A, own.id]))?.message ?? '', /^not_admin/);
    }
    assert.equal(await count(db, 'rag_section_rule_sets'), 1);
    assert.equal(((await rows(db, SET_LIST, [A_ADMIN, KEY_A]))[0] as Row).version, 1);
    assert.equal(await count(db, 'rag_boilerplate_rules'), 0);
    await db.query('DELETE FROM public.rag_section_rule_sets');
  });
});

describe('boilerplate rules (multi-tenant)', () => {
  let db: PGlite;

  before(async () => {
    db = await multiTenantDatabase();
  });

  after(async () => {
    await db?.close();
  });

  test('line and fragment rules are created, listed in creation order, replaced with a new version and deleted', async () => {
    const line = await saveRule(db, A_ADMIN, KEY_A, lineRule({ flags: 'iu', source: 'upload' }));
    assert.equal(line.kind, 'line');
    assert.equal(line.flags, 'iu');
    assert.equal(line.source, 'upload');
    assert.equal(line.max_length, null);
    assert.equal(line.version, 1);
    const fragment = await saveRule(db, A_ADMIN, KEY_A, fragmentRule({ doc_type: 'general' }));
    assert.equal(fragment.pattern, null);
    assert.equal(fragment.flags, null);
    assert.equal(fragment.max_length, 40);
    assert.equal(Number(fragment.min_page_share), 0.5);
    assert.deepEqual((await rows(db, BP_LIST, [A_ADMIN, KEY_A])).map((row) => row.id), [line.id, fragment.id]);
    const replaced = await saveRule(db, A_ADMIN, KEY_A, fragmentRule({ name: line.name, min_page_share: 1 }), String(line.id));
    assert.equal(replaced.kind, 'fragment');
    assert.equal(replaced.pattern, null);
    assert.equal(replaced.version, 2);
    await rows(db, BP_DELETE, [A_ADMIN, KEY_A, line.id]);
    assert.deepEqual((await rows(db, BP_LIST, [A_ADMIN, KEY_A])).map((row) => row.id), [fragment.id]);
    assert.match((await failure(db, BP_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(lineRule({ name: fragment.name })), null]))?.message ?? '', /^name_exists/);
    assert.equal((await saveRule(db, B_ADMIN, KEY_B, lineRule({ name: fragment.name }))).name, fragment.name);
    await db.query('DELETE FROM public.rag_boilerplate_rules');
  });

  test('40 rules per tenant; the other tenant does not count; two inserts at the limit store one row', async () => {
    await saveRule(db, B_ADMIN, KEY_B, lineRule());
    for (let index = 0; index < 39; index += 1) await saveRule(db, A_ADMIN, KEY_A, index % 2 ? lineRule() : fragmentRule());
    const outcomes = await Promise.all([0, 1].map(() => failure(db, BP_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(lineRule()), null])));
    assert.equal(outcomes.filter((outcome) => outcome === null).length, 1);
    const refused = outcomes.find((outcome) => outcome !== null);
    assert.match(refused?.message ?? '', /^limit_reached/);
    assert.equal(refused?.detail, 'boilerplate_rules');
    assert.equal(await count(db, 'rag_boilerplate_rules', KEY_A), 40);
    await db.query('DELETE FROM public.rag_boilerplate_rules');
  });

  test('malformed rules raise 22023 and write nothing', async () => {
    const cases: Row[] = [
      lineRule({ name: '' }),
      lineRule({ name: 'n'.repeat(81) }),
      lineRule({ pattern: '' }),
      lineRule({ pattern: 'p'.repeat(201) }),
      lineRule({ pattern: undefined }),
      lineRule({ flags: 'g' }),
      lineRule({ flags: undefined }),
      lineRule({ max_length: 10 }),
      fragmentRule({ pattern: '^x$' }),
      fragmentRule({ flags: 'u' }),
      fragmentRule({ min_page_share: 0 }),
      fragmentRule({ min_page_share: 1.5 }),
      fragmentRule({ max_length: 0 }),
      fragmentRule({ max_length: 201 }),
      fragmentRule({ max_length: undefined }),
      lineRule({ kind: 'page' }),
      lineRule({ doc_type: 'Not-lower' }),
      lineRule({ extra: true }),
    ];
    for (const body of cases) {
      const outcome = await failure(db, BP_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(body), null]);
      assert.equal(outcome?.code, '22023', JSON.stringify(body).slice(0, 120));
    }
    assert.equal((await failure(db, BP_UPSERT, [A_ADMIN, KEY_A, '[1]', null]))?.code, '22023');
    assert.equal(await count(db, 'rag_boilerplate_rules'), 0);
  });

  test("an unknown id or the other tenant's id is not_found", async () => {
    const foreign = await saveRule(db, B_ADMIN, KEY_B, lineRule());
    assert.match((await failure(db, BP_UPSERT, [A_ADMIN, KEY_A, JSON.stringify(lineRule()), foreign.id]))?.message ?? '', /^not_found/);
    assert.match((await failure(db, BP_DELETE, [A_ADMIN, KEY_A, foreign.id]))?.message ?? '', /^not_found/);
    assert.equal(((await rows(db, BP_LIST, [B_ADMIN, KEY_B]))[0] as Row).version, 1);
    await db.query('DELETE FROM public.rag_boilerplate_rules');
  });
});

describe('rag_tenant_rules_for (multi-tenant)', () => {
  let db: PGlite;
  const sets: Record<string, string> = {};
  const rules: Record<string, string> = {};

  before(async () => {
    db = await multiTenantDatabase();
    sets.both = String((await saveSet(db, A_ADMIN, KEY_A, ruleSet({ doc_type: 'general', source: 'upload' }))).id);
    sets.type = String((await saveSet(db, A_ADMIN, KEY_A, ruleSet({ doc_type: 'general' }))).id);
    sets.source = String((await saveSet(db, A_ADMIN, KEY_A, ruleSet({ source: 'upload' }))).id);
    sets.tenant = String((await saveSet(db, A_ADMIN, KEY_A, ruleSet())).id);
    rules.tenant = String((await saveRule(db, A_ADMIN, KEY_A, lineRule())).id);
    rules.source = String((await saveRule(db, A_ADMIN, KEY_A, fragmentRule({ source: 'upload' }))).id);
    rules.type = String((await saveRule(db, A_ADMIN, KEY_A, lineRule({ doc_type: 'general' }))).id);
    rules.both = String((await saveRule(db, A_ADMIN, KEY_A, lineRule({ doc_type: 'general', source: 'upload' }))).id);
    rules.tenant2 = String((await saveRule(db, A_ADMIN, KEY_A, fragmentRule())).id);
    rules.disabled = String((await saveRule(db, A_ADMIN, KEY_A, lineRule({ enabled: false }))).id);
    rules.otherType = String((await saveRule(db, A_ADMIN, KEY_A, lineRule({ doc_type: 'invoice' }))).id);
    await saveSet(db, B_ADMIN, KEY_B, ruleSet());
    await saveSet(db, B_ADMIN, KEY_B, ruleSet({ doc_type: 'general', source: 'upload' }));
    await saveRule(db, B_ADMIN, KEY_B, lineRule());
  });

  after(async () => {
    await db?.close();
  });

  const read = async (key: string, docType: string | null, source: string | null) => {
    const found = await rows(db, RULES_FOR, [key, docType, source]);
    return {
      ruleSets: found.filter((row) => row.entry === 'rule_set'),
      rules: found.filter((row) => row.entry === 'boilerplate_rule').map((row) => String(row.id)),
      all: found,
    };
  };

  test('the rule set follows the D-18 precedence: type and source, then type, then source, then the tenant-wide row', async () => {
    assert.deepEqual((await read(KEY_A, 'general', 'upload')).ruleSets.map((row) => row.id), [sets.both]);
    assert.deepEqual((await read(KEY_A, 'general', 'nango')).ruleSets.map((row) => row.id), [sets.type]);
    assert.deepEqual((await read(KEY_A, 'invoice', 'upload')).ruleSets.map((row) => row.id), [sets.source]);
    assert.deepEqual((await read(KEY_A, 'invoice', 'nango')).ruleSets.map((row) => row.id), [sets.tenant]);
    const chosen = (await read(KEY_A, 'general', 'upload')).ruleSets[0] as Row;
    assert.equal(chosen.version, 1);
    assert.equal(((chosen.rules as Row).headings as Row[]).length, 1);
  });

  test('every enabled matching boilerplate rule, ordered by precedence then creation; disabled and foreign rows never appear', async () => {
    assert.deepEqual((await read(KEY_A, 'general', 'upload')).rules, [rules.both, rules.type, rules.source, rules.tenant, rules.tenant2]);
    assert.deepEqual((await read(KEY_A, 'general', 'nango')).rules, [rules.type, rules.tenant, rules.tenant2]);
    assert.deepEqual((await read(KEY_A, 'report', null)).rules, [rules.tenant, rules.tenant2]);
    const foreign = new Set((await read(KEY_B, 'general', 'upload')).all.map((row) => String(row.id)));
    for (const id of [...Object.values(sets), ...Object.values(rules)]) assert.ok(!foreign.has(id), `tenant B read ${id}`);
    assert.equal((await read(KEY_B, 'general', 'upload')).rules.length, 1);
  });

  test('a disabled rule set is skipped and the next level answers; with no row the rule set part is empty', async () => {
    const stored: Row = { ...(await rows(db, SET_LIST, [A_ADMIN, KEY_A])).map(toBody).find((body) => body.id === sets.both)! };
    delete stored.id;
    assert.equal((await saveSet(db, A_ADMIN, KEY_A, { ...stored, enabled: false }, sets.both)).version, 2);
    assert.deepEqual((await read(KEY_A, 'general', 'upload')).ruleSets.map((row) => row.id), [sets.type]);
    await rows(db, SET_DELETE, [A_ADMIN, KEY_A, sets.type]);
    await rows(db, SET_DELETE, [A_ADMIN, KEY_A, sets.source]);
    await rows(db, SET_DELETE, [A_ADMIN, KEY_A, sets.tenant]);
    assert.deepEqual((await read(KEY_A, 'general', 'upload')).ruleSets, []);
  });

  test('malformed binding values raise 22023', async () => {
    assert.equal((await failure(db, RULES_FOR, [KEY_A, 'General', null]))?.code, '22023');
    assert.equal((await failure(db, RULES_FOR, [KEY_A, null, 'x'.repeat(65)]))?.code, '22023');
  });
});

function toBody(row: Row): Row & { id: string } {
  const rules = row.rules as Row;
  return {
    id: String(row.id),
    name: row.name,
    ...(row.doc_type ? { doc_type: row.doc_type } : {}),
    ...(row.source ? { source: row.source } : {}),
    enabled: row.enabled,
    headings: rules.headings,
    require_increasing_numbers: rules.require_increasing_numbers,
    skip_toc: rules.skip_toc,
    toc_min_run: rules.toc_min_run,
  } as Row & { id: string };
}

async function asRole<T>(db: PGlite, role: 'anon' | 'authenticated', run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [A_ADMIN]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

for (const mode of ['multi-tenant', 'single-tenant'] as const satisfies readonly MigrationMode[]) {
  describe(`grants, catalog and tenant keys (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db?.close();
    });

    test('anon and an authenticated JWT cannot execute any of the seven functions; service_role can', async () => {
      const privileges = await rows(
        db,
        `SELECT p.oid::regprocedure::text AS signature,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                p.prosecdef AS definer,
                p.proconfig AS config
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
        [FUNCTIONS.map((signature) => signature.slice(0, signature.indexOf('(')))],
      );
      assert.deepEqual(privileges.map((row) => String(row.signature).replace(/\s/g, '')).sort(), FUNCTIONS.map((s) => s.replace(/\s/g, '')).sort());
      for (const row of privileges) {
        assert.equal(row.anon, false, `${row.signature} anon`);
        assert.equal(row.authenticated, false, `${row.signature} authenticated`);
        assert.equal(row.service_role, true, `${row.signature} service_role`);
        assert.equal(row.definer, false, `${row.signature} definer`);
        assert.ok(Array.isArray(row.config) && (row.config as string[]).some((entry) => /^search_path=(""|)$/.test(entry)), `${row.signature} search_path`);
      }
      for (const role of ['anon', 'authenticated'] as const) {
        const outcome = await asRole(db, role, () => failure(db, RULES_FOR, [mode === 'single-tenant' ? 's:default' : KEY_A, null, null]));
        assert.equal(outcome?.code, '42501', `${role}: ${outcome?.message}`);
      }
    });

    test('a tenant key of the other deployment mode is refused by the tenant assertion', async () => {
      const foreignKeys = mode === 'single-tenant' ? [`u:${A_ADMIN}`, KEY_A] : ['s:default'];
      for (const key of foreignKeys) {
        assert.ok(await failure(db, RULES_FOR, [key, null, null]), key);
        assert.ok(await failure(db, SET_LIST, [A_ADMIN, key]), key);
        assert.ok(await failure(db, BP_UPSERT, [A_ADMIN, key, JSON.stringify(lineRule()), null]), key);
      }
      assert.equal(await count(db, 'rag_boilerplate_rules'), 0);
    });

    test('applying the migrations a second time leaves the functions unchanged', async () => {
      const definitions = async () =>
        (
          await rows(
            db,
            `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`,
            [FUNCTIONS.map((signature) => signature.slice(0, signature.indexOf('(')))],
          )
        ).map((row) => String(row.def));
      const before = await definitions();
      await applyMigrationFiles(db, migrationFiles(mode));
      assert.deepEqual(await definitions(), before);
    });
  });
}

describe('single-tenant administration', () => {
  let db: PGlite;
  const ADMIN = '00000000-0000-4000-8000-0000000071a1';
  const USER = '00000000-0000-4000-8000-0000000071a2';

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [ADMIN, 'admin@example.invalid', USER, 'user@example.invalid']);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  });

  after(async () => {
    await db?.close();
  });

  test('a deployment admin manages the s:default rules; another user cannot; the pipeline read answers', async () => {
    const set = await saveSet(db, ADMIN, 's:default', ruleSet());
    const rule = await saveRule(db, ADMIN, 's:default', lineRule());
    assert.match((await failure(db, SET_UPSERT, [USER, 's:default', JSON.stringify(ruleSet()), null]))?.message ?? '', /^not_admin/);
    assert.deepEqual(await rows(db, SET_LIST, [USER, 's:default']), []);
    assert.deepEqual(await rows(db, BP_LIST, [USER, 's:default']), []);
    const found = await rows(db, RULES_FOR, ['s:default', 'general', 'upload']);
    assert.deepEqual(found.map((row) => `${row.entry}:${row.id}`), [`rule_set:${set.id}`, `boilerplate_rule:${rule.id}`]);
  });
});
