import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 plan 20 (SEC-12): the group administration functions of 0924 in both deployment modes. Group lifecycle with the counted, fail-closed
// deletion (D-01, D-18, A-07), members and candidates (D-04, D-29), the caller's own groups (D-16) and the admin document view (D-17, D-28).
// Fixtures are neutral synthetic sentences.

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const CORPUS_DIR = path.resolve(import.meta.dirname, '../../eval/fixtures/corpus');

const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const ADMIN = id('9241', 1);
const MEMBER_A = id('9241', 2);
const MEMBER_B = id('9241', 3);
const OUTSIDER = id('9241', 4);
const OTHER_USER = id('9241', 5);
const ORG = id('9242', 1);
const OTHER_ORG = id('9242', 2);

const DOC = {
  oneV1: id('9243', 1),
  oneV2: id('9243', 2),
  two: id('9243', 3),
  orphan: id('9243', 4),
  open: id('9243', 5),
  other: id('9243', 6),
} as const;

const vec = (text: string): string => `[${embedText(text).join(',')}]`;

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

const service = <T>(db: PGlite, run: () => Promise<T>): Promise<T> => asRole(db, 'service_role', null, run);

async function rejects(run: () => Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.match(error instanceof Error ? error.message : String(error), pattern, label);
    return true;
  });
}

/** Asserts the function exists before calling it, so a missing function fails on an assertion. */
async function assertFunction(db: PGlite, name: string): Promise<void> {
  const found = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1",
    [name],
  );
  assert.equal(found.rows[0]?.n, 1, `public.${name} exists exactly once`);
}

interface Fixture {
  db: PGlite;
  multi: boolean;
  tenantKey: string;
  otherGroup: string | null;
}

async function insertDoc(
  db: PGlite,
  multi: boolean,
  doc: { id: string; text: string; groups: string[]; uploader?: string | null; org?: string; lineage?: string; version?: number; filename?: string },
): Promise<void> {
  const uploader = doc.uploader === undefined ? MEMBER_A : doc.uploader;
  const filename = doc.filename ?? `${doc.id}.md`;
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, language, access_groups, lineage_id, version${multi ? ', organization_id' : ''})
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 'en', $5::text[], $6, $7${multi ? ', $8' : ''})`,
    multi
      ? [doc.id, filename, doc.text, uploader, doc.groups, doc.lineage ?? doc.id, doc.version ?? 1, doc.org ?? ORG]
      : [doc.id, filename, doc.text, uploader, doc.groups, doc.lineage ?? doc.id, doc.version ?? 1],
  );
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata${multi ? ', organization_id' : ''})
     VALUES (gen_random_uuid(), $1, $2, $3::vector, 0, '{}'::jsonb${multi ? ', $4' : ''})`,
    multi ? [doc.id, doc.text, vec(doc.text), doc.org ?? ORG] : [doc.id, doc.text, vec(doc.text)],
  );
}

async function supersede(db: PGlite, oldId: string, newId: string): Promise<void> {
  await db.query('UPDATE documents SET is_current = false, superseded_by = $2 WHERE id = $1', [oldId, newId]);
  await db.query('UPDATE document_chunks SET is_current = false WHERE document_id = $1', [oldId]);
}

async function build(mode: DeploymentMode): Promise<Fixture> {
  const multi = mode === 'multi-tenant';
  const { db } = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS_DIR, supabaseGrants: true });
  const users: [string, string][] = [
    [ADMIN, 'admin-person@example.invalid'],
    [MEMBER_A, 'member-alpha@example.invalid'],
    [MEMBER_B, 'member-beta@example.invalid'],
    [OUTSIDER, 'outside-alpha@example.invalid'],
    [OTHER_USER, 'other-alpha@example.invalid'],
  ];
  for (const [user, email] of users) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, email]);
  }
  let otherGroup: string | null = null;
  if (multi) {
    await db.query(
      "INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace one', 'admin-one', $3, false), ($2, 'Workspace two', 'admin-two', $4, false)",
      [ORG, OTHER_ORG, ADMIN, OTHER_USER],
    );
    await db.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES
         ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($2, $7, 'owner'), ($2, $6, 'member')`,
      [ORG, OTHER_ORG, ADMIN, MEMBER_A, MEMBER_B, OUTSIDER, OTHER_USER],
    );
    otherGroup = (
      await db.query<{ id: string }>("INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-a', 'Other group', $1) RETURNING id", [OTHER_ORG])
    ).rows[0]!.id;
    await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [otherGroup, OUTSIDER]);
    await insertDoc(db, multi, { id: DOC.other, text: 'A neutral synthetic record of another workspace.', groups: [`g:${otherGroup}`], org: OTHER_ORG, uploader: OTHER_USER });
  } else {
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
  }
  return { db, multi, tenantKey: multi ? `o:${ORG}` : 's:default', otherGroup };
}

interface Impact {
  only_count: number;
  shared_count: number;
  member_count: number;
  mapping_count: number;
}

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  const multi = mode === 'multi-tenant';

  describe(`access group administration (${mode})`, () => {
    let fx: Fixture;
    let db: PGlite;
    let groupA = '';
    let groupB = '';

    const create = async (key: string, name: string, tenantKey = fx.tenantKey): Promise<Row> => {
      await assertFunction(db, 'rag_access_group_create');
      const rows = await service(db, () =>
        db.query<Row>('SELECT id::text AS id, key, name, source FROM public.rag_access_group_create($1, $2, $3, $4)', [tenantKey, key, name, ADMIN]),
      );
      assert.equal(rows.rows.length, 1, 'one row');
      return rows.rows[0]!;
    };

    const addMember = async (groupId: string, userId: string, tenantKey = fx.tenantKey): Promise<void> => {
      await assertFunction(db, 'rag_access_member_add');
      await service(db, () => db.query('SELECT * FROM public.rag_access_member_add($1, $2, $3, $4)', [tenantKey, groupId, userId, ADMIN]));
    };

    const impact = async (groupId: string, tenantKey = fx.tenantKey): Promise<Impact> => {
      await assertFunction(db, 'rag_access_group_impact');
      const rows = await service(db, () =>
        db.query<Impact>(
          `SELECT only_count::int AS only_count, shared_count::int AS shared_count, member_count::int AS member_count, mapping_count::int AS mapping_count
           FROM public.rag_access_group_impact($1, $2)`,
          [tenantKey, groupId],
        ),
      );
      assert.equal(rows.rows.length, 1, 'one row');
      return rows.rows[0]!;
    };

    const remove = async (groupId: string, count: number | null, tenantKey = fx.tenantKey): Promise<{ fell_back: number; relabelled: number }> => {
      await assertFunction(db, 'rag_access_group_delete');
      const rows = await service(db, () =>
        db.query<{ fell_back: number; relabelled: number }>(
          'SELECT fell_back::int AS fell_back, relabelled::int AS relabelled FROM public.rag_access_group_delete($1, $2, $3, $4)',
          [tenantKey, groupId, count, ADMIN],
        ),
      );
      return rows.rows[0]!;
    };

    const labelOf = async (docId: string): Promise<string[]> =>
      (await db.query<{ g: string[] }>('SELECT access_groups AS g FROM documents WHERE id = $1', [docId])).rows[0]!.g;

    before(async () => {
      fx = await build(mode);
      db = fx.db;
    });

    after(async () => {
      await db?.close();
    });

    test('groups are created inside the tenant with a valid, unreserved, unused key', async () => {
      const a = await create('group-a', 'Group alpha');
      assert.equal(a.key, 'group-a');
      assert.equal(a.name, 'Group alpha');
      assert.equal(a.source, 'manual');
      groupA = a.id as string;
      groupB = (await create('group-b', '  Group beta  ')).id as string;
      const stored = await db.query<Row>('SELECT tenant_key, name, created_by::text AS created_by FROM rag_access_groups WHERE id = $1', [groupB]);
      assert.deepEqual(stored.rows[0], { tenant_key: fx.tenantKey, name: 'Group beta', created_by: ADMIN });
      if (multi) {
        assert.notEqual(groupA, fx.otherGroup, 'the same key in another organization is another group');
      }

      await rejects(() => create('Bad Key', 'Bad'), /^invalid_key/, 'pattern');
      await rejects(() => create('-lead', 'Bad'), /^invalid_key/, 'leading hyphen');
      await rejects(() => create('all', 'Everyone'), /^reserved_key/, 'all');
      await rejects(() => create('group-a', 'Again'), /^group_exists/, 'taken key');
      await rejects(() => create('group-c', '   '), /^invalid_name/, 'blank name');
      if (multi) {
        await rejects(() => create('group-c', 'Personal', `u:${MEMBER_A}`), /^personal_tenant/, 'personal tenant');
        await rejects(() => create('group-c', 'Mode', 's:default'), /tenant key/, 'other mode key');
      } else {
        await rejects(() => create('group-c', 'Mode', `o:${ORG}`), /tenant key/, 'other mode key');
      }
      const audit = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM rag_access_audit WHERE action = 'group_create' AND tenant_key = $1 AND actor = $2 AND actor_kind = 'admin'",
        [fx.tenantKey, ADMIN],
      );
      assert.equal(audit.rows[0]!.n, 2, 'one group_create row per created group');
    });

    test('members are added only from the tenant, once', async () => {
      await addMember(groupA, MEMBER_A);
      await rejects(() => addMember(groupA, MEMBER_A), /^member_exists/, 'twice');
      if (multi) {
        await rejects(() => addMember(groupA, OUTSIDER), /^not_a_workspace_member/, 'outside the organization');
        await rejects(() => addMember(fx.otherGroup!, MEMBER_A), /^not_found/, 'group of another organization');
      }
      await rejects(() => addMember(id('9249', 9), MEMBER_A), /^not_found/, 'unknown group');
      const audit = await db.query<Row>(
        "SELECT group_id::text AS group_id, after_groups FROM rag_access_audit WHERE action = 'member_add' AND tenant_key = $1",
        [fx.tenantKey],
      );
      assert.deepEqual(audit.rows, [{ group_id: groupA, after_groups: [`u:${MEMBER_A}`] }], 'one member_add row naming the member key');
    });

    test('deleting a group needs the current count and falls back fail closed on every version', async () => {
      await insertDoc(db, multi, { id: DOC.oneV1, text: 'An older neutral synthetic version.', groups: [`g:${groupA}`] });
      await insertDoc(db, multi, { id: DOC.oneV2, text: 'A newer neutral synthetic version.', groups: [`g:${groupA}`], lineage: DOC.oneV1, version: 2 });
      await db.query('UPDATE documents SET access_groups = $2::text[] WHERE id = $1', [DOC.oneV2, [`g:${groupA}`]]);
      await supersede(db, DOC.oneV1, DOC.oneV2);
      await insertDoc(db, multi, { id: DOC.two, text: 'A neutral synthetic record for two groups.', groups: [`g:${groupA}`, `g:${groupB}`].sort() });
      await insertDoc(db, multi, { id: DOC.open, text: 'A neutral synthetic record for everyone.', groups: ['all'] });
      if (!multi) {
        await insertDoc(db, multi, { id: DOC.orphan, text: 'A neutral synthetic record without an uploader.', groups: [`g:${groupA}`], uploader: null });
      }
      const expectedOnly = multi ? 1 : 2;

      assert.deepEqual(await impact(groupA), { only_count: expectedOnly, shared_count: 1, member_count: 1, mapping_count: 0 });
      if (multi) {
        await rejects(() => impact(fx.otherGroup!), /^not_found/, 'impact of another organization');
        await rejects(() => remove(fx.otherGroup!, 1), /^not_found/, 'delete in another organization');
      }

      await rejects(() => remove(groupA, expectedOnly - 1), /^count_required/, 'stale count');
      await rejects(() => remove(groupA, null), /^count_required/, 'no count');
      assert.ok(await labelOf(DOC.oneV2).then((g) => g.includes(`g:${groupA}`)), 'a refused delete changes nothing');

      const countAll = async (): Promise<number> =>
        (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM documents WHERE access_groups = '{all}'")).rows[0]!.n;
      const allBefore = await countAll();
      const result = await remove(groupA, expectedOnly);
      assert.equal(result.fell_back, expectedOnly, 'fell back');
      assert.equal(result.relabelled, 1, 'lineages that kept another key');

      assert.deepEqual(await labelOf(DOC.oneV1), [`u:${MEMBER_A}`], 'superseded version falls back to the uploader');
      assert.deepEqual(await labelOf(DOC.oneV2), [`u:${MEMBER_A}`], 'current version falls back to the uploader');
      assert.deepEqual(await labelOf(DOC.two), [`g:${groupB}`], 'the other group stays');
      assert.deepEqual(await labelOf(DOC.open), ['all'], 'untouched');
      if (!multi) assert.deepEqual(await labelOf(DOC.orphan), [`u:${ADMIN}`], 'no uploader: the deleting admin');
      if (multi) assert.deepEqual(await labelOf(DOC.other), [`g:${fx.otherGroup}`], 'another organization is untouched');

      assert.equal(await countAll(), allBefore, 'no labelled document widened to all');
      const chunks = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM document_chunks WHERE access_groups @> $1::text[]', [[`g:${groupA}`]]);
      assert.equal(chunks.rows[0]!.n, 0, 'no chunk keeps the deleted key');
      const drift = await service(db, () => db.query<{ rows: number }>('SELECT COALESCE(sum(rows), 0)::int AS rows FROM public.rag_access_groups_drift()'));
      assert.equal(drift.rows[0]!.rows, 0, 'no drift');

      const gone = await db.query<{ g: number; m: number }>(
        'SELECT (SELECT count(*)::int FROM rag_access_groups WHERE id = $1) AS g, (SELECT count(*)::int FROM rag_access_group_members WHERE group_id = $1) AS m',
        [groupA],
      );
      assert.deepEqual(gone.rows[0], { g: 0, m: 0 }, 'group and members are gone');

      const audit = await db.query<Row>(
        `SELECT action, actor::text AS actor, reason, group_id::text AS group_id, lineage_id::text AS lineage_id, before_groups, after_groups
         FROM rag_access_audit WHERE tenant_key = $1 AND action IN ('group_delete', 'document_fallback') ORDER BY action, lineage_id`,
        [fx.tenantKey],
      );
      const fallbacks = audit.rows.filter((r) => r.action === 'document_fallback');
      const deletes = audit.rows.filter((r) => r.action === 'group_delete');
      assert.equal(deletes.length, 1, 'one group_delete row');
      assert.equal(deletes[0]!.group_id, groupA);
      assert.equal(fallbacks.length, expectedOnly, 'one document_fallback row per fallen-back lineage');
      const lineOne = fallbacks.find((r) => r.lineage_id === DOC.oneV1);
      assert.deepEqual(lineOne, {
        action: 'document_fallback',
        actor: ADMIN,
        reason: 'group_deleted',
        group_id: groupA,
        lineage_id: DOC.oneV1,
        before_groups: [`g:${groupA}`],
        after_groups: [`u:${MEMBER_A}`],
      });
    });

    test('the task 1 functions are executable by service_role only', async () => {
      await assertGrants(db, ['rag_access_group_create', 'rag_access_group_impact', 'rag_access_group_delete', 'rag_access_member_add']);
      await rejects(
        () => asRole(db, 'authenticated', ADMIN, () => db.query('SELECT * FROM public.rag_access_group_impact($1, $2)', [fx.tenantKey, groupB])),
        /permission denied/,
        'authenticated call',
      );
    });
  });
}

async function assertGrants(db: PGlite, names: string[]): Promise<void> {
  const rows = await db.query<{ sig: string; anon: boolean; auth: boolean; svc: boolean; pub: boolean; path: boolean }>(
    `SELECT p.oid::regprocedure::text AS sig,
            has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
            has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
            EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS pub,
            COALESCE('search_path=""' = ANY (p.proconfig), false) AS path
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [names],
  );
  assert.equal(rows.rows.length, names.length, 'every function exists once');
  for (const row of rows.rows) {
    assert.deepEqual(row, { sig: row.sig, anon: false, auth: false, svc: true, pub: false, path: true });
  }
}

interface Listed {
  id: string;
  key: string;
  name: string;
  source: string;
  member_count: number;
  document_count: number;
  cursor: string;
}

interface Person {
  user_id: string;
  display_name: string;
  email: string | null;
  already_member?: boolean;
}

interface Mine {
  is_admin: boolean;
  own_groups: { id: string; name: string }[];
  assignable_groups: { id: string; name: string }[];
}

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  const multi = mode === 'multi-tenant';

  describe(`access group lists, members, candidates and my groups (${mode})`, () => {
    let fx: Fixture;
    let db: PGlite;
    const groups: Record<string, string> = {};
    const BULK = Array.from({ length: 22 }, (_, n) => id('9245', n + 1));

    const call = <T extends Row>(sql: string, params: unknown[]): Promise<T[]> => service(db, async () => (await db.query<T>(sql, params)).rows);

    const list = async (cursor: string | null, limit: number | null, tenantKey = fx.tenantKey): Promise<Listed[]> => {
      await assertFunction(db, 'rag_access_groups_list');
      return call<Listed & Row>(
        `SELECT id::text AS id, key, name, source, member_count::int AS member_count, document_count::int AS document_count, cursor
         FROM public.rag_access_groups_list($1, $2, $3)`,
        [tenantKey, cursor, limit],
      );
    };

    const members = async (groupId: string, tenantKey = fx.tenantKey): Promise<Person[]> => {
      await assertFunction(db, 'rag_access_group_members_list');
      return call<Person & Row>(
        'SELECT user_id::text AS user_id, display_name, email FROM public.rag_access_group_members_list($1, $2)',
        [tenantKey, groupId],
      );
    };

    const candidates = async (groupId: string, query: string, limit: number | null = null, tenantKey = fx.tenantKey): Promise<Person[]> => {
      await assertFunction(db, 'rag_access_member_candidates');
      return call<Person & Row>(
        'SELECT user_id::text AS user_id, display_name, email, already_member FROM public.rag_access_member_candidates($1, $2, $3, $4)',
        [tenantKey, groupId, query, limit],
      );
    };

    const mine = async (userId: string, tenantKey = fx.tenantKey): Promise<Mine> => {
      await assertFunction(db, 'rag_access_my_groups');
      const rows = await call<Mine & Row>('SELECT is_admin, own_groups, assignable_groups FROM public.rag_access_my_groups($1, $2)', [tenantKey, userId]);
      assert.equal(rows.length, 1, 'one row');
      return rows[0]!;
    };

    before(async () => {
      fx = await build(mode);
      db = fx.db;
      await db.query('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb');
      await db.query(`UPDATE auth.users SET raw_user_meta_data = '{"full_name": "Alpha Person"}'::jsonb WHERE id = $1`, [MEMBER_A]);
      for (const [n, user] of BULK.entries()) {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [user, `bulk-person-${n}@example.invalid`]);
        if (multi) await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'member')", [ORG, user]);
      }
      for (const [key, name] of [['group-c', 'Group gamma'], ['group-a', 'Group alpha'], ['group-b', 'Group beta']] as const) {
        const row = await call<{ id: string }>('SELECT id::text AS id FROM public.rag_access_group_create($1, $2, $3, $4)', [fx.tenantKey, key, name, ADMIN]);
        groups[key] = row[0]!.id;
      }
      await call('SELECT * FROM public.rag_access_member_add($1, $2, $3, $4)', [fx.tenantKey, groups['group-a'], MEMBER_A, ADMIN]);
      await call('SELECT * FROM public.rag_access_member_add($1, $2, $3, $4)', [fx.tenantKey, groups['group-a'], MEMBER_B, ADMIN]);
      await call('SELECT * FROM public.rag_access_member_add($1, $2, $3, $4)', [fx.tenantKey, groups['group-b'], MEMBER_B, ADMIN]);
      await insertDoc(db, multi, { id: DOC.oneV1, text: 'An older neutral synthetic version.', groups: [`g:${groups['group-a']}`] });
      await insertDoc(db, multi, { id: DOC.oneV2, text: 'A newer neutral synthetic version.', groups: [`g:${groups['group-a']}`], lineage: DOC.oneV1, version: 2 });
      await supersede(db, DOC.oneV1, DOC.oneV2);
      await insertDoc(db, multi, { id: DOC.two, text: 'A neutral synthetic record for two groups.', groups: [`g:${groups['group-a']}`, `g:${groups['group-b']}`].sort() });
    });

    after(async () => {
      await db?.close();
    });

    test('rename keeps the key and every label', async () => {
      await assertFunction(db, 'rag_access_group_rename');
      const renamed = await call<Row>('SELECT id::text AS id, key, name FROM public.rag_access_group_rename($1, $2, $3, $4)', [
        fx.tenantKey,
        groups['group-a'],
        ' Group alpha renamed ',
        ADMIN,
      ]);
      assert.deepEqual(renamed, [{ id: groups['group-a'], key: 'group-a', name: 'Group alpha renamed' }]);
      const label = await db.query<{ g: string[] }>('SELECT access_groups AS g FROM documents WHERE id = $1', [DOC.oneV2]);
      assert.deepEqual(label.rows[0]!.g, [`g:${groups['group-a']}`], 'label unchanged');
      await rejects(
        () => call('SELECT * FROM public.rag_access_group_rename($1, $2, $3, $4)', [fx.tenantKey, id('9249', 9), 'Name', ADMIN]),
        /^not_found/,
        'unknown group',
      );
      await rejects(
        () => call('SELECT * FROM public.rag_access_group_rename($1, $2, $3, $4)', [fx.tenantKey, groups['group-a'], '', ADMIN]),
        /^invalid_name/,
        'blank name',
      );
      if (multi) {
        await rejects(
          () => call('SELECT * FROM public.rag_access_group_rename($1, $2, $3, $4)', [fx.tenantKey, fx.otherGroup, 'Name', ADMIN]),
          /^not_found/,
          'group of another organization',
        );
      }
      const audit = await db.query<Row>("SELECT group_id::text AS group_id FROM rag_access_audit WHERE action = 'group_rename'");
      assert.deepEqual(audit.rows, [{ group_id: groups['group-a'] }], 'one group_rename row');
    });

    test('the list pages by name with member and current-document counts', async () => {
      const all = await list(null, null);
      assert.deepEqual(
        all.map((g) => [g.key, g.member_count, g.document_count]),
        [
          ['group-a', 2, 2],
          ['group-b', 1, 1],
          ['group-c', 0, 0],
        ],
        'ordered by name; superseded versions do not count',
      );
      const first = await list(null, 2);
      assert.deepEqual(first.map((g) => g.key), ['group-a', 'group-b']);
      const second = await list(first[1]!.cursor, 2);
      assert.deepEqual(second.map((g) => g.key), ['group-c']);
      await rejects(() => list('not-a-cursor', 2), /^invalid_cursor/, 'bad cursor');
      if (multi) {
        const other = await list(null, null, `o:${OTHER_ORG}`);
        assert.deepEqual(other.map((g) => g.id), [fx.otherGroup], 'another organization lists only its own group');
        assert.deepEqual(await list(null, null, `u:${MEMBER_A}`), [], 'a personal tenant has no groups');
      }
    });

    test('members list names and addresses of the group inside the tenant', async () => {
      const rows = await members(groups['group-a']!);
      assert.deepEqual(
        rows.map((r) => [r.user_id, r.display_name, r.email]),
        [
          [MEMBER_A, 'Alpha Person', 'member-alpha@example.invalid'],
          [MEMBER_B, 'member-beta@example.invalid', 'member-beta@example.invalid'],
        ],
      );
      if (multi) await rejects(() => members(fx.otherGroup!), /^not_found/, 'group of another organization');
    });

    test('candidates need two characters, stay inside the tenant, are capped at 20 and flag members', async () => {
      assert.deepEqual(await candidates(groups['group-a']!, ' a '), [], 'one character');
      const alpha = await candidates(groups['group-a']!, 'alpha');
      const ids = alpha.map((r) => r.user_id).sort();
      if (multi) {
        assert.deepEqual(ids, [MEMBER_A], 'only members of the organization');
      } else {
        assert.deepEqual(ids, [MEMBER_A, OUTSIDER, OTHER_USER].sort(), 'every confirmed user of the deployment');
      }
      assert.equal(alpha.find((r) => r.user_id === MEMBER_A)?.already_member, true, 'already in the group');
      const beta = await candidates(groups['group-c']!, 'BETA');
      assert.deepEqual(beta.map((r) => [r.user_id, r.already_member]), [[MEMBER_B, false]], 'case-insensitive, not in group-c');
      const bulk = await candidates(groups['group-a']!, 'bulk-person', 100);
      assert.equal(bulk.length, 20, 'capped at 20');
      assert.deepEqual(await candidates(groups['group-a']!, '%%'), [], 'wildcards are escaped');
      assert.deepEqual(await candidates(groups['group-a']!, '__'), [], 'underscores are escaped');
      if (multi) {
        await rejects(() => candidates(fx.otherGroup!, 'alpha'), /^not_found/, 'group of another organization');
        const theirs = await candidates(fx.otherGroup!, 'alpha', null, `o:${OTHER_ORG}`);
        assert.deepEqual(theirs.map((r) => r.user_id).sort(), [OUTSIDER, OTHER_USER].sort(), 'the other organization sees its own people');
      }
    });

    test('remove writes member_remove; a non-member answers not_found', async () => {
      await assertFunction(db, 'rag_access_member_remove');
      await call('SELECT * FROM public.rag_access_member_remove($1, $2, $3, $4)', [fx.tenantKey, groups['group-a'], MEMBER_B, ADMIN]);
      assert.deepEqual((await members(groups['group-a']!)).map((r) => r.user_id), [MEMBER_A]);
      await rejects(
        () => call('SELECT * FROM public.rag_access_member_remove($1, $2, $3, $4)', [fx.tenantKey, groups['group-a'], MEMBER_B, ADMIN]),
        /^not_found/,
        'not a member',
      );
      const audit = await db.query<Row>("SELECT group_id::text AS group_id, before_groups FROM rag_access_audit WHERE action = 'member_remove'");
      assert.deepEqual(audit.rows, [{ group_id: groups['group-a'], before_groups: [`u:${MEMBER_B}`] }]);
    });

    test('my groups: own and assignable groups only, every group for an admin, nothing for an outsider', async () => {
      const member = await mine(MEMBER_A);
      assert.equal(member.is_admin, false);
      assert.deepEqual(member.own_groups, [{ id: groups['group-a'], name: 'Group alpha renamed' }]);
      assert.deepEqual(member.assignable_groups, [{ id: groups['group-a'], name: 'Group alpha renamed' }]);
      const admin = await mine(ADMIN);
      assert.equal(admin.is_admin, true);
      assert.deepEqual(admin.own_groups, []);
      assert.deepEqual(admin.assignable_groups.map((g) => g.id), [groups['group-a'], groups['group-b'], groups['group-c']]);
      const outsider = await mine(OUTSIDER);
      assert.deepEqual(outsider, { is_admin: false, own_groups: [], assignable_groups: [] }, 'nothing about any group');
      if (multi) {
        const there = await mine(OUTSIDER, `o:${OTHER_ORG}`);
        assert.deepEqual(there.own_groups, [{ id: fx.otherGroup, name: 'Other group' }], 'own groups of the other organization');
      }
    });

    test('the task 2 functions are service_role only with an empty search_path', async () => {
      await assertGrants(db, [
        'rag_access_group_rename',
        'rag_access_groups_list',
        'rag_access_group_members_list',
        'rag_access_member_remove',
        'rag_access_member_candidates',
        'rag_access_my_groups',
      ]);
      const definers = await db.query<{ proname: string }>(
        "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'rag_access_%' AND p.prosecdef AND p.proname = ANY($1::text[]) ORDER BY 1",
        [['rag_access_group_members_list', 'rag_access_member_candidates', 'rag_access_my_groups', 'rag_access_groups_list', 'rag_access_group_rename', 'rag_access_member_remove']],
      );
      assert.deepEqual(definers.rows.map((r) => r.proname), ['rag_access_group_members_list', 'rag_access_member_candidates'], 'only the auth.users readers are DEFINER');
    });
  });
}
