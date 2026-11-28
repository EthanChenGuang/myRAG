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
 * Plan 03.2-43 (D-40, DATA-18): rag_set_upload_scopes (0818) puts the uploader's tags on the version being ingested, before its chunks
 * are written, so every chunk the writers add carries them, through a publish hold and approval. Only a processing, not-current version of
 * the named tenant can be tagged this way; values must be active entries of that tenant's vocabulary. Neutral synthetic slugs only.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0818_upload_scopes.sql';
const LEGACY_PROFILE = 'openai-3-small-1536';
const HALFVEC_PROFILE = 'voyage-4-large-1024';

const SINGLE_KEY = 's:default';
const SINGLE_MEMBER = '00000000-0000-4000-8000-0000000043b9';
const SINGLE_ADMIN = '00000000-0000-4000-8000-0000000043a9';
const ORG_O = TWO_TENANT_IDS.orgO;
const ORG_P = '00000000-0000-4000-8000-0000000043c2';
const P_OWNER = '00000000-0000-4000-8000-0000000043f2';
const O_MEMBER = TWO_TENANT_IDS.userA;
const KEY_O = `o:${ORG_O}`;
const KEY_P = `o:${ORG_P}`;

type Row = Record<string, unknown>;

interface Workspace {
  key: string;
  userId: string | null;
  orgId: string | null;
}

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

const UPLOAD_SQL = 'SELECT * FROM rag_set_upload_scopes(p_document_id => $1, p_tenant_key => $2, p_scopes => $3::text[])';

async function addValue(db: PGlite, key: string, dimension: string, value: string, active = true): Promise<void> {
  await db.query(
    'INSERT INTO public.rag_scope_vocabulary (tenant_key, dimension, value, label, active, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)',
    [key, dimension, value, `Label ${value}`, active, SINGLE_ADMIN],
  );
}

async function begin(db: PGlite, workspace: Workspace, label: string): Promise<string> {
  const name = next(label);
  const begun = (
    await rows(
      db,
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'chat_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [workspace.key, workspace.userId, workspace.orgId, `upload/${name}.md`, `${name}.md`, crypto.createHash('sha256').update(name).digest('hex')],
    )
  )[0];
  return String(begun?.document_id);
}

async function writeChunks(db: PGlite, workspace: Workspace, id: string): Promise<void> {
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
}

async function documentScopes(db: PGlite, id: string): Promise<{ document: string[]; chunks: string[][] }> {
  const document = (await rows(db, 'SELECT scopes FROM documents WHERE id = $1', [id]))[0]?.scopes as string[];
  const chunks = (await rows(db, 'SELECT scopes FROM document_chunks WHERE document_id = $1 ORDER BY chunk_index', [id])).map((row) => row.scopes as string[]);
  return { document, chunks };
}

describe('upload tags in single-tenant mode', () => {
  let db: PGlite;
  const workspace: Workspace = { key: SINGLE_KEY, userId: null, orgId: null };

  before(async () => {
    db = (await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' })).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [SINGLE_ADMIN, 'single-admin@example.invalid']);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [SINGLE_ADMIN]);
    await addValue(db, SINGLE_KEY, 'region', 'a1');
    await addValue(db, SINGLE_KEY, 'department', 'd1');
    await addValue(db, SINGLE_KEY, 'region', 'b2', false);
  });

  after(async () => {
    await db?.close();
  });

  test("a member's upload (no user_id on the row) ends as a published document whose every chunk carries exactly its tag", async () => {
    const id = await begin(db, workspace, 'member');
    // rag_set_document_scopes admits only an admin or the row's user_id, which a single-tenant row does not have: the reason for 0818.
    assert.match((await failure(db, 'SELECT * FROM rag_set_document_scopes($1, $2, $3::text[], $4)', [id, SINGLE_KEY, ['region:a1'], SINGLE_MEMBER])) ?? '', /^not_found/);
    const set = (await rows(db, UPLOAD_SQL, [id, SINGLE_KEY, ['region:a1', 'region:a1']]))[0];
    assert.deepEqual(set?.scopes, ['region:a1']);
    await writeChunks(db, workspace, id);
    await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, SINGLE_KEY]);
    assert.deepEqual(await documentScopes(db, id), { document: ['region:a1'], chunks: [['region:a1'], ['region:a1']] });
    assert.equal((await rows(db, 'SELECT status FROM documents WHERE id = $1', [id]))[0]?.status, 'ready');
  });

  test('a held upload keeps its tags on the document and every chunk through approval', async () => {
    const id = await begin(db, workspace, 'held');
    await rows(db, UPLOAD_SQL, [id, SINGLE_KEY, ['department:d1', 'region:a1']]);
    await writeChunks(db, workspace, id);
    assert.equal((await rows(db, 'SELECT outcome FROM rag_hold_document_for_review(p_document_id => $1, p_tenant_key => $2)', [id, SINGLE_KEY]))[0]?.outcome, 'pending_review');
    const tagged = { document: ['department:d1', 'region:a1'], chunks: [['department:d1', 'region:a1'], ['department:d1', 'region:a1']] };
    assert.deepEqual(await documentScopes(db, id), tagged);
    await rows(db, 'SELECT * FROM rag_approve_upload(p_document_id => $1, p_actor => $2)', [id, SINGLE_ADMIN]);
    assert.equal((await rows(db, 'SELECT status FROM documents WHERE id = $1', [id]))[0]?.status, 'ready');
    assert.deepEqual(await documentScopes(db, id), tagged);
  });

  test('an unknown, retired, NULL or excess value is refused and nothing is stored', async () => {
    const id = await begin(db, workspace, 'refused');
    assert.match((await failure(db, UPLOAD_SQL, [id, SINGLE_KEY, ['region:zz9']])) ?? '', /^unknown_scope_value/);
    assert.match((await failure(db, UPLOAD_SQL, [id, SINGLE_KEY, ['region:b2']])) ?? '', /^unknown_scope_value/);
    assert.match((await failure(db, UPLOAD_SQL, [id, SINGLE_KEY, ['region:a1', null]])) ?? '', /^unknown_scope_value/);
    const many = Array.from({ length: 21 }, (_, index) => `region:v${index}`);
    assert.match((await failure(db, UPLOAD_SQL, [id, SINGLE_KEY, many])) ?? '', /^too_many_scopes/);
    assert.deepEqual((await documentScopes(db, id)).document, []);
  });

  test('a published or retired document cannot be tagged through the upload setter', async () => {
    const id = await begin(db, workspace, 'published');
    await writeChunks(db, workspace, id);
    await rows(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [id, SINGLE_KEY]);
    assert.match((await failure(db, UPLOAD_SQL, [id, SINGLE_KEY, ['region:a1']])) ?? '', /^not_found/);
    assert.deepEqual(await documentScopes(db, id), { document: [], chunks: [[], []] });
  });

  test('a second apply keeps the function, which stays service_role only with an empty search_path and no SECURITY DEFINER', async () => {
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
    const id = await begin(db, workspace, 'reapply');
    assert.deepEqual((await rows(db, UPLOAD_SQL, [id, SINGLE_KEY, ['region:a1']]))[0]?.scopes, ['region:a1']);
    const grants = await rows(
      db,
      `SELECT r.rolname, has_function_privilege(r.rolname, 'public.rag_set_upload_scopes(uuid, text, text[])', 'EXECUTE') AS can
       FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)`,
    );
    assert.deepEqual(Object.fromEntries(grants.map((row) => [row.rolname, row.can])), { anon: false, authenticated: false, service_role: true });
    const config = await rows(
      db,
      "SELECT p.proconfig, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rag_set_upload_scopes'",
    );
    assert.equal(config.length, 1);
    assert.equal(config[0]?.prosecdef, false);
    assert.ok((config[0]?.proconfig as string[]).some((entry) => /^search_path=("")?$/.test(entry)), String(config[0]?.proconfig));
  });
});

describe('upload tags across two tenants (multi-tenant)', () => {
  let db: PGlite;
  const workspaceO: Workspace = { key: KEY_O, userId: O_MEMBER, orgId: ORG_O };
  const workspaceP: Workspace = { key: KEY_P, userId: P_OWNER, orgId: ORG_P };

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [P_OWNER, 'p-owner@example.invalid']);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [ORG_P, 'Tenant P', 'tenant-p-43', P_OWNER]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [ORG_P, P_OWNER]);
    await addValue(db, KEY_O, 'region', 'o-area');
    await addValue(db, KEY_P, 'region', 'p-area');
  });

  after(async () => {
    await db?.close();
  });

  test("a member's upload to O carries O's tag on every chunk", async () => {
    const id = await begin(db, workspaceO, 'org-o');
    await rows(db, UPLOAD_SQL, [id, KEY_O, ['region:o-area']]);
    await writeChunks(db, workspaceO, id);
    assert.deepEqual(await documentScopes(db, id), { document: ['region:o-area'], chunks: [['region:o-area'], ['region:o-area']] });
  });

  test("P's tenant key cannot reach O's version, and O's version cannot take P's value", async () => {
    const id = await begin(db, workspaceO, 'org-o-guard');
    assert.match((await failure(db, UPLOAD_SQL, [id, KEY_P, ['region:p-area']])) ?? '', /^not_found/);
    assert.match((await failure(db, UPLOAD_SQL, [id, KEY_O, ['region:p-area']])) ?? '', /^unknown_scope_value/);
    const idP = await begin(db, workspaceP, 'org-p');
    assert.match((await failure(db, UPLOAD_SQL, [idP, KEY_O, ['region:o-area']])) ?? '', /^not_found/);
    assert.deepEqual((await documentScopes(db, id)).document, []);
    assert.deepEqual((await documentScopes(db, idP)).document, []);
  });
});
