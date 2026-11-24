import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type FixtureDatabase } from '../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS_DIR = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b1';
const ADMIN = '00000000-0000-4000-8000-0000000000c1';
const MEMBER = '00000000-0000-4000-8000-0000000000d1';
const DOC_OWNED = '00000000-0000-4000-8000-00000000f001';
const DOC_LEGACY = '00000000-0000-4000-8000-00000000f002';
const CHUNK_OWNED = '00000000-0000-4000-8000-00000000f101';
const CHUNK_LEGACY = '00000000-0000-4000-8000-00000000f102';
const ORG = '00000000-0000-4000-8000-00000000e001';
const ORG_B = '00000000-0000-4000-8000-00000000e002';
const STRANGER = '00000000-0000-4000-8000-0000000000e1';
const CHAT_OTHER = '00000000-0000-4000-8000-00000000e101';
const CHAT_OWNER = '00000000-0000-4000-8000-00000000e102';
const ZERO_VECTOR = `[${new Array(1536).fill(0).join(',')}]`;

type Role = 'anon' | 'authenticated' | 'service_role';

async function asRole<T>(db: PGlite, role: Role, userId: string | null, run: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', $2, false)", [userId ?? '', role]);
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
  }
}

async function rejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, pattern);
}

const INSERT_DENIED = /row-level security|permission denied for function rag_lexical_tsvector/i;

async function insertUsers(db: PGlite, ids: string[]): Promise<void> {
  for (const id of ids) await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${id.slice(-4)}@example.invalid`]);
}

async function seedKnowledgeBase(db: PGlite): Promise<void> {
  await insertUsers(db, [OWNER, OTHER, ADMIN]);
  await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'owned.md', 'owned content', $2)", [DOC_OWNED, OWNER]);
  await db.query("INSERT INTO documents (id, filename, content) VALUES ($1, 'legacy.md', 'legacy content')", [DOC_LEGACY]);
  await db.query("INSERT INTO document_chunks (id, document_id, content, embedding) VALUES ($1, $2, 'owned chunk', $3::vector)", [CHUNK_OWNED, DOC_OWNED, ZERO_VECTOR]);
  await db.query("INSERT INTO document_chunks (id, document_id, content, embedding) VALUES ($1, $2, 'legacy chunk', $3::vector)", [CHUNK_LEGACY, DOC_LEGACY, ZERO_VECTOR]);
  await db.exec('GRANT EXECUTE ON FUNCTION public.rag_lexical_tsvector(text) TO authenticated');
}

async function count(db: PGlite, table: string): Promise<number> {
  return Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
}

function singleTenantSuite(label: string, build: () => Promise<FixtureDatabase>): void {
  describe(`single-tenant knowledge-base RLS (${label})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;

    before(async () => {
      fixture = await build();
      db = fixture.db;
    });
    after(async () => {
      await fixture?.db.close();
    });

    test('a signed-in non-owner non-admin cannot delete or update another user document or chunk, in bulk or by id', async () => {
      const documents = await count(db, 'documents');
      const chunks = await count(db, 'document_chunks');
      await asRole(db, 'authenticated', OTHER, async () => {
        assert.equal((await db.query('DELETE FROM documents WHERE id IS NOT NULL RETURNING id')).rows.length, 0);
        assert.equal((await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [DOC_OWNED])).rows.length, 0);
        assert.equal((await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [DOC_LEGACY])).rows.length, 0);
        assert.equal((await db.query("UPDATE documents SET content = 'x' WHERE id = $1 RETURNING id", [DOC_OWNED])).rows.length, 0);
        assert.equal((await db.query("UPDATE documents SET user_id = $1 WHERE id = $2 RETURNING id", [OTHER, DOC_OWNED])).rows.length, 0);
        assert.equal((await db.query('DELETE FROM document_chunks WHERE id IS NOT NULL RETURNING id')).rows.length, 0);
        assert.equal((await db.query("UPDATE document_chunks SET content = 'x' WHERE id = $1 RETURNING id", [CHUNK_OWNED])).rows.length, 0);
      });
      assert.equal(await count(db, 'documents'), documents);
      assert.equal(await count(db, 'document_chunks'), chunks);
    });

    test('everyone, including anon, can still read the shared knowledge base', async () => {
      for (const [role, user] of [['anon', null], ['authenticated', OTHER]] as const) {
        await asRole(db, role, user, async () => {
          const rows = await db.query<{ id: string }>('SELECT id FROM documents WHERE id = ANY($1::uuid[])', [[DOC_OWNED, DOC_LEGACY]]);
          assert.equal(rows.rows.length, 2);
          assert.equal((await db.query('SELECT id FROM document_chunks WHERE id = ANY($1::uuid[])', [[CHUNK_OWNED, CHUNK_LEGACY]])).rows.length, 2);
        });
      }
    });

    test('anon cannot write documents or chunks', async () => {
      await asRole(db, 'anon', null, async () => {
        assert.equal((await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [DOC_OWNED])).rows.length, 0);
        assert.equal((await db.query("UPDATE documents SET content = 'x' WHERE id = $1 RETURNING id", [DOC_OWNED])).rows.length, 0);
        await rejection(db.query("INSERT INTO documents (id, filename, content) VALUES (gen_random_uuid(), 'a', 'b')"), /permission denied|row-level security/i);
      });
      assert.equal((await db.query('SELECT 1 FROM documents WHERE id = $1', [DOC_OWNED])).rows.length, 1);
    });

    test('inserts need user_id = auth.uid(): a null or foreign owner is refused, the caller own id is accepted', async () => {
      await asRole(db, 'authenticated', OTHER, async () => {
        await rejection(db.query("INSERT INTO documents (id, filename, content) VALUES (gen_random_uuid(), 'a', 'b')"), INSERT_DENIED);
        await rejection(
          db.query("INSERT INTO documents (id, filename, content, user_id) VALUES (gen_random_uuid(), 'a', 'b', $1)", [OWNER]),
          INSERT_DENIED,
        );
        await rejection(
          db.query("INSERT INTO document_chunks (id, document_id, content, embedding) VALUES (gen_random_uuid(), $1, 'c', $2::vector)", [DOC_OWNED, ZERO_VECTOR]),
          INSERT_DENIED,
        );
        const id = '00000000-0000-4000-8000-00000000f201';
        await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'mine.md', 'mine', $2)", [id, OTHER]);
        await db.query("INSERT INTO document_chunks (id, document_id, content, embedding) VALUES (gen_random_uuid(), $1, 'c', $2::vector)", [id, ZERO_VECTOR]);
        assert.equal((await db.query('DELETE FROM document_chunks WHERE document_id = $1 RETURNING id', [id])).rows.length, 1);
        assert.equal((await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [id])).rows.length, 1);
      });
    });

    test('an owner can update and delete their own document and chunks but cannot hand it to someone else', async () => {
      const id = '00000000-0000-4000-8000-00000000f202';
      await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'o.md', 'o', $2)", [id, OWNER]);
      await db.query("INSERT INTO document_chunks (id, document_id, content, embedding) VALUES (gen_random_uuid(), $1, 'c', $2::vector)", [id, ZERO_VECTOR]);
      await asRole(db, 'authenticated', OWNER, async () => {
        assert.equal((await db.query("UPDATE documents SET content = 'new' WHERE id = $1 RETURNING id", [id])).rows.length, 1);
        await rejection(db.query('UPDATE documents SET user_id = $1 WHERE id = $2', [OTHER, id]), /row-level security/i);
        assert.equal((await db.query("UPDATE document_chunks SET content = 'new' WHERE document_id = $1 RETURNING id", [id])).rows.length, 1);
        assert.equal((await db.query('DELETE FROM document_chunks WHERE document_id = $1 RETURNING id', [id])).rows.length, 1);
        assert.equal((await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [id])).rows.length, 1);
      });
    });

    test('an admin can delete and update documents they do not own, including legacy rows without an owner', async () => {
      const id = '00000000-0000-4000-8000-00000000f203';
      await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'a.md', 'a', $2)", [id, OWNER]);
      await asRole(db, 'authenticated', ADMIN, async () => {
        assert.equal((await db.query("UPDATE documents SET content = 'x' WHERE id = $1 RETURNING id", [DOC_LEGACY])).rows.length, 1);
        assert.equal((await db.query("UPDATE document_chunks SET content = 'x' WHERE id = $1 RETURNING id", [CHUNK_LEGACY])).rows.length, 1);
        assert.equal((await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [id])).rows.length, 1);
      });
    });

    test('read_only_doc_dashboard stops non-admin writes (owners too) and not admin writes', async () => {
      const id = '00000000-0000-4000-8000-00000000f204';
      await db.query("INSERT INTO documents (id, filename, content, user_id) VALUES ($1, 'ro.md', 'ro', $2)", [id, OWNER]);
      await db.exec('UPDATE admin_settings SET read_only_doc_dashboard = true');
      try {
        await asRole(db, 'authenticated', OWNER, async () => {
          await rejection(
            db.query("INSERT INTO documents (id, filename, content, user_id) VALUES (gen_random_uuid(), 'x', 'y', $1)", [OWNER]),
            /row-level security/i,
          );
          assert.equal((await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [id])).rows.length, 0);
          assert.equal((await db.query("UPDATE documents SET content = 'x' WHERE id = $1 RETURNING id", [id])).rows.length, 0);
        });
        await asRole(db, 'authenticated', ADMIN, async () => {
          assert.equal((await db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [id])).rows.length, 1);
        });
      } finally {
        await db.exec('UPDATE admin_settings SET read_only_doc_dashboard = false');
      }
    });

    test('tool_execution_states: a row must carry the caller user_id', async () => {
      const chatOwner = CHAT_OWNER;
      await db.query("INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, 't', '[]'::jsonb)", [chatOwner, OWNER]);
      await asRole(db, 'authenticated', OWNER, async () => {
        await rejection(
          db.query("INSERT INTO tool_execution_states (chat_id, message_id, tool_call_id, tool_name, status, user_id) VALUES ($1, 1, 'planted', 't', 'completed', $2)", [chatOwner, OTHER]),
          /row-level security/i,
        );
        await rejection(
          db.query("INSERT INTO tool_execution_states (chat_id, message_id, tool_call_id, tool_name, status) VALUES ($1, 1, 'null-owner', 't', 'completed')", [chatOwner]),
          /row-level security/i,
        );
        await db.query("INSERT INTO tool_execution_states (chat_id, message_id, tool_call_id, tool_name, status, user_id) VALUES ($1, 1, 'mine', 't', 'pending', $2)", [chatOwner, OWNER]);
        assert.equal((await db.query("SELECT 1 FROM tool_execution_states WHERE tool_call_id = 'mine'")).rows.length, 1);
        await rejection(db.query("UPDATE tool_execution_states SET user_id = $1 WHERE tool_call_id = 'mine'", [OTHER]), /row-level security/i);
      });
      await db.query("INSERT INTO tool_execution_states (chat_id, message_id, tool_call_id, tool_name, status, user_id) VALUES ($1, 1, 'legacy-row', 't', 'pending', NULL)", [chatOwner]);
      await asRole(db, 'authenticated', OWNER, async () => {
        assert.equal((await db.query("SELECT 1 FROM tool_execution_states WHERE tool_call_id = 'legacy-row'")).rows.length, 0);
        assert.equal((await db.query("UPDATE tool_execution_states SET status = 'completed' WHERE tool_call_id = 'legacy-row' RETURNING id")).rows.length, 0);
      });
    });

    test('nango_connections: a user can read their own rows but cannot insert or update any', async () => {
      await db.query("INSERT INTO nango_connections (user_id, connection_id, provider) VALUES ($1, 'conn-victim', 'notion')", [OTHER]);
      await asRole(db, 'authenticated', OWNER, async () => {
        assert.equal((await db.query('SELECT 1 FROM nango_connections')).rows.length, 0);
        await rejection(db.query("INSERT INTO nango_connections (user_id, connection_id, provider) VALUES ($1, 'conn-new', 'dropbox')", [OWNER]), /permission denied/i);
        await rejection(db.query("UPDATE nango_connections SET connection_id = 'conn-victim' WHERE user_id = $1", [OWNER]), /permission denied/i);
        await rejection(db.query('DELETE FROM nango_connections WHERE user_id = $1', [OTHER]), /permission denied/i);
        await rejection(db.query("INSERT INTO nango_sync_records (user_id, connection_id, provider, file_id, file_name) VALUES ($1, 'c', 'notion', 'f', 'n')", [OWNER]), /permission denied/i);
      });
      await asRole(db, 'authenticated', OTHER, async () => {
        assert.equal((await db.query('SELECT 1 FROM nango_connections')).rows.length, 1);
      });
      await asRole(db, 'service_role', null, async () => {
        await db.query("INSERT INTO nango_connections (user_id, connection_id, provider) VALUES ($1, 'conn-server', 'dropbox')", [OWNER]);
      });
    });

    test('anon cannot call is_admin; authenticated callers cannot read another user subscription or connection stats', async () => {
      await asRole(db, 'anon', null, async () => {
        await rejection(db.query('SELECT is_admin($1)', [ADMIN]), /permission denied/i);
      });
      await asRole(db, 'authenticated', OTHER, async () => {
        assert.equal((await db.query<{ ok: boolean }>('SELECT is_subscribed($1) AS ok', [OWNER])).rows[0].ok, false);
        assert.equal((await db.query('SELECT * FROM get_nango_stats($1)', [OTHER])).rows.length, 1);
        assert.equal((await db.query('SELECT * FROM get_nango_stats($1)', [OWNER])).rows.length, 0);
      });
    });
  });
}

const SINGLE_OLD_STATE = `
DROP POLICY IF EXISTS "Authenticated users insert own documents" ON documents;
DROP POLICY IF EXISTS "Owners and admins update documents" ON documents;
DROP POLICY IF EXISTS "Owners and admins delete documents" ON documents;
DROP POLICY IF EXISTS "Authenticated users insert chunks of own documents" ON document_chunks;
DROP POLICY IF EXISTS "Owners and admins update chunks" ON document_chunks;
DROP POLICY IF EXISTS "Owners and admins delete chunks" ON document_chunks;
CREATE POLICY "Allow full access to authenticated users" ON documents FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow full access to authenticated users" ON document_chunks FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY "Users can view their own tool execution states" ON tool_execution_states;
DROP POLICY "Users can insert tool execution states for their own chats" ON tool_execution_states;
DROP POLICY "Users can update their own tool execution states" ON tool_execution_states;
CREATE POLICY "Users can view their own tool execution states" ON tool_execution_states FOR SELECT USING (EXISTS (SELECT 1 FROM chats WHERE chats.id = tool_execution_states.chat_id AND chats.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can insert tool execution states for their own chats" ON tool_execution_states FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM chats WHERE chats.id = tool_execution_states.chat_id AND chats.user_id = (SELECT auth.uid())));
CREATE POLICY "Users can update their own tool execution states" ON tool_execution_states FOR UPDATE USING (EXISTS (SELECT 1 FROM chats WHERE chats.id = tool_execution_states.chat_id AND chats.user_id = (SELECT auth.uid())));
GRANT INSERT, UPDATE, DELETE ON nango_connections TO authenticated;
GRANT INSERT, UPDATE ON nango_sync_records TO authenticated;
CREATE POLICY "Users can insert own connections" ON nango_connections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own connections" ON nango_connections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own connections" ON nango_connections FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own sync records" ON nango_sync_records FOR INSERT WITH CHECK (auth.uid() = user_id);
GRANT EXECUTE ON FUNCTION is_admin(uuid) TO PUBLIC;
`;

singleTenantSuite('fresh setup file', async () => {
  const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR, supabaseGrants: true });
  await seedKnowledgeBase(fixture.db);
  return fixture;
});

singleTenantSuite('existing database after the patch, applied twice', async () => {
  const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR, supabaseGrants: true });
  await fixture.db.exec(SINGLE_OLD_STATE);
  await fixture.db.exec('ALTER TABLE documents DROP COLUMN user_id');
  await fixture.db.exec(read('supabase/patches/2026-11-security-review-single-tenant.sql'));
  await fixture.db.exec(read('supabase/patches/2026-11-security-review-single-tenant.sql'));
  await seedKnowledgeBase(fixture.db);
  return fixture;
});

describe('single-tenant old policies really were open (guards the patch test)', () => {
  test('before the patch a signed-in stranger deletes anything', async () => {
    const fixture = await createFixtureDatabase({ deploymentMode: 'single-tenant', corpusDir: CORPUS_DIR, supabaseGrants: true });
    try {
      await fixture.db.exec(SINGLE_OLD_STATE);
      await seedKnowledgeBase(fixture.db);
      await asRole(fixture.db, 'authenticated', OTHER, async () => {
        assert.equal((await fixture.db.query('DELETE FROM document_chunks WHERE document_id = $1 RETURNING id', [DOC_OWNED])).rows.length, 1);
        assert.equal((await fixture.db.query('DELETE FROM documents WHERE id = $1 RETURNING id', [DOC_OWNED])).rows.length, 1);
      });
    } finally {
      await fixture.db.close();
    }
  });
});

const MULTI_OLD_STATE = `
DROP POLICY "Users can view own tool states" ON tool_execution_states;
DROP POLICY "Users can insert tool states" ON tool_execution_states;
DROP POLICY "Users can update tool states" ON tool_execution_states;
CREATE POLICY "Users can view own tool states" ON tool_execution_states FOR SELECT USING (EXISTS (SELECT 1 FROM chats WHERE chats.id = tool_execution_states.chat_id AND chats.user_id = auth.uid()));
CREATE POLICY "Users can insert tool states" ON tool_execution_states FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM chats WHERE chats.id = tool_execution_states.chat_id AND chats.user_id = auth.uid()));
CREATE POLICY "Users can update tool states" ON tool_execution_states FOR UPDATE USING (EXISTS (SELECT 1 FROM chats WHERE chats.id = tool_execution_states.chat_id AND chats.user_id = auth.uid()));
GRANT INSERT, UPDATE, DELETE ON nango_connections TO authenticated;
GRANT INSERT, UPDATE ON nango_sync_records TO authenticated;
CREATE POLICY "Users can insert own connections" ON nango_connections FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own connections" ON nango_connections FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own connections" ON nango_connections FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own sync records" ON nango_sync_records FOR INSERT WITH CHECK (auth.uid() = user_id);
GRANT EXECUTE ON FUNCTION get_workspace_context(text, uuid), get_user_org_ids(uuid), get_admin_organization_id() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION is_admin(uuid), create_organization_safe(text, text, uuid, boolean) TO PUBLIC;
`;

const MULTI_RECURSIVE_ORG_POLICIES_OLD_STATE = `
DROP POLICY "Users can view their organizations" ON organizations;
DROP POLICY "Users can update organizations" ON organizations;
DROP POLICY "Users can view org members" ON organization_members;
DROP POLICY "Admins can add members" ON organization_members;
DROP POLICY "Admins can remove members" ON organization_members;
DROP FUNCTION IF EXISTS is_org_owner(uuid);
DROP FUNCTION IF EXISTS is_org_admin(uuid);
CREATE POLICY "Users can view their organizations" ON organizations
  FOR SELECT USING (
    (is_personal = true AND owner_id = auth.uid())
    OR
    (is_personal = false AND id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid()))
  );
CREATE POLICY "Users can update organizations" ON organizations
  FOR UPDATE USING (
    (is_personal = true AND owner_id = auth.uid())
    OR
    (is_personal = false AND id IN (SELECT organization_id FROM organization_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin')))
  );
CREATE POLICY "Users can view org members" ON organization_members
  FOR SELECT USING (organization_id IN (SELECT id FROM organizations WHERE owner_id = auth.uid()) OR user_id = auth.uid());
CREATE POLICY "Admins can add members" ON organization_members
  FOR INSERT WITH CHECK (organization_id IN (SELECT id FROM organizations WHERE owner_id = auth.uid()));
CREATE POLICY "Admins can remove members" ON organization_members
  FOR DELETE USING (organization_id IN (SELECT id FROM organizations WHERE owner_id = auth.uid()));
`;

async function seedMulti(db: PGlite): Promise<void> {
  await insertUsers(db, [OWNER, OTHER, ADMIN, MEMBER, STRANGER]);
  await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Org', 'org-sec', $2, false)", [ORG, OWNER]);
  await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member')", [ORG, OWNER, ADMIN, MEMBER]);
  await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Org B', 'org-b-sec', $2, false)", [ORG_B, OTHER]);
  await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [ORG_B, OTHER]);
  await db.query("INSERT INTO team_invitations (organization_id, email, token, expires_at) VALUES ($1, 'invitee@example.invalid', 'tok-a', now() + interval '1 day'), ($2, 'invitee-b@example.invalid', 'tok-b', now() + interval '1 day')", [ORG, ORG_B]);
  await db.query("INSERT INTO organization_domains (domain, organization_id) VALUES ('a.example.invalid', $1), ('b.example.invalid', $2)", [ORG, ORG_B]);
  await db.query("INSERT INTO chats (id, user_id, title, messages) VALUES ($1, $2, 't', '[]'::jsonb), ($3, $4, 't', '[]'::jsonb)", [CHAT_OWNER, OWNER, CHAT_OTHER, OTHER]);
}

function multiTenantSuite(label: string, build: () => Promise<FixtureDatabase>): void {
  describe(`multi-tenant RLS and function grants (${label})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;

    before(async () => {
      fixture = await build();
      db = fixture.db;
      await seedMulti(db);
    });
    after(async () => {
      await fixture?.db.close();
    });

    test('tool_execution_states: a user cannot plant a row with another user_id or a null owner', async () => {
      await asRole(db, 'authenticated', OWNER, async () => {
        await rejection(
          db.query("INSERT INTO tool_execution_states (chat_id, message_id, tool_call_id, tool_name, status, user_id) VALUES ($1, 1, 'planted', 't', 'completed', $2)", [CHAT_OWNER, OTHER]),
          /row-level security/i,
        );
        await rejection(
          db.query("INSERT INTO tool_execution_states (chat_id, message_id, tool_call_id, tool_name, status) VALUES ($1, 1, 'null-owner', 't', 'completed')", [CHAT_OWNER]),
          /row-level security/i,
        );
        await db.query("INSERT INTO tool_execution_states (chat_id, message_id, tool_call_id, tool_name, status, user_id) VALUES ($1, 1, 'mine', 't', 'pending', $2)", [CHAT_OWNER, OWNER]);
        assert.equal((await db.query("SELECT 1 FROM tool_execution_states WHERE tool_call_id = 'mine'")).rows.length, 1);
        await rejection(db.query("UPDATE tool_execution_states SET user_id = $1 WHERE tool_call_id = 'mine'", [OTHER]), /row-level security/i);
      });
    });

    test('nango_connections: a user cannot write connection_id directly; the service role can', async () => {
      await db.query("INSERT INTO nango_connections (user_id, connection_id, provider) VALUES ($1, 'conn-victim', 'notion')", [OTHER]);
      await asRole(db, 'authenticated', OWNER, async () => {
        assert.equal((await db.query('SELECT 1 FROM nango_connections')).rows.length, 0);
        await rejection(db.query("INSERT INTO nango_connections (user_id, connection_id, provider) VALUES ($1, 'conn-victim-2', 'dropbox')", [OWNER]), /permission denied/i);
        await rejection(db.query("UPDATE nango_connections SET connection_id = 'conn-victim' WHERE user_id = $1", [OWNER]), /permission denied/i);
      });
      await asRole(db, 'service_role', null, async () => {
        await db.query("INSERT INTO nango_connections (user_id, connection_id, provider) VALUES ($1, 'conn-server', 'dropbox')", [OWNER]);
      });
    });

    test('LO-07 premise: through RLS an organization admin cannot read the owner row or update roles, the service role can', async () => {
      const throughRls = (sql: string, params: unknown[]) =>
        db.query(sql, params).then(
          (result) => result.rows.length,
          (error: Error) => (/infinite recursion/i.test(error.message) ? 'policy-error' : Promise.reject(error)),
        );
      await asRole(db, 'authenticated', ADMIN, async () => {
        const read = await throughRls('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [ORG, OWNER]);
        assert.equal(read, 0, `owner row visible to an organization admin: ${String(read)}`);
        const write = await throughRls("UPDATE organization_members SET role = 'viewer' WHERE organization_id = $1 AND user_id = $2 RETURNING user_id", [ORG, MEMBER]);
        assert.equal(write, 0, `role updated through RLS: ${String(write)}`);
      });
      await asRole(db, 'service_role', null, async () => {
        assert.equal((await db.query<{ role: string }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [ORG, OWNER])).rows[0].role, 'owner');
      });
    });

    test('functions that trusted a caller-supplied id are not executable by anon or authenticated, and work for service_role', async () => {
      const result = await db.query<{ proname: string; anon: boolean; authenticated: boolean; service_role: boolean; public_exec: boolean }>(
        `SELECT p.proname,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), true) AS public_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
        [['get_workspace_context', 'get_user_org_ids', 'get_admin_organization_id']],
      );
      assert.equal(result.rows.length, 3);
      for (const row of result.rows) {
        assert.equal(row.anon, false, `${row.proname} executable by anon`);
        assert.equal(row.authenticated, false, `${row.proname} executable by authenticated`);
        assert.equal(row.public_exec, false, `${row.proname} executable by PUBLIC`);
        assert.equal(row.service_role, true, `${row.proname} not executable by service_role`);
      }
      await asRole(db, 'service_role', null, async () => {
        assert.equal((await db.query('SELECT * FROM get_user_org_ids($1)', [OWNER])).rows.length, 1);
      });
    });

    test('is_org_member, get_nango_stats and is_subscribed answer only for the caller', async () => {
      await asRole(db, 'authenticated', OTHER, async () => {
        assert.equal((await db.query<{ ok: boolean }>('SELECT is_org_member($1, $2) AS ok', [ORG, OWNER])).rows[0].ok, false);
        assert.equal((await db.query('SELECT * FROM get_nango_stats($1)', [OTHER])).rows.length, 1);
        assert.equal((await db.query('SELECT * FROM get_nango_stats($1)', [OWNER])).rows.length, 0);
        assert.equal((await db.query<{ ok: boolean }>('SELECT is_subscribed($1) AS ok', [OWNER])).rows[0].ok, false);
      });
      await asRole(db, 'authenticated', OWNER, async () => {
        assert.equal((await db.query<{ ok: boolean }>('SELECT is_org_member($1, $2) AS ok', [ORG, OWNER])).rows[0].ok, true);
      });
      await asRole(db, 'anon', null, async () => {
        await rejection(db.query('SELECT * FROM get_nango_stats($1)', [OTHER]), /permission denied/i);
        await rejection(db.query('SELECT is_admin($1)', [ADMIN]), /permission denied/i);
      });
    });

    test('create_organization_safe creates only for the caller', async () => {
      await asRole(db, 'authenticated', OTHER, async () => {
        await rejection(db.query("SELECT * FROM create_organization_safe('Mine', 'impersonated', $1, true)", [OWNER]), /Not authorized/i);
        const own = await db.query<{ owner_id: string }>("SELECT * FROM create_organization_safe('Mine', 'mine-own', $1, true)", [OTHER]);
        assert.equal(own.rows[0].owner_id, OTHER);
      });
      await asRole(db, 'anon', null, async () => {
        await rejection(db.query("SELECT * FROM create_organization_safe('Anon', 'anon-org', $1, true)", [OWNER]), /permission denied/i);
      });
    });

    test('organization_members and organizations can be queried as a user without a recursion error; each caller sees only their own orgs and members', async () => {
      const memberRows = async () =>
        (await db.query<{ organization_id: string; user_id: string }>('SELECT organization_id, user_id FROM organization_members')).rows;
      const orgIds = async () => (await db.query<{ id: string }>('SELECT id FROM organizations')).rows.map((row) => row.id);

      await asRole(db, 'authenticated', OWNER, async () => {
        const rows = await memberRows();
        assert.equal(rows.length, 3);
        assert.ok(rows.every((row) => row.organization_id === ORG));
        assert.deepEqual(await orgIds(), [ORG]);
      });
      await asRole(db, 'authenticated', ADMIN, async () => {
        const rows = await memberRows();
        assert.deepEqual(rows.map((row) => row.user_id), [ADMIN]);
        assert.deepEqual(await orgIds(), [ORG]);
      });
      await asRole(db, 'authenticated', MEMBER, async () => {
        const rows = await memberRows();
        assert.deepEqual(rows.map((row) => row.user_id), [MEMBER]);
        assert.deepEqual(await orgIds(), [ORG]);
      });
      await asRole(db, 'authenticated', OTHER, async () => {
        const rows = await memberRows();
        assert.ok(rows.length >= 1);
        assert.ok(rows.every((row) => row.organization_id !== ORG && row.user_id === OTHER));
        assert.ok(!(await orgIds()).includes(ORG));
        assert.ok((await orgIds()).includes(ORG_B));
      });
      await asRole(db, 'authenticated', STRANGER, async () => {
        assert.equal((await memberRows()).length, 0);
        assert.equal((await orgIds()).length, 0);
        assert.equal((await db.query('SELECT 1 FROM organization_members WHERE organization_id = $1', [ORG])).rows.length, 0);
      });
      await asRole(db, 'anon', null, async () => {
        assert.equal((await memberRows()).length, 0);
        assert.equal((await orgIds()).length, 0);
      });
    });

    test('tables whose policies read organizations or organization_members no longer error and stay tenant scoped', async () => {
      await asRole(db, 'authenticated', MEMBER, async () => {
        assert.deepEqual((await db.query<{ organization_id: string }>('SELECT organization_id FROM team_invitations')).rows.map((row) => row.organization_id), [ORG]);
        assert.deepEqual((await db.query<{ organization_id: string }>('SELECT organization_id FROM organization_domains')).rows.map((row) => row.organization_id), [ORG]);
        assert.equal((await db.query('SELECT 1 FROM tenant_usage')).rows.length, 0);
        assert.equal((await db.query('SELECT 1 FROM api_usage_logs')).rows.length, 0);
      });
      await asRole(db, 'authenticated', STRANGER, async () => {
        assert.equal((await db.query('SELECT 1 FROM team_invitations')).rows.length, 0);
        assert.equal((await db.query('SELECT 1 FROM organization_domains')).rows.length, 0);
      });
    });

    test('organization write rules are unchanged: members insert and delete only as the owner, organizations update only by owner or admin', async () => {
      await asRole(db, 'authenticated', MEMBER, async () => {
        await rejection(db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG, STRANGER]), /row-level security/i);
        assert.equal((await db.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2 RETURNING user_id', [ORG, ADMIN])).rows.length, 0);
        assert.equal((await db.query("UPDATE organizations SET name = 'x' WHERE id = $1 RETURNING id", [ORG])).rows.length, 0);
      });
      await asRole(db, 'authenticated', ADMIN, async () => {
        await rejection(db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG, STRANGER]), /row-level security/i);
        assert.equal((await db.query("UPDATE organizations SET name = 'Org renamed' WHERE id = $1 RETURNING id", [ORG])).rows.length, 1);
        assert.equal((await db.query("UPDATE organizations SET name = 'x' WHERE id = $1 RETURNING id", [ORG_B])).rows.length, 0);
      });
      await asRole(db, 'authenticated', STRANGER, async () => {
        await rejection(db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')", [ORG, STRANGER]), /row-level security/i);
        assert.equal((await db.query("UPDATE organizations SET name = 'x' WHERE id = $1 RETURNING id", [ORG])).rows.length, 0);
      });
      await asRole(db, 'authenticated', OWNER, async () => {
        await rejection(db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG_B, STRANGER]), /row-level security/i);
        const added = await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'viewer') RETURNING user_id", [ORG, STRANGER]);
        assert.equal(added.rows.length, 1);
        assert.equal((await db.query('SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2', [ORG, STRANGER])).rows.length, 1);
        assert.equal((await db.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2 RETURNING user_id', [ORG, STRANGER])).rows.length, 1);
        assert.equal((await db.query('DELETE FROM organization_members WHERE organization_id = $1 RETURNING user_id', [ORG_B])).rows.length, 0);
      });
      await asRole(db, 'authenticated', STRANGER, async () => {
        assert.equal((await db.query('SELECT 1 FROM organization_members WHERE organization_id = $1', [ORG])).rows.length, 0);
      });
    });

    test('is_org_owner and is_org_admin answer only for the calling user', async () => {
      const ask = async (fn: string, org: string) => (await db.query<{ ok: boolean }>(`SELECT ${fn}($1) AS ok`, [org])).rows[0].ok;
      await asRole(db, 'authenticated', OWNER, async () => {
        assert.equal(await ask('is_org_owner', ORG), true);
        assert.equal(await ask('is_org_admin', ORG), true);
        assert.equal(await ask('is_org_owner', ORG_B), false);
      });
      await asRole(db, 'authenticated', ADMIN, async () => {
        assert.equal(await ask('is_org_owner', ORG), false);
        assert.equal(await ask('is_org_admin', ORG), true);
      });
      await asRole(db, 'authenticated', MEMBER, async () => {
        assert.equal(await ask('is_org_admin', ORG), false);
      });
      await asRole(db, 'anon', null, async () => {
        assert.equal(await ask('is_org_owner', ORG), false);
        assert.equal(await ask('is_org_admin', ORG), false);
      });
      const result = await db.query<{ proname: string; public_exec: boolean; secdef: boolean; config: string[] | null }>(
        `SELECT p.proname, p.prosecdef AS secdef, p.proconfig AS config,
                COALESCE((SELECT bool_or(a.grantee = 0) FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), true) AS public_exec
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname IN ('is_org_owner', 'is_org_admin')`,
      );
      assert.equal(result.rows.length, 2);
      for (const row of result.rows) {
        assert.equal(row.secdef, true);
        assert.equal(row.public_exec, false);
        assert.ok(row.config?.some((entry) => entry.startsWith('search_path=')), `${row.proname} has no fixed search_path`);
      }
    });

    test('the memberships RLS policies still evaluate for a member through the bound is_org_member', async () => {
      await db.query(
        "INSERT INTO documents (id, filename, content, user_id, organization_id) VALUES ($1, 'org.md', 'org', $2, $3)",
        ['00000000-0000-4000-8000-00000000f301', OWNER, ORG],
      );
      await asRole(db, 'authenticated', MEMBER, async () => {
        const rows = await db.query('SELECT id FROM documents WHERE organization_id = $1', [ORG]);
        assert.equal(rows.rows.length, 1);
      });
      await asRole(db, 'authenticated', OTHER, async () => {
        assert.equal((await db.query('SELECT id FROM documents WHERE organization_id = $1', [ORG])).rows.length, 0);
      });
    });
  });
}

multiTenantSuite('fresh setup file', () => createFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: CORPUS_DIR, supabaseGrants: true }));

multiTenantSuite('existing database after the patch, applied twice', async () => {
  const fixture = await createFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: CORPUS_DIR, supabaseGrants: true });
  await fixture.db.exec(MULTI_OLD_STATE);
  await fixture.db.exec(MULTI_RECURSIVE_ORG_POLICIES_OLD_STATE);
  await fixture.db.exec(read('supabase/patches/2026-11-security-review-multi-tenant.sql'));
  await fixture.db.exec(read('supabase/patches/2026-11-security-review-multi-tenant.sql'));
  return fixture;
});

describe('the old organizations / organization_members policies recursed (guards the fix test)', () => {
  test('before the fix a user-client query on organization_members fails with infinite recursion', async () => {
    const fixture = await createFixtureDatabase({ deploymentMode: 'multi-tenant', corpusDir: CORPUS_DIR, supabaseGrants: true });
    try {
      await fixture.db.exec(MULTI_RECURSIVE_ORG_POLICIES_OLD_STATE);
      await seedMulti(fixture.db);
      await asRole(fixture.db, 'authenticated', OWNER, async () => {
        await rejection(fixture.db.query('SELECT 1 FROM organization_members'), /infinite recursion/i);
        await rejection(fixture.db.query('SELECT 1 FROM organizations'), /infinite recursion/i);
      });
    } finally {
      await fixture.db.close();
    }
  });
});

function dedupeBlock(file: string): string {
  const sql = read(file);
  const start = sql.indexOf('DO $$\nDECLARE\n  removed integer;');
  assert.ok(start > 0, `${file} has no dedupe block`);
  const end = sql.indexOf('END $$;', start);
  return sql.slice(start, end + 'END $$;'.length);
}

for (const [mode, file] of [
  ['single-tenant', 'supabase/single-tenant-setup.sql'],
  ['multi-tenant', 'supabase/multi-tenant-setup.sql'],
  ['single-tenant patch', 'supabase/patches/2026-11-security-review-single-tenant.sql'],
  ['multi-tenant patch', 'supabase/patches/2026-11-security-review-multi-tenant.sql'],
] as const) {
  describe(`LO-06 duplicate nango connection_id rows (${mode})`, () => {
    test('duplicates are reduced to the oldest row per connection_id and the constraint is added, on every run', async () => {
      const fixture = await createFixtureDatabase({
        deploymentMode: mode.startsWith('single') ? 'single-tenant' : 'multi-tenant',
        corpusDir: CORPUS_DIR,
        supabaseGrants: true,
      });
      const { db } = fixture;
      try {
        await insertUsers(db, [OWNER, OTHER]);
        await db.exec('ALTER TABLE nango_connections DROP CONSTRAINT unique_nango_connection_id');
        await db.query(
          `INSERT INTO nango_connections (id, user_id, connection_id, provider, created_at) VALUES
             ('00000000-0000-4000-8000-00000000a001', $1, 'dup', 'notion', '2025-01-01T00:00:00Z'),
             ('00000000-0000-4000-8000-00000000a002', $2, 'dup', 'notion', '2025-02-01T00:00:00Z'),
             ('00000000-0000-4000-8000-00000000a003', $2, 'dup', 'dropbox', '2025-02-01T00:00:00Z'),
             ('00000000-0000-4000-8000-00000000a004', $2, 'solo', 'google-drive', '2025-03-01T00:00:00Z')`,
          [OWNER, OTHER],
        );
        const block = dedupeBlock(file);
        await db.exec(block);
        await db.exec(block);
        const rows = await db.query<{ id: string }>('SELECT id FROM nango_connections ORDER BY id');
        assert.deepEqual(rows.rows.map((row) => row.id), ['00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000a004']);
        await rejection(
          db.query("INSERT INTO nango_connections (user_id, connection_id, provider) VALUES ($1, 'dup', 'dropbox')", [OTHER]),
          /unique_nango_connection_id/i,
        );
      } finally {
        await db.close();
      }
    });
  });
}
