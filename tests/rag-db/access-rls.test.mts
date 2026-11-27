import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';

// Phase 4.3 plan 06 (SEC-12; D-09, D-15, A-01, A-02): restrictive SELECT policies on documents, document_chunks and document_parents narrow
// direct client reads (anon key or a user token) to the caller's access keys while enforcement is on, give the tenant's admins every row,
// and change nothing while it is off. The flag-off baseline is read on the same rows before 0923 is applied. Neutral synthetic fixtures.

type Role = 'anon' | 'authenticated';
type Row = Record<string, unknown>;

const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const ADMIN = id('9631', 1);
const MEMBER_A = id('9631', 2);
const MEMBER_B = id('9631', 3);
const OUTSIDER = id('9631', 4);
const OTHER_ADMIN = id('9631', 5);
const ORG = id('9632', 1);
const OTHER_ORG = id('9632', 2);

const DOC_ALL = id('9633', 1);
const DOC_A = id('9633', 2);
const DOC_B = id('9633', 3);
const DOC_OTHER = id('9633', 4);

const RLS_FILE = /\/0923_access_rls(\.(single|multi)-tenant)?\.sql$/;

async function rows<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

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

interface Reads {
  documents: string[];
  chunks: string[];
  parents: string[];
}

const SEEDED = [DOC_ALL, DOC_A, DOC_B, DOC_OTHER];

async function readAll(db: PGlite, role: Role, userId: string | null): Promise<Reads> {
  return asRole(db, role, userId, async () => {
    const pick = async (sql: string): Promise<string[]> => (await rows<{ id: string }>(db, sql, [SEEDED])).map((row) => String(row.id)).sort();
    return {
      documents: await pick('SELECT id FROM public.documents WHERE id = ANY($1::uuid[])'),
      chunks: await pick('SELECT document_id AS id FROM public.document_chunks WHERE document_id = ANY($1::uuid[])'),
      parents: await pick('SELECT document_id AS id FROM public.document_parents WHERE document_id = ANY($1::uuid[])'),
    };
  });
}

const same = (docs: string[]): Reads => {
  const sorted = [...docs].sort();
  return { documents: sorted, chunks: sorted, parents: sorted };
};

async function setEnforced(db: PGlite, enforced: boolean): Promise<void> {
  await db.query('UPDATE public.rag_access_group_settings SET enforced = $1 WHERE id', [enforced]);
}

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  describe(`direct client reads follow access groups (${mode})`, () => {
    const multi = mode === 'multi-tenant';
    let db: PGlite;
    let groupA = '';
    let groupB = '';
    const callers: Array<{ label: string; role: Role; user: string | null }> = [
      { label: 'anon', role: 'anon', user: null },
      { label: 'admin', role: 'authenticated', user: ADMIN },
      { label: 'member-a', role: 'authenticated', user: MEMBER_A },
      { label: 'member-b', role: 'authenticated', user: MEMBER_B },
      { label: 'outsider', role: 'authenticated', user: OUTSIDER },
      ...(multi ? [{ label: 'admin of another organization', role: 'authenticated' as Role, user: OTHER_ADMIN }] : []),
    ];
    const baseline = new Map<string, Reads>();

    async function seedDocument(doc: string, groups: string[], org: string | null): Promise<void> {
      const tenantKey = multi ? `o:${org}` : 's:default';
      await db.query(
        `INSERT INTO public.documents (id, filename, content, status, is_current, source, source_key, lineage_id${multi ? ', user_id, organization_id' : ''})
         VALUES ($1::uuid, $2, 'Neutral synthetic record body.', 'ready', true, 'config_upload', $3, $1::uuid${multi ? ', $4, $5' : ''})`,
        multi ? [doc, `${doc}.md`, `root/${doc}`, ADMIN, org] : [doc, `${doc}.md`, `root/${doc}`],
      );
      await db.query(
        `INSERT INTO public.document_chunks (id, document_id, content, chunk_index, status, is_current${multi ? ', organization_id' : ''})
         VALUES (gen_random_uuid(), $1, 'Neutral synthetic sentence of the record.', 0, 'ready', true${multi ? ', $2' : ''})`,
        multi ? [doc, org] : [doc],
      );
      await db.query(
        `INSERT INTO public.document_parents (id, document_id, tenant_key, organization_id, chunking_profile_id, content, token_count, parent_index)
         VALUES (gen_random_uuid(), $1, $2, $3, 'legacy', 'Neutral synthetic parent section.', 4, 0)`,
        [doc, tenantKey, org],
      );
      await db.query('UPDATE public.documents SET access_groups = $2::text[] WHERE id = $1', [doc, groups]);
    }

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true, migrations: false })).db;
      const files = migrationFiles(mode);
      const rlsFiles = files.filter((file) => RLS_FILE.test(file));
      await applyMigrationFiles(db, files.filter((file) => !RLS_FILE.test(file)));

      const users = [ADMIN, MEMBER_A, MEMBER_B, OUTSIDER, OTHER_ADMIN];
      for (const user of users) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, `${user.slice(-4)}@example.invalid`]);
      }
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'access-rls', $2, false)", [ORG, ADMIN]);
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Other', 'access-rls-other', $2, false)", [OTHER_ORG, OTHER_ADMIN]);
        await db.query(
          `INSERT INTO organization_members (organization_id, user_id, role) VALUES
             ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'member'), ($2, $7, 'owner')
           ON CONFLICT DO NOTHING`,
          [ORG, OTHER_ORG, ADMIN, MEMBER_A, MEMBER_B, OUTSIDER, OTHER_ADMIN],
        );
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-a', 'Group', $1) RETURNING id", [ORG]))[0]!.id;
        groupB = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-b', 'Group', $1) RETURNING id", [ORG]))[0]!.id;
      } else {
        await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [ADMIN]);
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name) VALUES ('group-a', 'Group') RETURNING id"))[0]!.id;
        groupB = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name) VALUES ('group-b', 'Group') RETURNING id"))[0]!.id;
      }
      await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2), ($3, $4)', [groupA, MEMBER_A, groupB, MEMBER_B]);

      await seedDocument(DOC_ALL, ['all'], multi ? ORG : null);
      await seedDocument(DOC_A, [`g:${groupA}`], multi ? ORG : null);
      await seedDocument(DOC_B, [`g:${groupB}`], multi ? ORG : null);
      if (multi) {
        const otherGroup = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-o', 'Group', $1) RETURNING id", [OTHER_ORG]))[0]!.id;
        await seedDocument(DOC_OTHER, [`g:${otherGroup}`], OTHER_ORG);
      } else {
        await seedDocument(DOC_OTHER, [`u:${OUTSIDER}`], null);
      }

      for (const caller of callers) baseline.set(caller.label, await readAll(db, caller.role, caller.user));
      await applyMigrationFiles(db, rlsFiles);
    });

    after(async () => {
      await setEnforced(db, false).catch(() => undefined);
      await db?.close();
    });

    test('the 0923 files exist for this mode', () => {
      const names = migrationFiles(mode).filter((file) => RLS_FILE.test(file));
      assert.deepEqual(names.map((file) => file.split('/').pop()), ['0923_access_rls.sql', `0923_access_rls.${mode}.sql`]);
    });

    test('with enforcement off every caller reads exactly the rows it read before 0923', async () => {
      await setEnforced(db, false);
      for (const caller of callers) {
        assert.deepEqual(await readAll(db, caller.role, caller.user), baseline.get(caller.label), caller.label);
      }
      const anonBefore = baseline.get('anon')!;
      if (multi) assert.deepEqual(anonBefore, same([]), 'multi-tenant anon reads nothing today');
      else assert.deepEqual(anonBefore, same([DOC_ALL, DOC_A, DOC_B, DOC_OTHER]), 'single-tenant anon reads every ready document today');
    });

    test('with enforcement on each caller reads only its groups, and the admin reads every document of the tenant', async () => {
      await setEnforced(db, true);
      try {
        const expected: Record<string, Reads> = multi
          ? {
              anon: same([]),
              admin: same([DOC_ALL, DOC_A, DOC_B]),
              'member-a': same([DOC_ALL, DOC_A]),
              'member-b': same([DOC_ALL, DOC_B]),
              outsider: same([DOC_ALL]),
              'admin of another organization': same([DOC_ALL, DOC_OTHER]),
            }
          : {
              anon: same([DOC_ALL]),
              admin: same([DOC_ALL, DOC_A, DOC_B, DOC_OTHER]),
              'member-a': same([DOC_ALL, DOC_A]),
              'member-b': same([DOC_ALL, DOC_B]),
              outsider: same([DOC_ALL, DOC_OTHER]),
            };
        for (const caller of callers) {
          assert.deepEqual(await readAll(db, caller.role, caller.user), expected[caller.label], caller.label);
        }
      } finally {
        await setEnforced(db, false);
      }
    });

    test('a restricted row is invisible by id to anon and to an outsider while enforcement is on', async () => {
      await setEnforced(db, true);
      try {
        for (const [role, user] of [['anon', null], ['authenticated', OUTSIDER]] as Array<[Role, string | null]>) {
          await asRole(db, role, user, async () => {
            assert.equal((await rows(db, 'SELECT 1 FROM public.documents WHERE id = $1', [DOC_A])).length, 0, `${role} document`);
            assert.equal((await rows(db, 'SELECT 1 FROM public.document_chunks WHERE document_id = $1', [DOC_A])).length, 0, `${role} chunk`);
            assert.equal((await rows(db, 'SELECT 1 FROM public.document_parents WHERE document_id = $1', [DOC_A])).length, 0, `${role} parent`);
          });
        }
      } finally {
        await setEnforced(db, false);
      }
    });

    test('the policy helpers are evaluated once per statement as InitPlans', async () => {
      await setEnforced(db, true);
      try {
        for (const table of ['documents', 'document_chunks', 'document_parents']) {
          const plan = await asRole(db, 'authenticated', MEMBER_A, async () =>
            (await rows<{ 'QUERY PLAN': string }>(db, `EXPLAIN SELECT id FROM public.${table}`)).map((row) => row['QUERY PLAN']).join('\n'),
          );
          assert.match(plan, /InitPlan/, `${table} plan`);
          assert.doesNotMatch(plan, /rag_caller_access_keys\(\)\)\s*$/m, `${table}: keys helper is not a per-row filter call`);
        }
      } finally {
        await setEnforced(db, false);
      }
    });

    test('restrictive policies are added next to the existing ones, which stay unchanged', async () => {
      const policies = await rows<{ tablename: string; policyname: string; permissive: string; roles: string[] }>(
        db,
        `SELECT tablename, policyname, permissive, roles::text[] AS roles FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename IN ('documents', 'document_chunks', 'document_parents') AND cmd = 'SELECT'
         ORDER BY tablename, policyname`,
      );
      for (const table of ['documents', 'document_chunks', 'document_parents']) {
        const restrictive = policies.filter((p) => p.tablename === table && p.permissive === 'RESTRICTIVE');
        assert.equal(restrictive.length, 1, `${table}: one restrictive policy`);
        assert.equal(restrictive[0]!.policyname, 'rag_access_groups_restrict');
        assert.deepEqual([...restrictive[0]!.roles].sort(), ['anon', 'authenticated']);
        assert.ok(policies.some((p) => p.tablename === table && p.permissive === 'PERMISSIVE'), `${table}: permissive read policy kept`);
      }
    });

    test('the helpers are callable by the client roles and read identity only from auth.uid()', async () => {
      const helpers = ['rag_access_enforced()', 'rag_caller_access_keys()', ...(multi ? [] : ['rag_caller_is_access_admin()'])];
      for (const role of ['anon', 'authenticated']) {
        for (const helper of helpers) {
          const granted = await rows<{ ok: boolean }>(db, `SELECT has_function_privilege($1, 'public.${helper}', 'EXECUTE') AS ok`, [role]);
          assert.equal(granted[0]?.ok, true, `${role} executes ${helper}`);
        }
      }
      const keys = async (user: string | null): Promise<string[]> =>
        asRole(db, user ? 'authenticated' : 'anon', user, async () =>
          [...(await rows<{ keys: string[] }>(db, 'SELECT public.rag_caller_access_keys() AS keys'))[0]!.keys].sort(),
        );
      assert.deepEqual(await keys(null), ['all']);
      assert.deepEqual(await keys(MEMBER_A), ['all', `g:${groupA}`, `u:${MEMBER_A}`].sort());
      assert.deepEqual(await keys(OUTSIDER), ['all', `u:${OUTSIDER}`].sort());
      if (!multi) {
        const isAdmin = async (user: string | null): Promise<boolean> =>
          asRole(db, user ? 'authenticated' : 'anon', user, async () => (await rows<{ ok: boolean }>(db, 'SELECT public.rag_caller_is_access_admin() AS ok'))[0]!.ok);
        assert.equal(await isAdmin(null), false);
        assert.equal(await isAdmin(ADMIN), true);
        assert.equal(await isAdmin(MEMBER_A), false);
      }
    });

    test('re-applying 0923 is idempotent', async () => {
      await applyMigrationFiles(db, migrationFiles(mode).filter((file) => RLS_FILE.test(file)));
      await setEnforced(db, true);
      try {
        assert.deepEqual(await readAll(db, 'authenticated', MEMBER_A), same([DOC_ALL, DOC_A]));
      } finally {
        await setEnforced(db, false);
      }
    });
  });
}
