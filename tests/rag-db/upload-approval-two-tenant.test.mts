import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

/**
 * D-37 and D-50 across tenants: an organization admin who is not in admin_users approves, rejects and exempts for that organization only;
 * another organization's and a personal workspace's uploads answer not_found and stay untouched.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0814_upload_approval_org_admins.sql';

const ORG_O = TWO_TENANT_IDS.orgO;
const ORG_P = '00000000-0000-4000-8000-0000000016c2';
const O_ADMIN = '00000000-0000-4000-8000-0000000016f1';
const P_OWNER = '00000000-0000-4000-8000-0000000016f2';
const O_MEMBER = TWO_TENANT_IDS.userA;
const DEPLOYMENT_ADMIN = TWO_TENANT_IDS.userB;
const KEY_O = `o:${ORG_O}`;
const KEY_P = `o:${ORG_P}`;
const KEY_PERSONAL = `u:${TWO_TENANT_IDS.userB}`;
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
const WORKSPACE_PERSONAL: Workspace = { key: KEY_PERSONAL, userId: TWO_TENANT_IDS.userB, orgId: null };

/** A new held upload (status pending_review) in the workspace, with one chunk. */
async function pendingUpload(db: PGlite, workspace: Workspace, label: string): Promise<string> {
  const name = next(label);
  const begun = (
    await rows(
      db,
      `SELECT document_id FROM rag_begin_document_version($1, $2::uuid, $3::uuid, 'config_upload', $4, $5, $6, 'general', 'fallback', 'general-1', 1)`,
      [workspace.key, workspace.userId, workspace.orgId, `approval/${name}.md`, `${name}.md`, crypto.createHash('sha256').update(name).digest('hex')],
    )
  )[0];
  const id = String(begun?.document_id);
  const content = `${next('tok')} neutral probe sentence about a shared topic`;
  const chunks = [{ chunk_index: 0, content, lexical_text: content, metadata: {} }];
  const embeddings = { [LEGACY_PROFILE]: [embedText(content)], [HALFVEC_PROFILE]: [embedText(content).slice(0, 1024)] };
  await rows(
    db,
    'SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => $4::jsonb, p_final => true, p_total => 1)',
    [id, workspace.key, JSON.stringify(chunks), JSON.stringify(embeddings)],
  );
  const held = (await rows(db, 'SELECT outcome FROM rag_hold_document_for_review(p_document_id => $1, p_tenant_key => $2)', [id, workspace.key]))[0];
  assert.equal(held?.outcome, 'pending_review');
  return id;
}

async function statusOf(db: PGlite, id: string): Promise<Row> {
  return (await rows(db, 'SELECT status, is_current, approved_by FROM documents WHERE id = $1', [id]))[0] as Row;
}

const APPROVE_SQL = 'SELECT * FROM rag_approve_upload(p_document_id => $1, p_actor => $2)';
const REJECT_SQL = 'SELECT * FROM rag_reject_upload(p_document_id => $1, p_actor => $2)';
const LIST_SQL = 'SELECT document_id::text AS id FROM rag_list_pending_uploads(p_actor => $1, p_tenant_key => $2)';
const ADD_SQL = 'SELECT * FROM rag_upload_exemption_add(p_actor => $1, p_tenant_key => $2, p_kind => $3, p_ref => $4)';
const EXEMPTION_LIST_SQL = 'SELECT id::text, tenant_key, ref FROM rag_upload_exemption_list(p_actor => $1, p_tenant_key => $2)';
const REMOVE_SQL = 'SELECT * FROM rag_upload_exemption_remove(p_actor => $1, p_exemption_id => $2)';
const IS_ADMIN_SQL = 'SELECT rag_is_tenant_admin(p_user => $1, p_tenant_key => $2) AS ok';

describe('upload approval across two tenants: organization admins (multi-tenant)', () => {
  let db: PGlite;
  let docO: string;
  let docP: string;
  let docPersonal: string;

  before(async () => {
    db = (await createTwoTenantDatabase()).db;
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [O_ADMIN, 'o-admin@example.invalid', P_OWNER, 'p-owner@example.invalid']);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [ORG_P, 'Tenant P', 'tenant-p', P_OWNER]);
    await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $4, 'owner')", [ORG_O, O_ADMIN, ORG_P, P_OWNER]);
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [DEPLOYMENT_ADMIN]);
    docO = await pendingUpload(db, WORKSPACE_O, 'org-o');
    docP = await pendingUpload(db, WORKSPACE_P, 'org-p');
    docPersonal = await pendingUpload(db, WORKSPACE_PERSONAL, 'personal');
  });

  after(async () => {
    await db?.close();
  });

  test('the organization admin is not in admin_users', async () => {
    assert.equal((await rows(db, 'SELECT count(*)::int AS n FROM admin_users WHERE id = $1', [O_ADMIN]))[0]?.n, 0);
  });

  test("an organization admin lists only that organization's pending uploads", async () => {
    assert.deepEqual((await rows(db, LIST_SQL, [O_ADMIN, null])).map((row) => row.id), [docO]);
    assert.deepEqual((await rows(db, LIST_SQL, [O_ADMIN, KEY_O])).map((row) => row.id), [docO]);
    assert.deepEqual(await rows(db, LIST_SQL, [O_ADMIN, KEY_P]), []);
    assert.deepEqual(await rows(db, LIST_SQL, [O_ADMIN, KEY_PERSONAL]), []);
    assert.deepEqual((await rows(db, LIST_SQL, [P_OWNER, null])).map((row) => row.id), [docP]);
  });

  test("approving or rejecting another organization's or a personal workspace's upload is not_found and changes nothing", async () => {
    for (const id of [docP, docPersonal]) {
      assert.match((await failure(db, APPROVE_SQL, [id, O_ADMIN])) ?? '', /not_found/, id);
      assert.match((await failure(db, REJECT_SQL, [id, O_ADMIN])) ?? '', /not_found/, id);
      const state = await statusOf(db, id);
      assert.equal(state.status, 'pending_review');
      assert.equal(state.approved_by, null);
    }
    assert.equal((await rows(db, 'SELECT count(*)::int AS n FROM rag_admin_audit WHERE actor = $1 AND document_id IN ($2, $3)', [O_ADMIN, docP, docPersonal]))[0]?.n, 0);
  });

  test('a member of the organization cannot approve its uploads', async () => {
    assert.match((await failure(db, APPROVE_SQL, [docO, O_MEMBER])) ?? '', /not_found/);
    assert.equal((await statusOf(db, docO)).status, 'pending_review');
  });

  test("the organization admin approves the organization's upload, stamped as the approver", async () => {
    const approved = (await rows(db, APPROVE_SQL, [docO, O_ADMIN]))[0] as Row;
    assert.equal(approved.outcome, 'published');
    const state = await statusOf(db, docO);
    assert.equal(state.status, 'ready');
    assert.equal(state.is_current, true);
    assert.equal(state.approved_by, O_ADMIN);
  });

  test('the organization admin rejects a later upload of the organization', async () => {
    const id = await pendingUpload(db, WORKSPACE_O, 'org-o-reject');
    assert.equal(((await rows(db, REJECT_SQL, [id, O_ADMIN]))[0] as Row).outcome, 'deleted');
    assert.equal((await statusOf(db, id)).status, 'deleted');
  });

  test("exemptions added for one organization are invisible to and not removable by the other organization's admin", async () => {
    const ref = next('neutral-connection-');
    const added = (await rows(db, ADD_SQL, [O_ADMIN, KEY_O, 'connector', ref]))[0] as Row;
    assert.equal(added.outcome, 'added');
    assert.match((await failure(db, ADD_SQL, [O_ADMIN, KEY_P, 'connector', ref])) ?? '', /not_found/);
    assert.match((await failure(db, ADD_SQL, [O_ADMIN, KEY_PERSONAL, 'connector', ref])) ?? '', /not_found/);

    assert.ok((await rows(db, EXEMPTION_LIST_SQL, [O_ADMIN, null])).some((row) => row.id === added.id));
    assert.ok(!(await rows(db, EXEMPTION_LIST_SQL, [P_OWNER, null])).some((row) => row.ref === ref));
    assert.deepEqual(await rows(db, EXEMPTION_LIST_SQL, [P_OWNER, KEY_O]), []);
    assert.ok(!(await rows(db, 'SELECT ref FROM rag_upload_exemptions_for($1)', [KEY_P])).some((row) => row.ref === ref));

    assert.match((await failure(db, REMOVE_SQL, [P_OWNER, added.id])) ?? '', /not_found/);
    assert.equal(((await rows(db, REMOVE_SQL, [O_ADMIN, added.id]))[0] as Row).outcome, 'removed');
  });

  test('tenant admin follows the organization role; a personal workspace stays with deployment admins', async () => {
    const isAdmin = async (user: string, key: string) => (await rows(db, IS_ADMIN_SQL, [user, key]))[0]?.ok;
    assert.equal(await isAdmin(O_ADMIN, KEY_O), true);
    assert.equal(await isAdmin(O_ADMIN, KEY_P), false);
    assert.equal(await isAdmin(O_ADMIN, `u:${O_ADMIN}`), false);
    assert.equal(await isAdmin(O_MEMBER, KEY_O), false);
    assert.equal(await isAdmin(P_OWNER, KEY_P), true);
    assert.equal(await isAdmin(DEPLOYMENT_ADMIN, KEY_PERSONAL), true);
    assert.equal(await isAdmin(DEPLOYMENT_ADMIN, KEY_O), false);
  });

  test('a second apply of the migration leaves the rule unchanged, and the key function stays service_role only', async () => {
    await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
    assert.deepEqual((await rows(db, 'SELECT rag_upload_approval_keys($1) AS keys', [O_ADMIN]))[0]?.keys, [KEY_O]);
    const acl = (
      await rows(
        db,
        `SELECT has_function_privilege('anon', 'public.rag_upload_approval_keys(uuid)', 'EXECUTE') AS anon,
                has_function_privilege('authenticated', 'public.rag_upload_approval_keys(uuid)', 'EXECUTE') AS authed,
                has_function_privilege('service_role', 'public.rag_upload_approval_keys(uuid)', 'EXECUTE') AS service,
                p.prosecdef AS definer, p.proconfig AS config
         FROM pg_proc p WHERE p.oid = 'public.rag_upload_approval_keys(uuid)'::regprocedure`,
      )
    )[0] as Row;
    assert.equal(acl.anon, false);
    assert.equal(acl.authed, false);
    assert.equal(acl.service, true);
    assert.equal(acl.definer, true);
    assert.deepEqual(acl.config, ['search_path=""']);
  });
});
