import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

/**
 * DATA-18 (D-38): a per-tenant scope vocabulary and the transactional tag setter. Two organizations: O's admin (not a deployment admin)
 * defines values and tags O's documents; P's owner can neither read nor use O's vocabulary nor tag O's documents.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0805_scope_tags.sql';

const ORG_O = TWO_TENANT_IDS.orgO;
const ORG_P = '00000000-0000-4000-8000-0000000041c2';
const O_ADMIN = '00000000-0000-4000-8000-0000000041f1';
const P_OWNER = '00000000-0000-4000-8000-0000000041f2';
const O_MEMBER = TWO_TENANT_IDS.userA;
const KEY_O = `o:${ORG_O}`;
const KEY_P = `o:${ORG_P}`;
const LEGACY_PROFILE = 'openai-3-small-1536';
const HALFVEC_PROFILE = 'voyage-4-large-1024';

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

async function failure(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

let sequence = 0;
const next = (label: string): string => `${label}${++sequence}`;

interface Workspace {
  key: string;
  userId: string;
  orgId: string | null;
}

const WORKSPACE_O: Workspace = { key: KEY_O, userId: O_MEMBER, orgId: ORG_O };
const WORKSPACE_P: Workspace = { key: KEY_P, userId: P_OWNER, orgId: ORG_P };

/** A published document of the workspace with two chunks. */
async function publishedDocument(db: PGlite, workspace: Workspace, label: string, filename?: string): Promise<string> {
  const name = next(label);
  const begun = (
    await rows(
      db,
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [workspace.key, workspace.userId, workspace.orgId, `scopes/${name}.md`, filename ?? `${name}.md`, crypto.createHash('sha256').update(name).digest('hex')],
    )
  )[0];
  const id = String(begun?.document_id);
  const contents = [`${next('tok')} neutral probe sentence one`, `${next('tok')} neutral probe sentence two`];
  const chunks = contents.map((content, index) => ({ chunk_index: index, content, lexical_text: content, metadata: {} }));
  const embeddings = {
    [LEGACY_PROFILE]: contents.map((content) => embedText(content)),
    [HALFVEC_PROFILE]: contents.map((content) => embedText(content).slice(0, 1024)),
  };
  await rows(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 2)',
    [id, workspace.key, JSON.stringify(chunks), JSON.stringify(embeddings)],
  );
  await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, workspace.key]);
  return id;
}

async function documentScopes(db: PGlite, id: string): Promise<{ document: string[]; chunks: string[][] }> {
  const document = (await rows(db, 'SELECT scopes FROM documents WHERE id = $1', [id]))[0]?.scopes as string[];
  const chunks = (await rows(db, 'SELECT scopes FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [id])).map((row) => row.scopes as string[]);
  return { document, chunks };
}

async function seedCache(db: PGlite, tenantKey: string, documentId: string): Promise<void> {
  await rows(
    db,
    `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
     VALUES ($1, $2, 'p1', '[1,0,0,0]'::halfvec, 'masked placeholder', '{}'::jsonb, $3::jsonb, false, now() + interval '1 hour')`,
    [tenantKey, next('key'), JSON.stringify([{ document_id: documentId, version: 1 }])],
  );
}

async function cacheRowsFor(db: PGlite, tenantKey: string, documentId: string): Promise<number> {
  const found = await rows(
    db,
    `SELECT count(*)::int AS n FROM public.rag_semantic_cache c
     WHERE c.tenant_key = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.source_versions) e(v) WHERE e.v ->> 'document_id' = $2)`,
    [tenantKey, documentId],
  );
  return Number(found[0]?.n);
}

const CREATE_SQL =
  'SELECT * FROM rag_scope_vocabulary_create(p_actor => $1, p_tenant_key => $2, p_dimension => $3, p_value => $4, p_label => $5, p_aliases => $6::text[])';
const UPDATE_SQL =
  'SELECT * FROM rag_scope_vocabulary_update(p_actor => $1, p_tenant_key => $2, p_id => $3, p_label => $4, p_aliases => $5::text[], p_active => $6, p_dimension => $7, p_value => $8)';
const LIST_SQL = 'SELECT * FROM rag_scope_vocabulary_list(p_actor => $1, p_tenant_key => $2)';
const FOR_SQL = 'SELECT * FROM rag_scope_vocabulary_for(p_tenant_key => $1)';
const SET_SQL = 'SELECT * FROM rag_set_document_scopes(p_document_id => $1, p_tenant_key => $2, p_scopes => $3::text[], p_actor => $4)';
const DOCS_SQL =
  'SELECT * FROM rag_list_documents_with_scopes(p_actor => $1, p_tenant_key => $2, p_scopes => $3::text[], p_query => $4, p_limit => $5, p_offset => $6, p_filter => $7)';

async function create(db: PGlite, actor: string, key: string, dimension: string, value: string, label: string, aliases: string[] = []): Promise<Row> {
  return (await rows(db, CREATE_SQL, [actor, key, dimension, value, label, aliases]))[0] as Row;
}

describe('scope tags across two tenants (multi-tenant)', () => {
  let db: PGlite;
  let docO: string;
  let docO2: string;
  let docP: string;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [O_ADMIN, 'o-admin@example.invalid', P_OWNER, 'p-owner@example.invalid']);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [ORG_P, 'Tenant P', 'tenant-p-41', P_OWNER]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $4, 'owner')", [ORG_O, O_ADMIN, ORG_P, P_OWNER]);
    docO = await publishedDocument(db, WORKSPACE_O, 'org-o');
    docO2 = await publishedDocument(db, WORKSPACE_O, 'org-o-second');
    docP = await publishedDocument(db, WORKSPACE_P, 'org-p');
  });

  after(async () => {
    await db?.close();
  });

  test("an organization admin creates a value and tags a document: the document and every chunk carry the tag, the fingerprint is unchanged and the tenant's cached answers naming the document are gone", async () => {
    const entry = await create(db, O_ADMIN, KEY_O, 'region', 'a1', 'Area one', ['First area']);
    assert.equal(entry.dimension, 'region');
    assert.equal(entry.value, 'a1');
    assert.equal(entry.active, true);

    const fingerprintBefore = (await rows(db, 'SELECT ingest_fingerprint FROM documents WHERE id = $1', [docO]))[0]?.ingest_fingerprint;
    await seedCache(db, KEY_O, docO);
    await seedCache(db, KEY_O, docO2);
    await seedCache(db, KEY_P, docP);

    const set = (await rows(db, SET_SQL, [docO, KEY_O, ['region:a1'], O_ADMIN]))[0] as Row;
    assert.deepEqual(set.scopes, ['region:a1']);
    assert.equal(set.chunks_updated, 2);
    const stored = await documentScopes(db, docO);
    assert.deepEqual(stored.document, ['region:a1']);
    assert.deepEqual(stored.chunks, [['region:a1'], ['region:a1']]);

    assert.equal((await rows(db, 'SELECT ingest_fingerprint FROM documents WHERE id = $1', [docO]))[0]?.ingest_fingerprint, fingerprintBefore);
    assert.equal(await cacheRowsFor(db, KEY_O, docO), 0);
    assert.equal(await cacheRowsFor(db, KEY_O, docO2), 1);
    assert.equal(await cacheRowsFor(db, KEY_P, docP), 1);
  });

  test('a failure after the document update leaves the document and its chunks unchanged', async () => {
    await create(db, O_ADMIN, KEY_O, 'department', 'd1', 'Unit one');
    const before = await documentScopes(db, docO);
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.test_fail_chunk_scopes() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('test.fail_chunk_scopes', true) = 'on' THEN RAISE EXCEPTION 'injected chunk failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_chunk_scopes BEFORE UPDATE OF scopes ON public.document_chunks FOR EACH ROW EXECUTE FUNCTION public.test_fail_chunk_scopes();
    `);
    try {
      await db.exec("SET test.fail_chunk_scopes = 'on'");
      assert.match((await failure(db, SET_SQL, [docO, KEY_O, ['region:a1', 'department:d1'], O_ADMIN])) ?? '', /injected chunk failure/);
      assert.deepEqual(await documentScopes(db, docO), before);
    } finally {
      await db.exec("SET test.fail_chunk_scopes = 'off'; DROP TRIGGER test_fail_chunk_scopes ON public.document_chunks; DROP FUNCTION public.test_fail_chunk_scopes();");
    }
  });

  test('a value that is not in the vocabulary raises unknown_scope_value and stores nothing', async () => {
    const before = await documentScopes(db, docO);
    assert.match((await failure(db, SET_SQL, [docO, KEY_O, ['region:zz9'], O_ADMIN])) ?? '', /^unknown_scope_value/);
    assert.match((await failure(db, SET_SQL, [docO, KEY_O, ['region:a1', 'nowhere:a1'], O_ADMIN])) ?? '', /^unknown_scope_value/);
    assert.deepEqual(await documentScopes(db, docO), before);
  });

  test("tenant P cannot read or use O's vocabulary, nor tag O's documents", async () => {
    assert.deepEqual(await rows(db, LIST_SQL, [P_OWNER, KEY_O]), []);
    assert.ok((await rows(db, LIST_SQL, [O_ADMIN, KEY_O])).some((row) => row.value === 'a1'));
    assert.ok(!(await rows(db, FOR_SQL, [KEY_P])).some((row) => row.value === 'a1'));
    assert.match((await failure(db, SET_SQL, [docP, KEY_P, ['region:a1'], P_OWNER])) ?? '', /^unknown_scope_value/);
    assert.match((await failure(db, SET_SQL, [docO, KEY_P, ['region:a1'], P_OWNER])) ?? '', /^not_found/);
    assert.match((await failure(db, SET_SQL, [docO, KEY_O, ['region:a1'], P_OWNER])) ?? '', /^not_found/);
    assert.match((await failure(db, CREATE_SQL, [P_OWNER, KEY_O, 'region', 'p1', 'Area P', []])) ?? '', /^not_admin/);
    const entry = (await rows(db, LIST_SQL, [O_ADMIN, KEY_O])).find((row) => row.value === 'a1') as Row;
    assert.match((await failure(db, UPDATE_SQL, [P_OWNER, KEY_P, entry.id, 'Renamed', null, null, null, null])) ?? '', /^not_found/);
    assert.match((await failure(db, UPDATE_SQL, [P_OWNER, KEY_O, entry.id, 'Renamed', null, null, null, null])) ?? '', /^not_admin/);
  });

  test('a member of the organization who did not upload the document cannot tag it', async () => {
    const other = '00000000-0000-4000-8000-0000000041f3';
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [other, 'o-member@example.invalid']);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG_O, other]);
    assert.match((await failure(db, SET_SQL, [docO, KEY_O, ['region:a1'], other])) ?? '', /^not_found/);
    assert.match((await failure(db, CREATE_SQL, [other, KEY_O, 'region', 'm1', 'Area M', []])) ?? '', /^not_admin/);
  });

  test('every new function runs with an empty search_path, is not executable by PUBLIC, anon or authenticated, and is executable by service_role', async () => {
    const found = await rows(
      db,
      `SELECT p.oid::regprocedure::text AS sig, p.proconfig AS config,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service,
              COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), true) AS public_exec
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND (p.proname LIKE 'rag_scope%' OR p.proname IN ('rag_set_document_scopes', 'rag_list_documents_with_scopes', 'rag_purge_hook_scope_tags'))`,
    );
    const names = found.map((row) => String(row.sig).replace(/\(.*$/, '')).sort();
    for (const expected of [
      'rag_list_documents_with_scopes',
      'rag_purge_hook_scope_tags',
      'rag_scope_vocabulary_create',
      'rag_scope_vocabulary_for',
      'rag_scope_vocabulary_list',
      'rag_scope_vocabulary_update',
      'rag_set_document_scopes',
    ]) {
      assert.ok(names.includes(expected), `${expected} missing`);
    }
    for (const row of found) {
      assert.deepEqual(row.config, ['search_path=""'], String(row.sig));
      assert.equal(row.anon, false, String(row.sig));
      assert.equal(row.authed, false, String(row.sig));
      assert.equal(row.public_exec, false, String(row.sig));
      assert.equal(row.service, true, String(row.sig));
    }
    const table = (
      await rows(
        db,
        `SELECT c.relrowsecurity AS rls,
                (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
                has_table_privilege('anon', c.oid, 'SELECT') AS anon,
                has_table_privilege('authenticated', c.oid, 'SELECT') AS authed,
                has_table_privilege('service_role', c.oid, 'INSERT') AS service_insert
         FROM pg_class c WHERE c.oid = 'public.rag_scope_vocabulary'::regclass`,
      )
    )[0] as Row;
    assert.deepEqual(table, { rls: true, policies: 0, anon: false, authed: false, service_insert: false });
  });

  test('a second apply of the migration raises nothing and keeps the vocabulary', async () => {
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
    assert.ok((await rows(db, LIST_SQL, [O_ADMIN, KEY_O])).some((row) => row.value === 'a1'));
  });
});

describe('scope vocabulary rules and canonical tag lists (multi-tenant)', () => {
  let db: PGlite;
  let doc: string;

  const messageFor = async (params: unknown[]) => (await failure(db, CREATE_SQL, params)) ?? '';
  const entryId = async (dimension: string, value: string) =>
    String((await rows(db, LIST_SQL, [O_ADMIN, KEY_O])).find((row) => row.dimension === dimension && row.value === value)?.id);

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [O_ADMIN, 'o-admin@example.invalid']);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [ORG_O, O_ADMIN]);
    doc = await publishedDocument(db, WORKSPACE_O, 'rules');
    await create(db, O_ADMIN, KEY_O, 'region', 'b-2', 'Area two', ['Second area']);
    await create(db, O_ADMIN, KEY_O, 'region', 'c3', 'Area three');
    await create(db, O_ADMIN, KEY_O, 'department', 'd1', 'Unit one');
  });

  after(async () => {
    await db?.close();
  });

  test('a value equal after slug normalization (case, spaces, repeated hyphens) is refused with tag_exists', async () => {
    for (const value of ['B-2', ' b 2 ', 'b--2', 'B__2', '-b-2-']) {
      assert.match(await messageFor([O_ADMIN, KEY_O, 'region', value, `Other ${next('label')}`, []]), /^tag_exists/, value);
    }
    const normalized = await create(db, O_ADMIN, KEY_O, 'region', '  New  Value ', 'Area new');
    assert.equal(normalized.value, 'new-value');
    assert.match(await messageFor([O_ADMIN, KEY_O, 'region', '中文', 'Area x', []]), /^invalid_value/);
  });

  test("a label or alias equal to another active entry's label in the dimension is refused with tag_exists", async () => {
    assert.match(await messageFor([O_ADMIN, KEY_O, 'region', 'x1', 'area TWO', []]), /^tag_exists/);
    assert.match(await messageFor([O_ADMIN, KEY_O, 'region', 'x2', 'Area x2', ['  Area   two ']]), /^tag_exists/);
    assert.match(await messageFor([O_ADMIN, KEY_O, 'region', 'x3', 'second area', []]), /^tag_exists/);
  });

  test('the same value in two dimensions is two distinct tags', async () => {
    const other = await create(db, O_ADMIN, KEY_O, 'legal_entity', 'b-2', 'Area two');
    assert.equal(other.dimension, 'legal_entity');
    assert.equal(other.value, 'b-2');
  });

  test('an update changes label, aliases and active, and refuses a changed value or dimension with value_immutable', async () => {
    const id = await entryId('region', 'c3');
    const updated = (await rows(db, UPDATE_SQL, [O_ADMIN, KEY_O, id, 'Area three renamed', ['Third'], null, 'region', 'c3']))[0] as Row;
    assert.equal(updated.label, 'Area three renamed');
    assert.deepEqual(updated.aliases, ['Third']);
    assert.equal(updated.value, 'c3');
    assert.match((await failure(db, UPDATE_SQL, [O_ADMIN, KEY_O, id, null, null, null, null, 'c4'])) ?? '', /^value_immutable/);
    assert.match((await failure(db, UPDATE_SQL, [O_ADMIN, KEY_O, id, null, null, null, 'department', null])) ?? '', /^value_immutable/);
    assert.match((await failure(db, UPDATE_SQL, [O_ADMIN, KEY_O, id, 'Area two', null, null, null, null])) ?? '', /^tag_exists/);
  });

  test('tag lists are stored sorted and de-duplicated whatever the input order', async () => {
    const first = (await rows(db, SET_SQL, [doc, KEY_O, ['region:c3', 'department:d1', 'region:b-2', 'region:c3'], O_ADMIN]))[0] as Row;
    const firstStored = await documentScopes(db, doc);
    const second = (await rows(db, SET_SQL, [doc, KEY_O, ['department:d1', 'region:b-2', 'region:c3'], O_ADMIN]))[0] as Row;
    assert.deepEqual(first.scopes, ['department:d1', 'region:b-2', 'region:c3']);
    assert.deepEqual(second.scopes, first.scopes);
    assert.deepEqual(await documentScopes(db, doc), firstStored);
    assert.deepEqual(firstStored.chunks, [first.scopes, first.scopes]);
  });

  test('a retired value stays on tagged documents, is refused for new tagging, and can be restored', async () => {
    const id = await entryId('region', 'c3');
    const retired = (await rows(db, UPDATE_SQL, [O_ADMIN, KEY_O, id, null, null, false, null, null]))[0] as Row;
    assert.equal(retired.active, false);
    assert.ok((await documentScopes(db, doc)).document.includes('region:c3'));

    const kept = (await rows(db, SET_SQL, [doc, KEY_O, ['region:c3', 'region:b-2'], O_ADMIN]))[0] as Row;
    assert.deepEqual(kept.scopes, ['region:b-2', 'region:c3']);
    const other = await publishedDocument(db, WORKSPACE_O, 'rules-other');
    assert.match((await failure(db, SET_SQL, [other, KEY_O, ['region:c3'], O_ADMIN])) ?? '', /^unknown_scope_value/);

    assert.equal(((await rows(db, UPDATE_SQL, [O_ADMIN, KEY_O, id, null, null, true, null, null]))[0] as Row).active, true);
    assert.deepEqual(((await rows(db, SET_SQL, [other, KEY_O, ['region:c3'], O_ADMIN]))[0] as Row).scopes, ['region:c3']);
  });

  test("restoring a value whose label now equals another active entry's label is refused with tag_exists", async () => {
    const id = await entryId('department', 'd1');
    await rows(db, UPDATE_SQL, [O_ADMIN, KEY_O, id, null, null, false, null, null]);
    await create(db, O_ADMIN, KEY_O, 'department', 'd9', 'Unit one');
    assert.match((await failure(db, UPDATE_SQL, [O_ADMIN, KEY_O, id, null, null, true, null, null])) ?? '', /^tag_exists/);
  });

  test('an empty list clears the tags of the document and its chunks', async () => {
    const cleared = (await rows(db, SET_SQL, [doc, KEY_O, [], O_ADMIN]))[0] as Row;
    assert.deepEqual(cleared.scopes, []);
    assert.deepEqual(await documentScopes(db, doc), { document: [], chunks: [[], []] });
  });

  test('more than 20 tags on one document is refused with too_many_scopes', async () => {
    for (let index = 0; index < 21; index += 1) await create(db, O_ADMIN, KEY_O, 'department', `many-${index}`, `Many ${index}`);
    const tags = Array.from({ length: 21 }, (_, index) => `department:many-${index}`);
    assert.match((await failure(db, SET_SQL, [doc, KEY_O, tags, O_ADMIN])) ?? '', /^too_many_scopes/);
    assert.equal(((await rows(db, SET_SQL, [doc, KEY_O, tags.slice(0, 20), O_ADMIN]))[0] as Row).chunks_updated, 2);
  });

  test('the vocabulary list is ordered by dimension (region, legal entity, department), then label', async () => {
    const listed = await rows(db, LIST_SQL, [O_ADMIN, KEY_O]);
    const order = ['region', 'legal_entity', 'department'];
    const keys = listed.map((row) => [order.indexOf(String(row.dimension)), String(row.label).toLowerCase()] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    assert.deepEqual(keys, sorted);
    assert.equal(listed[0]?.dimension, 'region');
    assert.equal(listed.at(-1)?.dimension, 'department');
  });
});

describe('document list with tags (multi-tenant)', () => {
  let db: PGlite;
  let tagged: string;
  let both: string;
  let untagged: string;
  let suggested: string;
  let percent: string;
  let foreign: string;

  const list = async (actor: string, key: string, options: { scopes?: string[] | null; query?: string | null; limit?: number; offset?: number; filter?: string } = {}) =>
    rows(db, DOCS_SQL, [actor, key, options.scopes ?? null, options.query ?? null, options.limit ?? 50, options.offset ?? 0, options.filter ?? 'all']);
  const ids = (found: Row[]) => found.map((row) => String(row.id)).sort();

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [O_ADMIN, 'o-admin@example.invalid', P_OWNER, 'p-owner@example.invalid']);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [ORG_P, 'Tenant P', 'tenant-p-41l', P_OWNER]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $4, 'owner')", [ORG_O, O_ADMIN, ORG_P, P_OWNER]);
    await create(db, O_ADMIN, KEY_O, 'region', 'a1', 'Area one');
    await create(db, O_ADMIN, KEY_O, 'region', 'a2', 'Area two');
    await create(db, O_ADMIN, KEY_O, 'department', 'd1', 'Unit one');
    await create(db, P_OWNER, KEY_P, 'region', 'a1', 'Area one');
    tagged = await publishedDocument(db, WORKSPACE_O, 'list-tagged', 'alpha-notes.md');
    both = await publishedDocument(db, WORKSPACE_O, 'list-both', 'beta-notes.md');
    untagged = await publishedDocument(db, WORKSPACE_O, 'list-untagged', 'gamma-notes.md');
    suggested = await publishedDocument(db, WORKSPACE_O, 'list-suggested', 'delta-notes.md');
    percent = await publishedDocument(db, WORKSPACE_O, 'list-percent', 'report_50%.md');
    foreign = await publishedDocument(db, WORKSPACE_P, 'list-foreign', 'alpha-notes.md');
    await rows(db, SET_SQL, [tagged, KEY_O, ['region:a1'], O_ADMIN]);
    await rows(db, SET_SQL, [both, KEY_O, ['region:a2', 'department:d1'], O_ADMIN]);
    await rows(db, SET_SQL, [suggested, KEY_O, ['region:a1'], O_ADMIN]);
    await rows(db, SET_SQL, [foreign, KEY_P, ['region:a1'], P_OWNER]);
    await rows(db, `UPDATE documents SET metadata = metadata || $2::jsonb WHERE id = $1`, [
      suggested,
      JSON.stringify({ scope_suggestions: { suggestions: [{ dimension: 'department', value: 'd1', source: 'rule' }] } }),
    ]);
  });

  after(async () => {
    await db?.close();
  });

  test("lists the workspace's current documents with tags, suggestions and totals, never another tenant's and never any document text", async () => {
    const found = await list(O_ADMIN, KEY_O);
    assert.ok(!ids(found).includes(foreign));
    assert.ok([tagged, both, untagged, suggested, percent].every((id) => ids(found).includes(id)));
    const row = found.find((item) => item.id === both) as Row;
    assert.deepEqual(row.scopes, ['department:d1', 'region:a2']);
    assert.equal(row.filename, 'beta-notes.md');
    assert.equal(row.doc_type, 'general');
    assert.deepEqual((found.find((item) => item.id === suggested) as Row).suggestions, [{ dimension: 'department', value: 'd1', source: 'rule' }]);
    assert.deepEqual(row.suggestions, []);
    assert.equal(Number(row.total_count), found.length);
    assert.equal(Number(row.suggested_count), 1);
    for (const column of Object.keys(row)) assert.ok(!/content|text|chunk|tenant/.test(column), column);
    assert.deepEqual(await list(P_OWNER, KEY_O), []);
  });

  test('the tag filter is OR within a dimension and AND across dimensions', async () => {
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { scopes: ['region:a1'] })), [tagged, suggested].sort());
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { scopes: ['region:a1', 'region:a2'] })), [tagged, both, suggested].sort());
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { scopes: ['region:a2', 'department:d1'] })), [both]);
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { scopes: ['region:a1', 'department:d1'] })), []);
  });

  test('the views: with suggestions, untagged, all', async () => {
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { filter: 'suggested' })), [suggested]);
    const bare = ids(await list(O_ADMIN, KEY_O, { filter: 'untagged' }));
    assert.ok(bare.includes(untagged) && bare.includes(percent));
    assert.ok(!bare.includes(tagged) && !bare.includes(both));
    assert.match((await failure(db, DOCS_SQL, [O_ADMIN, KEY_O, null, null, 50, 0, 'everything'])) ?? '', /^invalid_argument/);
  });

  test('the file-name search is case-insensitive and treats % and _ as literal characters', async () => {
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { query: 'ALPHA' })), [tagged]);
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { query: '%' })), [percent]);
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { query: '_5' })), [percent]);
    assert.deepEqual(ids(await list(O_ADMIN, KEY_O, { query: "notes.md' OR '1'='1" })), []);
  });

  test('pages are bounded and the total counts the whole filtered set', async () => {
    const page = await list(O_ADMIN, KEY_O, { limit: 2, offset: 0 });
    const all = await list(O_ADMIN, KEY_O);
    assert.equal(page.length, 2);
    assert.equal(Number(page[0]?.total_count), all.length);
    assert.equal((await list(O_ADMIN, KEY_O, { limit: 1000 })).length, all.length);
    assert.deepEqual(ids([...page, ...(await list(O_ADMIN, KEY_O, { limit: 2, offset: 2 })), ...(await list(O_ADMIN, KEY_O, { limit: 50, offset: 4 }))]), ids(all));
  });

  test("the purge hook clears the tags of a lineage's documents and chunks in that tenant only", async () => {
    const lineage = String((await rows(db, 'SELECT lineage_id FROM documents WHERE id = $1', [both]))[0]?.lineage_id);
    assert.equal(Number((await rows(db, 'SELECT rag_purge_hook_scope_tags($1, $2::uuid, NULL) AS n', [KEY_P, lineage]))[0]?.n), 0);
    assert.deepEqual((await documentScopes(db, both)).document, ['department:d1', 'region:a2']);
    assert.equal(Number((await rows(db, 'SELECT rag_purge_hook_scope_tags($1, $2::uuid, NULL) AS n', [KEY_O, lineage]))[0]?.n), 3);
    assert.deepEqual(await documentScopes(db, both), { document: [], chunks: [[], []] });
    assert.deepEqual((await documentScopes(db, tagged)).document, ['region:a1']);
  });

  test('a document that is no longer current is not listed', async () => {
    await rows(db, 'UPDATE documents SET is_current = false WHERE id = $1', [untagged]);
    assert.ok(!ids(await list(O_ADMIN, KEY_O)).includes(untagged));
  });
});

describe('scope tags (single-tenant)', () => {
  let db: PGlite;
  const ADMIN = '00000000-0000-4000-8000-0000000041a1';
  const USER = '00000000-0000-4000-8000-0000000041a2';

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [ADMIN, 'admin@example.invalid', USER, 'user@example.invalid']);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  });

  after(async () => {
    await db?.close();
  });

  test('a deployment admin manages the s:default vocabulary; another user cannot', async () => {
    const entry = await create(db, ADMIN, 's:default', 'legal_entity', 'e1', 'Entity one');
    assert.equal(entry.value, 'e1');
    assert.match((await failure(db, CREATE_SQL, [USER, 's:default', 'legal_entity', 'e2', 'Entity two', []])) ?? '', /^not_admin/);
    assert.deepEqual((await rows(db, LIST_SQL, [ADMIN, 's:default'])).map((row) => row.value), ['e1']);
    assert.deepEqual(await rows(db, LIST_SQL, [USER, 's:default']), []);
  });
});
