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
