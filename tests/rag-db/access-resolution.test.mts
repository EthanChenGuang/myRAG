import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 plan 05 (SEC-12, SEC-13): the service-role functions of 0922 in both deployment modes. Caller resolution (D-04, D-05, D-08,
// A-05), the embed group lookup (D-07), the audited lineage-wide label setter (D-02, D-17, A-07), the batched visibility checks (D-12, D-15,
// D-26, D-27), the enforcement flag writer (A-03) and the security event writer (D-26). Fixtures are neutral synthetic sentences.

type Role = 'anon' | 'authenticated' | 'service_role';
type Row = Record<string, unknown>;

const CORPUS_DIR = path.resolve(import.meta.dirname, '../../eval/fixtures/corpus');
const LEGACY = 'openai-3-small-1536';

const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const ADMIN = id('9221', 1);
const MEMBER_A = id('9221', 2);
const MEMBER_B = id('9221', 3);
const OUTSIDER = id('9221', 4);
const OTHER_USER = id('9221', 5);
const ORG = id('9222', 1);
const OTHER_ORG = id('9222', 2);

const DOC = {
  restricted: id('9223', 1),
  open: id('9223', 2),
  oldB: id('9223', 3),
  currentB: id('9223', 4),
  other: id('9223', 5),
  lineV1: id('9223', 6),
  lineV2: id('9223', 7),
  synced: id('9223', 8),
  syncedV2: id('9223', 9),
} as const;
const CHUNK = {
  restricted: id('9224', 1),
  open: id('9224', 2),
  oldB: id('9224', 3),
  currentB: id('9224', 4),
  other: id('9224', 5),
  lineV1: id('9224', 6),
  lineV2: id('9224', 7),
} as const;

const RESTRICTED_TEXT = 'The quillfern restricted sentence describes a neutral synthetic record.';
const OPEN_TEXT = 'The quillfern open sentence describes a neutral synthetic record for everyone.';
const OTHER_TEXT = 'The quillfern other sentence describes a neutral synthetic record of another tenant.';

const sortText = (values: readonly string[]): string[] => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
  tenantKey: string;
  groupA: string;
  groupB: string;
  otherGroupA: string | null;
}

async function insertDoc(
  db: PGlite,
  multi: boolean,
  doc: { id: string; text: string; groups: string[]; org?: string; lineage?: string; version?: number; current?: boolean },
): Promise<void> {
  const org = doc.org ?? ORG;
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, language, access_groups, lineage_id, version${multi ? ', organization_id' : ''})
     VALUES ($1, $2, $3, '{}'::jsonb, $4, 'en', $5::text[], $6, $7${multi ? ', $8' : ''})`,
    multi
      ? [doc.id, `${doc.id}.md`, doc.text, MEMBER_A, doc.groups, doc.lineage ?? doc.id, doc.version ?? 1, org]
      : [doc.id, `${doc.id}.md`, doc.text, MEMBER_A, doc.groups, doc.lineage ?? doc.id, doc.version ?? 1],
  );
}

async function insertChunk(db: PGlite, multi: boolean, chunk: { id: string; doc: string; text: string; org?: string }): Promise<void> {
  const org = chunk.org ?? ORG;
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, embedding, chunk_index, metadata${multi ? ', organization_id' : ''})
     VALUES ($1, $2, $3, $4::vector, 0, '{}'::jsonb${multi ? ', $5' : ''})`,
    multi ? [chunk.id, chunk.doc, chunk.text, vec(chunk.text), org] : [chunk.id, chunk.doc, chunk.text, vec(chunk.text)],
  );
}

/** Marks a document version superseded by its successor; its chunks follow. */
async function supersede(db: PGlite, oldId: string, newId: string): Promise<void> {
  await db.query('UPDATE documents SET is_current = false, superseded_by = $2 WHERE id = $1', [oldId, newId]);
  await db.query('UPDATE document_chunks SET is_current = false WHERE document_id = $1', [oldId]);
}

async function build(mode: DeploymentMode): Promise<Fixture> {
  const multi = mode === 'multi-tenant';
  const { db } = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS_DIR, supabaseGrants: true });
  const users = [ADMIN, MEMBER_A, MEMBER_B, OUTSIDER, OTHER_USER];
  for (const [index, user] of users.entries()) {
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user, `user-${index}@example.invalid`]);
  }
  let groupA: string;
  let groupB: string;
  let otherGroupA: string | null = null;
  if (multi) {
    await db.query(
      "INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace one', 'resolution-one', $3, false), ($2, 'Workspace two', 'resolution-two', $4, false)",
      [ORG, OTHER_ORG, ADMIN, OTHER_USER],
    );
    await db.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES
         ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($2, $7, 'owner'), ($2, $4, 'member')`,
      [ORG, OTHER_ORG, ADMIN, MEMBER_A, MEMBER_B, OUTSIDER, OTHER_USER],
    );
    const insert = async (key: string, org: string): Promise<string> =>
      (await db.query<{ id: string }>("INSERT INTO rag_access_groups (key, name, organization_id) VALUES ($1, 'Group', $2) RETURNING id", [key, org]))
        .rows[0]!.id;
    groupA = await insert('group-a', ORG);
    groupB = await insert('group-b', ORG);
    otherGroupA = await insert('group-a', OTHER_ORG);
    await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)', [otherGroupA, MEMBER_A, OTHER_USER]);
  } else {
    await db.query('INSERT INTO admin_users (id) VALUES ($1)', [ADMIN]);
    const insert = async (key: string): Promise<string> =>
      (await db.query<{ id: string }>("INSERT INTO rag_access_groups (key, name) VALUES ($1, 'Group') RETURNING id", [key])).rows[0]!.id;
    groupA = await insert('group-a');
    groupB = await insert('group-b');
  }
  await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2), ($3, $4)', [groupA, MEMBER_A, groupB, MEMBER_B]);

  await insertDoc(db, multi, { id: DOC.restricted, text: RESTRICTED_TEXT, groups: ['all'] });
  await insertDoc(db, multi, { id: DOC.open, text: OPEN_TEXT, groups: ['all'] });
  // group-b labels only a superseded version: it is not an effective key.
  await insertDoc(db, multi, { id: DOC.oldB, text: 'An older neutral synthetic version.', groups: [`g:${groupB}`] });
  await insertDoc(db, multi, { id: DOC.currentB, text: 'A newer neutral synthetic version.', groups: ['all'], lineage: DOC.oldB, version: 2 });
  await db.query("UPDATE documents SET access_groups = '{all}' WHERE id = $1", [DOC.currentB]);
  await insertChunk(db, multi, { id: CHUNK.restricted, doc: DOC.restricted, text: RESTRICTED_TEXT });
  await insertChunk(db, multi, { id: CHUNK.open, doc: DOC.open, text: OPEN_TEXT });
  await insertChunk(db, multi, { id: CHUNK.oldB, doc: DOC.oldB, text: 'An older neutral synthetic version.' });
  await insertChunk(db, multi, { id: CHUNK.currentB, doc: DOC.currentB, text: 'A newer neutral synthetic version.' });
  await supersede(db, DOC.oldB, DOC.currentB);
  if (multi) {
    await insertDoc(db, multi, { id: DOC.other, text: OTHER_TEXT, groups: [`g:${otherGroupA}`], org: OTHER_ORG });
    await insertChunk(db, multi, { id: CHUNK.other, doc: DOC.other, text: OTHER_TEXT, org: OTHER_ORG });
  }
  return { db, tenantKey: multi ? `o:${ORG}` : 's:default', groupA, groupB, otherGroupA };
}

interface Resolved {
  is_admin: boolean;
  group_ids: string[];
  effective_keys: string[];
}

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  const multi = mode === 'multi-tenant';

  describe(`access resolution functions (${mode})`, () => {
    let fx: Fixture;
    let db: PGlite;

    const resolve = async (userId: string | null, tenantKey = fx.tenantKey): Promise<Resolved> => {
      await assertFunction(db, 'rag_resolve_access_scope');
      const rows = await service(db, () =>
        db.query<Resolved>('SELECT is_admin, group_ids::text[] AS group_ids, effective_keys FROM public.rag_resolve_access_scope($1, $2)', [
          tenantKey,
          userId,
        ]),
      );
      assert.equal(rows.rows.length, 1, 'one row');
      return rows.rows[0]!;
    };

    const keysOf = (userId: string, groups: string[]): string[] => sortText(['all', `u:${userId}`, ...groups.map((g) => `g:${g}`)]);

    before(async () => {
      fx = await build(mode);
      db = fx.db;
    });

    after(async () => {
      await db?.close();
    });

    test('the resolver reports admins, groups of this tenant only and effective keys', async () => {
      const admin = await resolve(ADMIN);
      assert.equal(admin.is_admin, true, 'admin');
      for (const user of [MEMBER_A, MEMBER_B, OUTSIDER]) {
        assert.equal((await resolve(user)).is_admin, false, `${user} is not admin`);
      }

      const memberA = await resolve(MEMBER_A);
      assert.deepEqual(memberA.group_ids, [fx.groupA], 'member-a has group-a of this tenant only');
      assert.deepEqual(memberA.effective_keys, ['all'], 'group-a labels no current document yet');
      assert.deepEqual((await resolve(MEMBER_B)).group_ids, [fx.groupB]);
      assert.deepEqual((await resolve(MEMBER_B)).effective_keys, ['all'], 'a key on a superseded version only is not effective');
      assert.deepEqual((await resolve(OUTSIDER)).group_ids, []);

      await db.query('UPDATE documents SET access_groups = $2::text[] WHERE id = $1', [DOC.restricted, [`g:${fx.groupA}`]]);
      assert.deepEqual((await resolve(MEMBER_A)).effective_keys, ['all', `g:${fx.groupA}`], 'group-a now labels a current document');
      assert.deepEqual((await resolve(OUTSIDER)).effective_keys, ['all']);

      const anonymous = await resolve(null);
      assert.deepEqual(anonymous, { is_admin: false, group_ids: [], effective_keys: ['all'] }, 'a null user gets all only');
    });

    if (multi) {
      test('another organization grants nothing and a personal tenant is administered by its owner', async () => {
        const other = await resolve(OTHER_USER);
        assert.deepEqual(other, { is_admin: false, group_ids: [], effective_keys: ['all'] }, 'not a member of this organization');
        const inOther = await resolve(MEMBER_A, `o:${OTHER_ORG}`);
        assert.deepEqual(inOther.group_ids, [fx.otherGroupA], 'member-a resolves the other organization group only there');
        assert.equal(inOther.is_admin, false);
        assert.equal((await resolve(ADMIN, `o:${OTHER_ORG}`)).is_admin, false, 'admin of one organization only');
        assert.equal((await resolve(OTHER_USER, `o:${OTHER_ORG}`)).is_admin, true, 'organization owner');
        assert.equal((await resolve(MEMBER_A, `u:${MEMBER_A}`)).is_admin, true, 'owner of the personal tenant');
        assert.equal((await resolve(MEMBER_B, `u:${MEMBER_A}`)).is_admin, false, 'someone else on a personal tenant');
        assert.deepEqual((await resolve(MEMBER_B, `u:${MEMBER_A}`)).group_ids, []);
      });

      test('a membership row left behind for a non-member of the organization grants no group', async () => {
        // Bypass the member trigger the way a restore or a race could, then resolve: the organization check in the resolver still holds.
        await db.exec('ALTER TABLE rag_access_group_members DISABLE TRIGGER rag_access_group_members_require_org_member');
        try {
          await db.query('INSERT INTO rag_access_group_members (group_id, user_id) VALUES ($1, $2)', [fx.groupA, OTHER_USER]);
        } finally {
          await db.exec('ALTER TABLE rag_access_group_members ENABLE TRIGGER rag_access_group_members_require_org_member');
        }
        try {
          assert.deepEqual(await resolve(OTHER_USER), { is_admin: false, group_ids: [], effective_keys: ['all'] });
        } finally {
          await db.query('DELETE FROM rag_access_group_members WHERE group_id = $1 AND user_id = $2', [fx.groupA, OTHER_USER]);
        }
      });
    }

    test('the resolver refuses a tenant key of the other deployment mode', async () => {
      await assertFunction(db, 'rag_resolve_access_scope');
      const wrong = multi ? 's:default' : `o:${ORG}`;
      await rejects(() => service(db, () => db.query('SELECT * FROM public.rag_resolve_access_scope($1, $2)', [wrong, MEMBER_A])), /tenant key/, 'mode');
    });

    test('the resolved keys filter hybrid_search_chunks: member-a gets the restricted chunk, the outsider does not', async () => {
      const search = async (keys: string[]): Promise<string[]> =>
        (
          await service(db, () =>
            db.query<{ chunk_id: string }>(
              `SELECT chunk_id::text FROM hybrid_search_chunks(p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector,
                 p_lexical_tokens => NULL, p_dense_limit => 200, p_lexical_limit => 0, p_exact_scan_cutoff => 100000,
                 p_access_keys => $4::text[], p_access_all => false)`,
              [fx.tenantKey, LEGACY, vec(RESTRICTED_TEXT), keys],
            ),
          )
        ).rows.map((row) => row.chunk_id);
      const memberA = await resolve(MEMBER_A);
      const outsider = await resolve(OUTSIDER);
      const memberHits = await search(keysOf(MEMBER_A, memberA.group_ids));
      const outsiderHits = await search(keysOf(OUTSIDER, outsider.group_ids));
      assert.ok(memberHits.includes(CHUNK.restricted), 'member-a sees the restricted chunk');
      assert.ok(memberHits.includes(CHUNK.open), 'member-a sees the open chunk');
      assert.ok(!outsiderHits.includes(CHUNK.restricted), 'the outsider does not see the restricted chunk');
      assert.ok(outsiderHits.includes(CHUNK.open), 'the outsider sees the open chunk');
    });

    test('rag_access_group_by_key returns the group of this tenant and whether it labels a current document', async () => {
      await assertFunction(db, 'rag_access_group_by_key');
      const lookup = (key: string, tenantKey = fx.tenantKey) =>
        service(db, () => db.query<Row>('SELECT id::text, name, labels_current FROM public.rag_access_group_by_key($1, $2)', [tenantKey, key]));
      assert.deepEqual((await lookup('group-a')).rows, [{ id: fx.groupA, name: 'Group', labels_current: true }]);
      assert.deepEqual((await lookup('group-b')).rows, [{ id: fx.groupB, name: 'Group', labels_current: false }]);
      assert.deepEqual((await lookup('group-z')).rows, []);
      if (multi) {
        assert.deepEqual((await lookup('group-a', `o:${OTHER_ORG}`)).rows, [{ id: fx.otherGroupA, name: 'Group', labels_current: true }]);
      }
    });
  });
}
