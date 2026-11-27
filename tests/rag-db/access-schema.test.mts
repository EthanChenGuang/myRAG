import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrations } from '../../eval/harness/migrations.mts';

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const CORPUS_DIR = path.resolve(import.meta.dirname, '../../eval/fixtures/corpus');

const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const MEMBER_A = id('9201', 1);
const MEMBER_B = id('9201', 2);
const OUTSIDER = id('9201', 3);
const LEAVER = id('9201', 4);
const ORG = id('9202', 1);
const OTHER_ORG = id('9202', 2);

const TABLES = [
  'rag_access_groups',
  'rag_access_group_members',
  'rag_access_group_settings',
  'rag_connector_group_map',
  'rag_connector_sharing_rules',
  'rag_connector_document_principals',
  'rag_access_security_events',
  'rag_access_audit',
] as const;

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

async function rejects(run: () => Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.match(error instanceof Error ? error.message : String(error), pattern, label);
    return true;
  });
}

async function build(mode: DeploymentMode): Promise<FixtureDatabase> {
  const fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS_DIR, supabaseGrants: true });
  const { db } = fixture;
  await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8) ON CONFLICT DO NOTHING', [
    MEMBER_A,
    'member-a@example.invalid',
    MEMBER_B,
    'member-b@example.invalid',
    OUTSIDER,
    'outsider@example.invalid',
    LEAVER,
    'leaver@example.invalid',
  ]);
  if (mode === 'multi-tenant') {
    await db.query(
      "INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace one', 'access-one', $3, false), ($2, 'Workspace two', 'access-two', $4, false)",
      [ORG, OTHER_ORG, MEMBER_A, OUTSIDER],
    );
    await db.query(
      "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $3, 'owner'), ($1, $4, 'member'), ($1, $5, 'member'), ($2, $6, 'owner')",
      [ORG, OTHER_ORG, MEMBER_A, MEMBER_B, LEAVER, OUTSIDER],
    );
  }
  return fixture;
}

const TENANT: Record<DeploymentMode, string> = { 'single-tenant': 's:default', 'multi-tenant': `o:${ORG}` };

async function createGroup(db: PGlite, mode: DeploymentMode, key: string, org: string = ORG): Promise<string> {
  const result =
    mode === 'multi-tenant'
      ? await db.query<{ id: string }>("INSERT INTO rag_access_groups (key, name, organization_id) VALUES ($1, 'Group', $2) RETURNING id", [key, org])
      : await db.query<{ id: string }>("INSERT INTO rag_access_groups (key, name) VALUES ($1, 'Group') RETURNING id", [key]);
  return result.rows[0]!.id;
}

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  describe(`access group stores (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;
    let groupA: string;
    let groupB: string;

    before(async () => {
      fixture = await build(mode);
      db = fixture.db;
      groupA = await createGroup(db, mode, 'group-a');
      groupB = await createGroup(db, mode, 'group-b');
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2), ($3, $4)', [groupA, MEMBER_A, groupB, MEMBER_B]);
    });

    after(async () => {
      await db?.close();
    });

    test('a group is bound to the tenant of the deployment mode', async () => {
      const row = (await db.query<Row>('SELECT tenant_key, source FROM rag_access_groups WHERE id = $1', [groupA])).rows[0];
      assert.equal(row?.tenant_key, TENANT[mode]);
      assert.equal(row?.source, 'manual');
      if (mode === 'multi-tenant') {
        await rejects(() => db.query("INSERT INTO rag_access_groups (key, name) VALUES ('group-c', 'Group')"), /null value|not-null/i, 'organization required');
      }
    });

    test('the key is unique per tenant, never all, lower case and immutable', async () => {
      await rejects(() => createGroup(db, mode, 'group-a'), /duplicate key|unique/i, 'duplicate key');
      await rejects(() => createGroup(db, mode, 'all'), /rag_access_groups_key_reserved_check/, 'reserved key');
      await rejects(() => createGroup(db, mode, 'Group-a'), /rag_access_groups_key_check/, 'upper case');
      await rejects(() => createGroup(db, mode, '-group'), /rag_access_groups_key_check/, 'leading hyphen');
      await rejects(() => db.query("UPDATE rag_access_groups SET key = 'group-z' WHERE id = $1", [groupA]), /access_group_key_immutable/, 'key update');
      await db.query("UPDATE rag_access_groups SET name = 'Renamed' WHERE id = $1", [groupA]);
      if (mode === 'multi-tenant') {
        const otherTenantGroup = await createGroup(db, mode, 'group-a', OTHER_ORG);
        assert.ok(otherTenantGroup, 'the same key in another tenant is allowed');
        await rejects(
          () => db.query('UPDATE rag_access_groups SET organization_id = $2 WHERE id = $1', [groupB, OTHER_ORG]),
          /access_group_tenant_immutable/,
          'tenant update',
        );
      }
    });

    test('members are accepted; in multi-tenant mode only workspace members, and leaving the workspace removes memberships', async () => {
      const members = (await db.query<Row>('SELECT user_id FROM rag_access_group_members WHERE group_id = $1', [groupA])).rows;
      assert.deepEqual(members.map((row) => row.user_id), [MEMBER_A]);
      if (mode === 'multi-tenant') {
        await rejects(
          () => db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [groupA, OUTSIDER]),
          /not_a_workspace_member/,
          'outsider',
        );
        await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $3), ($2, $3)', [groupA, groupB, LEAVER]);
        await db.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [ORG, LEAVER]);
        const left = await db.query('SELECT 1 FROM rag_access_group_members WHERE user_id = $1', [LEAVER]);
        assert.equal(left.rows.length, 0);
        const kept = await db.query('SELECT 1 FROM rag_access_group_members WHERE user_id = ANY($1::uuid[])', [[MEMBER_A, MEMBER_B]]);
        assert.equal(kept.rows.length, 2, 'other members keep their memberships');
      } else {
        await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [groupA, OUTSIDER]);
        await db.query('DELETE FROM rag_access_group_members WHERE group_id = $1 AND user_id = $2', [groupA, OUTSIDER]);
      }
    });

    test('an authenticated user reads only their own memberships and no group row; anon reads neither', async () => {
      await asRole(db, 'authenticated', MEMBER_A, async () => {
        const own = (await db.query<Row>('SELECT user_id, group_id FROM rag_access_group_members')).rows;
        assert.deepEqual(own, [{ user_id: MEMBER_A, group_id: groupA }]);
        await rejects(() => db.query('SELECT * FROM rag_access_groups'), /permission denied/, 'groups');
        await rejects(() => db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [groupB, MEMBER_A]), /permission denied/, 'self-add');
      });
      await asRole(db, 'authenticated', OUTSIDER, async () => {
        assert.equal((await db.query('SELECT * FROM rag_access_group_members')).rows.length, 0);
      });
      await asRole(db, 'anon', null, async () => {
        await rejects(() => db.query('SELECT * FROM rag_access_group_members'), /permission denied/, 'anon members');
        await rejects(() => db.query('SELECT * FROM rag_access_groups'), /permission denied/, 'anon groups');
      });
    });

    test('no other table of the block is readable or writable by anon or authenticated', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        await asRole(db, role, role === 'anon' ? null : MEMBER_A, async () => {
          for (const table of TABLES.filter((name) => name !== 'rag_access_group_members')) {
            await rejects(() => db.query(`SELECT * FROM public.${table}`), /permission denied/, `${role} ${table}`);
          }
        });
      }
      const policies = (await db.query<Row>(
        "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
        [[...TABLES]],
      )).rows;
      assert.deepEqual(policies, [{ tablename: 'rag_access_group_members', policyname: 'rag_access_group_members_select_own' }]);
      const rls = (await db.query<Row>("SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1::text[]) AND relrowsecurity", [[...TABLES]])).rows;
      assert.equal(rls.length, TABLES.length);
    });

    test('the settings table holds exactly one row, enforced false, also after a second apply', async () => {
      await applyMigrations(db, mode);
      const rows = (await db.query<Row>('SELECT id, enforced FROM rag_access_group_settings')).rows;
      assert.deepEqual(rows, [{ id: true, enforced: false }]);
      await rejects(() => db.query('INSERT INTO rag_access_group_settings (id, enforced) VALUES (true, true)'), /duplicate key/, 'second row');
      await rejects(() => db.query('INSERT INTO rag_access_group_settings (id, enforced) VALUES (false, true)'), /rag_access_group_settings_single_row/, 'false id');
    });

    test('a connector mapping names a group of its own tenant only and is unique per principal', async () => {
      const tenant = TENANT[mode];
      await db.query("INSERT INTO rag_connector_group_map (tenant_key, provider, external_principal_id, kind, group_id) VALUES ($1, 'google-drive', 'principal-1', 'group', $2)", [tenant, groupA]);
      await rejects(
        () => db.query("INSERT INTO rag_connector_group_map (tenant_key, provider, external_principal_id, kind, group_id) VALUES ($1, 'google-drive', 'principal-1', 'team', $2)", [tenant, groupB]),
        /duplicate key|unique/i,
        'duplicate principal',
      );
      const foreignTenant = mode === 'multi-tenant' ? `o:${OTHER_ORG}` : `u:${MEMBER_A}`;
      await rejects(
        () => db.query("INSERT INTO rag_connector_group_map (tenant_key, provider, external_principal_id, kind, group_id) VALUES ($1, 'dropbox', 'principal-2', 'team', $2)", [foreignTenant, groupA]),
        /cross_tenant_group/,
        'cross-tenant mapping',
      );
      await rejects(
        () => db.query("UPDATE rag_connector_group_map SET tenant_key = $1 WHERE external_principal_id = 'principal-1'", [foreignTenant]),
        /cross_tenant_group/,
        'cross-tenant update',
      );
      await rejects(
        () => db.query("INSERT INTO rag_connector_group_map (tenant_key, provider, external_principal_id, kind, group_id) VALUES ($1, 'dropbox', 'principal-3', 'user', $2)", [tenant, groupA]),
        /rag_connector_group_map_kind_check/,
        'person kind',
      );
    });

    test('sharing rules start off and a domain rule needs a dotted host name', async () => {
      const tenant = TENANT[mode];
      const created = (await db.query<Row>("INSERT INTO rag_connector_sharing_rules (tenant_key, provider, kind, domain) VALUES ($1, 'google-drive', 'domain', 'example.com') RETURNING enabled", [tenant])).rows[0];
      assert.equal(created?.enabled, false);
      await db.query("INSERT INTO rag_connector_sharing_rules (tenant_key, provider, kind) VALUES ($1, 'google-drive', 'anyone')", [tenant]);
      await rejects(() => db.query("INSERT INTO rag_connector_sharing_rules (tenant_key, provider, kind) VALUES ($1, 'google-drive', 'anyone')", [tenant]), /duplicate key/, 'duplicate rule');
      for (const domain of ['localhost', 'Example.com', 'bad_host.example', '.example.com', null]) {
        await rejects(
          () => db.query("INSERT INTO rag_connector_sharing_rules (tenant_key, provider, kind, domain) VALUES ($1, 'dropbox', 'domain', $2)", [tenant, domain]),
          /rag_connector_sharing_rules_domain_check/,
          `domain ${String(domain)}`,
        );
      }
      await rejects(
        () => db.query("INSERT INTO rag_connector_sharing_rules (tenant_key, provider, kind, domain) VALUES ($1, 'notion', 'public', 'example.com')", [tenant]),
        /rag_connector_sharing_rules_domain_check/,
        'domain on a link rule',
      );
    });

    test('document principals accept group, team, workspace, domain and link kinds, never a person', async () => {
      const tenant = TENANT[mode];
      const documentId = (await db.query<{ id: string }>('SELECT id FROM documents ORDER BY id LIMIT 1')).rows[0]!.id;
      for (const kind of ['group', 'team', 'workspace', 'domain', 'anyone', 'public']) {
        await db.query("INSERT INTO rag_connector_document_principals (document_id, tenant_key, provider, kind, external_principal_id) VALUES ($1, $2, 'google-drive', $3, $4)", [
          documentId,
          tenant,
          kind,
          kind === 'anyone' || kind === 'public' ? '' : `principal-${kind}`,
        ]);
      }
      const mapped = (await db.query<Row>('SELECT DISTINCT mapped FROM rag_connector_document_principals WHERE document_id = $1', [documentId])).rows;
      assert.deepEqual(mapped, [{ mapped: false }]);
      await rejects(
        () => db.query("INSERT INTO rag_connector_document_principals (document_id, tenant_key, provider, kind, external_principal_id) VALUES ($1, $2, 'google-drive', 'user', 'principal-user')", [documentId, tenant]),
        /rag_connector_document_principals_kind_check/,
        'person principal',
      );
    });

    test('security events and the access audit hold ids and codes, and service_role cannot change or delete a row', async () => {
      const tenant = TENANT[mode];
      const columns = (await db.query<{ table_name: string; column_name: string }>(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('rag_access_security_events', 'rag_access_audit')",
      )).rows;
      for (const { table_name, column_name } of columns) {
        assert.doesNotMatch(column_name, /content|text|query|answer|name|email|title/, `${table_name}.${column_name}`);
      }
      await asRole(db, 'service_role', null, async () => {
        await db.query("INSERT INTO rag_access_audit (tenant_key, action, actor, actor_kind, group_id, after_groups) VALUES ($1, 'member_add', NULL, 'connector', $2, ARRAY['all'])", [tenant, groupA]);
        await rejects(() => db.query("INSERT INTO rag_access_audit (tenant_key, action, actor_kind) VALUES ($1, 'unknown_action', 'admin')", [tenant]), /rag_access_audit_action_check/, 'action');
        await rejects(() => db.query("INSERT INTO rag_access_audit (tenant_key, action, actor_kind) VALUES ($1, 'group_create', 'user')", [tenant]), /rag_access_audit_actor_kind_check/, 'actor kind');
        await rejects(() => db.query("UPDATE rag_access_audit SET reason = 'changed'"), /permission denied/, 'audit update');
        await rejects(() => db.query('DELETE FROM rag_access_audit'), /permission denied/, 'audit delete');

        await db.query("INSERT INTO rag_access_security_events (tenant_key, user_id, event, chunk_ids, document_ids, request_id) VALUES ($1, $2, 'citation_access_violation', ARRAY[$3::uuid], ARRAY[$4::uuid], 'req-1')", [
          tenant,
          MEMBER_B,
          id('9203', 1),
          id('9204', 1),
        ]);
        await rejects(() => db.query("INSERT INTO rag_access_security_events (tenant_key, event) VALUES ($1, 'other_event')", [tenant]), /rag_access_security_events_event_check/, 'event');
        await rejects(() => db.query('UPDATE rag_access_security_events SET request_id = NULL'), /permission denied/, 'event update');
        await rejects(() => db.query('DELETE FROM rag_access_security_events'), /permission denied/, 'event delete');
      });
      const audit = (await db.query<Row>("SELECT actor, actor_kind FROM rag_access_audit WHERE action = 'member_add'")).rows;
      assert.deepEqual(audit, [{ actor: null, actor_kind: 'connector' }]);
    });

    test('deleting a group removes its members and mappings; audit rows keep the group id', async () => {
      const groupC = await createGroup(db, mode, 'group-c');
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [groupC, MEMBER_B]);
      await db.query("INSERT INTO rag_connector_group_map (tenant_key, provider, external_principal_id, kind, group_id) VALUES ($1, 'notion', 'principal-c', 'workspace', $2)", [TENANT[mode], groupC]);
      await db.query("INSERT INTO rag_access_audit (tenant_key, action, actor_kind, group_id) VALUES ($1, 'group_delete', 'system', $2)", [TENANT[mode], groupC]);
      await db.query('DELETE FROM rag_access_groups WHERE id = $1', [groupC]);
      assert.equal((await db.query('SELECT 1 FROM rag_access_group_members WHERE group_id = $1', [groupC])).rows.length, 0);
      assert.equal((await db.query('SELECT 1 FROM rag_connector_group_map WHERE group_id = $1', [groupC])).rows.length, 0);
      assert.equal((await db.query('SELECT 1 FROM rag_access_audit WHERE group_id = $1', [groupC])).rows.length, 1);
    });
  });
}
