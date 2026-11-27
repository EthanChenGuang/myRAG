import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 plan 05 (SEC-12, SEC-13): the service-role functions of 0923 part 2 (first written into 0922) in both deployment modes. Caller resolution (D-04, D-05, D-08,
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

const service = <T,>(db: PGlite, run: () => Promise<T>): Promise<T> => asRole(db, 'service_role', null, run);

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

    interface SetRow {
      document_id: string;
      outcome: string;
      before_groups: string[] | null;
      after_groups: string[] | null;
    }

    const setGroups = async (documentIds: string[], keys: string[], actorKind = 'admin', actor: string | null = ADMIN): Promise<SetRow[]> => {
      await assertFunction(db, 'rag_set_document_access_groups');
      return (
        await service(db, () =>
          db.query<SetRow>(
            `SELECT document_id::text, outcome, before_groups, after_groups
             FROM public.rag_set_document_access_groups($1, $2::uuid[], $3::text[], $4, $5, $6) ORDER BY document_id`,
            [fx.tenantKey, documentIds, keys, actor, actorKind, 'manual_change'],
          ),
        )
      ).rows;
    };
    const labelOf = async (documentId: string): Promise<string[]> =>
      (await db.query<{ g: string[] }>('SELECT access_groups AS g FROM documents WHERE id = $1', [documentId])).rows[0]!.g;
    const auditCount = async (): Promise<number> =>
      (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM rag_access_audit WHERE action = 'document_set'")).rows[0]!.n;

    test('the setter normalises keys: all alone wins, duplicates are removed, keys are sorted', async () => {
      const a = `g:${fx.groupA}`;
      const b = `g:${fx.groupB}`;
      const first = await setGroups([DOC.open], [a, 'all']);
      assert.deepEqual(first.map((row) => [row.outcome, row.after_groups]), [['unchanged', ['all']]], 'all wins over another key');
      const second = await setGroups([DOC.open], [b, a, a]);
      assert.equal(second[0]?.outcome, 'changed');
      assert.deepEqual(second[0]?.before_groups, ['all']);
      assert.deepEqual(second[0]?.after_groups, sortText([a, b]));
      assert.deepEqual(await labelOf(DOC.open), sortText([a, b]));
      assert.deepEqual(await setGroups([DOC.open], ['all']).then((rows) => rows[0]?.after_groups), ['all']);
    });

    test('the setter refuses an empty array, an unknown or foreign group, a user outside the tenant and an unknown actor kind', async () => {
      const before = await labelOf(DOC.open);
      await rejects(() => setGroups([DOC.open], []), /^empty_access/, 'empty');
      const foreignGroup = multi ? fx.otherGroupA! : id('9229', 1);
      await rejects(() => setGroups([DOC.open], [`g:${foreignGroup}`]), /^unknown_group/, 'foreign group');
      const foreignUser = multi ? OTHER_USER : id('9229', 2);
      await rejects(() => setGroups([DOC.open], [`u:${foreignUser}`]), /^unknown_user/, 'user outside the tenant');
      await rejects(() => setGroups([DOC.open], ['g:not-a-uuid']), /^invalid_access_key/, 'malformed key');
      await rejects(() => setGroups([DOC.open], ['all'], 'visitor'), /^invalid_actor_kind/, 'actor kind');
      assert.deepEqual(await labelOf(DOC.open), before, 'nothing changed');
      const ok = await setGroups([DOC.open], [`u:${MEMBER_B}`]);
      assert.equal(ok[0]?.outcome, 'changed', 'a user of the tenant is accepted');
      await setGroups([DOC.open], ['all']);
    });

    test('a relabel reaches every version of the lineage with one audit row and drift stays zero', async () => {
      await insertDoc(db, multi, { id: DOC.lineV1, text: 'A first neutral synthetic version.', groups: ['all'] });
      await insertDoc(db, multi, { id: DOC.lineV2, text: 'A second neutral synthetic version.', groups: ['all'], lineage: DOC.lineV1, version: 2 });
      await insertChunk(db, multi, { id: CHUNK.lineV1, doc: DOC.lineV1, text: 'A first neutral synthetic version.' });
      await insertChunk(db, multi, { id: CHUNK.lineV2, doc: DOC.lineV2, text: 'A second neutral synthetic version.' });
      await supersede(db, DOC.lineV1, DOC.lineV2);
      const auditBefore = await auditCount();
      const key = `g:${fx.groupB}`;
      const rows = await setGroups([DOC.lineV2], [key]);
      assert.deepEqual(rows.map((row) => [row.document_id, row.outcome]), [[DOC.lineV2, 'changed']]);
      assert.deepEqual(await labelOf(DOC.lineV1), [key], 'the superseded version follows');
      assert.deepEqual(await labelOf(DOC.lineV2), [key]);
      const chunk = await db.query<{ g: string[] }>('SELECT access_groups AS g FROM document_chunks WHERE id = $1', [CHUNK.lineV1]);
      assert.deepEqual(chunk.rows[0]?.g, [key], 'the superseded chunk follows');
      const drift = await service(db, () => db.query<{ rows: string }>('SELECT rows::text FROM public.rag_access_groups_drift()'));
      assert.ok(drift.rows.every((row) => row.rows === '0'), 'no drift');
      assert.equal(await auditCount(), auditBefore + 1, 'one audit row per lineage');
      const audit = (
        await db.query<Row>(
          "SELECT tenant_key, actor::text, actor_kind, document_id::text, lineage_id::text, before_groups, after_groups, reason FROM rag_access_audit WHERE action = 'document_set' ORDER BY created_at DESC, id DESC LIMIT 1",
        )
      ).rows[0];
      assert.deepEqual(audit, {
        tenant_key: fx.tenantKey,
        actor: ADMIN,
        actor_kind: 'admin',
        document_id: DOC.lineV2,
        lineage_id: DOC.lineV1,
        before_groups: ['all'],
        after_groups: [key],
        reason: 'manual_change',
      });
      const again = await setGroups([DOC.lineV1, DOC.lineV2], [key]);
      assert.deepEqual(again.map((row) => row.outcome), ['unchanged', 'unchanged'], 'two ids of one lineage');
      assert.equal(await auditCount(), auditBefore + 1, 'no audit row for an unchanged lineage');
    });

    test('an admin call skips connector-managed documents; a connector call changes them', async () => {
      await insertDoc(db, multi, { id: DOC.synced, text: 'A synced neutral synthetic version.', groups: ['all'] });
      await insertDoc(db, multi, { id: DOC.syncedV2, text: 'A synced neutral synthetic successor.', groups: ['all'], lineage: DOC.synced, version: 2 });
      await supersede(db, DOC.synced, DOC.syncedV2);
      await db.query(
        "INSERT INTO nango_sync_records (user_id, connection_id, provider, file_id, file_name, document_id) VALUES ($1, 'conn-1', 'google-drive', 'file-1', 'file-1.md', $2)",
        [MEMBER_A, DOC.synced],
      );
      const auditBefore = await auditCount();
      const key = `g:${fx.groupA}`;
      const skipped = await setGroups([DOC.syncedV2], [key]);
      assert.deepEqual(skipped.map((row) => row.outcome), ['skipped_connector'], 'another version of the lineage is synced');
      assert.deepEqual(await labelOf(DOC.syncedV2), ['all']);
      assert.equal(await auditCount(), auditBefore);
      const changed = await setGroups([DOC.syncedV2], [key], 'connector', null);
      assert.deepEqual(changed.map((row) => row.outcome), ['changed']);
      assert.deepEqual(await labelOf(DOC.synced), [key]);
      const audit = await db.query<Row>(
        "SELECT actor, actor_kind FROM rag_access_audit WHERE action = 'document_set' ORDER BY created_at DESC, id DESC LIMIT 1",
      );
      assert.deepEqual(audit.rows[0], { actor: null, actor_kind: 'connector' });
    });

    test('a document of another tenant or an unknown id is not_found and nothing changes', async () => {
      const foreign = multi ? DOC.other : id('9229', 3);
      const rows = await setGroups([foreign, DOC.restricted], ['all']);
      const byId = Object.fromEntries(rows.map((row) => [row.document_id, row.outcome]));
      assert.equal(byId[foreign], 'not_found');
      assert.equal(byId[DOC.restricted], 'changed');
      if (multi) assert.deepEqual(await labelOf(DOC.other), [`g:${fx.otherGroupA}`], 'the other tenant document keeps its label');
      await setGroups([DOC.restricted], [`g:${fx.groupA}`]);
    });

    const visible = async (fn: 'rag_chunks_visible' | 'rag_documents_visible', ids: string[], keys: string[] | null, all = false) => {
      await assertFunction(db, fn);
      return (
        await service(db, () => db.query<{ id: string }>(`SELECT v::text AS id FROM public.${fn}($1, $2::uuid[], $3::text[], $4) AS v`, [fx.tenantKey, ids, keys, all]))
      ).rows
        .map((row) => row.id)
        .sort();
    };

    test('rag_chunks_visible returns current, ready, in-tenant chunk ids visible through both labels', async () => {
      const ids = [CHUNK.restricted, CHUNK.open, CHUNK.lineV1, CHUNK.lineV2, ...(multi ? [CHUNK.other] : []), id('9229', 4)];
      const memberA = keysOf(MEMBER_A, (await resolve(MEMBER_A)).group_ids);
      const memberB = keysOf(MEMBER_B, (await resolve(MEMBER_B)).group_ids);
      const outsider = keysOf(OUTSIDER, []);
      assert.deepEqual(await visible('rag_chunks_visible', ids, memberA), sortText([CHUNK.restricted, CHUNK.open]));
      assert.deepEqual(await visible('rag_chunks_visible', ids, memberB), sortText([CHUNK.open, CHUNK.lineV2]), 'superseded chunk excluded');
      assert.deepEqual(await visible('rag_chunks_visible', ids, outsider), [CHUNK.open]);
      assert.deepEqual(
        await visible('rag_chunks_visible', ids, null, true),
        sortText([CHUNK.restricted, CHUNK.open, CHUNK.lineV2]),
        'access_all skips the label check only, never the tenant',
      );
      // A chunk whose own label drifted from its document is hidden even when the document label matches (D-12).
      await db.exec('ALTER TABLE document_chunks DISABLE TRIGGER document_chunks_access_groups_from_document');
      try {
        await db.query("UPDATE document_chunks SET access_groups = '{all}' WHERE id = $1", [CHUNK.restricted]);
        assert.deepEqual(await visible('rag_chunks_visible', [CHUNK.restricted], outsider), [], 'document label still applies');
        await db.query('UPDATE document_chunks SET access_groups = $2::text[] WHERE id = $1', [CHUNK.restricted, [`u:${OUTSIDER}`]]);
        await db.query('UPDATE documents SET access_groups = $2::text[] WHERE id = $1', [DOC.restricted, ['all']]);
        await db.query('UPDATE document_chunks SET access_groups = $2::text[] WHERE id = $1', [CHUNK.restricted, [`g:${fx.groupA}`]]);
        assert.deepEqual(await visible('rag_chunks_visible', [CHUNK.restricted], outsider), [], 'chunk label still applies');
      } finally {
        await db.exec('ALTER TABLE document_chunks ENABLE TRIGGER document_chunks_access_groups_from_document');
        await db.query('UPDATE documents SET access_groups = $2::text[] WHERE id = $1', [DOC.restricted, [`g:${fx.groupA}`]]);
      }
      await rejects(() => visible('rag_chunks_visible', ids, []), /access_keys_empty/, 'empty keys');
    });

    test('rag_documents_visible returns in-tenant document ids of any version visible through the label', async () => {
      const ids = [DOC.restricted, DOC.open, DOC.lineV1, DOC.lineV2, ...(multi ? [DOC.other] : []), id('9229', 5)];
      const memberA = keysOf(MEMBER_A, (await resolve(MEMBER_A)).group_ids);
      const memberB = keysOf(MEMBER_B, (await resolve(MEMBER_B)).group_ids);
      assert.deepEqual(await visible('rag_documents_visible', ids, memberA), sortText([DOC.restricted, DOC.open]));
      assert.deepEqual(await visible('rag_documents_visible', ids, memberB), sortText([DOC.open, DOC.lineV1, DOC.lineV2]), 'superseded version included');
      assert.deepEqual(
        await visible('rag_documents_visible', ids, null, true),
        sortText([DOC.restricted, DOC.open, DOC.lineV1, DOC.lineV2]),
        'access_all returns every tenant id and no other',
      );
    });

    test('rag_access_set_enforced writes the single flag, reads it back and audits only a change', async () => {
      await assertFunction(db, 'rag_access_set_enforced');
      const count = async (): Promise<number> =>
        (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM rag_access_audit WHERE action = 'enforcement_set'")).rows[0]!.n;
      const set = async (value: boolean): Promise<boolean> =>
        (await service(db, () => db.query<{ v: boolean }>('SELECT public.rag_access_set_enforced($1) AS v', [value]))).rows[0]!.v;
      const read = async (): Promise<boolean> =>
        (await service(db, () => db.query<{ v: boolean }>('SELECT public.rag_access_enforced() AS v'))).rows[0]!.v;
      const start = await count();
      try {
        assert.equal(await set(true), true);
        assert.equal(await read(), true);
        assert.equal(await count(), start + 1);
        const audit = await db.query<Row>(
          "SELECT tenant_key, actor, actor_kind, reason FROM rag_access_audit WHERE action = 'enforcement_set' ORDER BY created_at DESC, id DESC LIMIT 1",
        );
        assert.deepEqual(audit.rows[0], { tenant_key: 'deployment', actor: null, actor_kind: 'system', reason: 'enforced_on' });
        assert.equal(await set(true), true);
        assert.equal(await count(), start + 1, 'the same value writes no audit row');
        assert.equal(await set(false), false);
        assert.equal(await read(), false);
        assert.equal(await count(), start + 2, 'switching back writes one');
        await db.query('DELETE FROM rag_access_group_settings');
        assert.equal(await read(), false, 'a missing row reads false');
        assert.equal(await set(false), false, 'the row is recreated');
        assert.equal((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_access_group_settings')).rows[0]!.n, 1);
        await rejects(() => service(db, () => db.query('SELECT public.rag_access_set_enforced(NULL)')), /^enforced_required/, 'null');
        await rejects(
          () => db.query("INSERT INTO rag_access_audit (tenant_key, action, actor_kind) VALUES ('deployment', 'document_set', 'system')"),
          /rag_access_audit_tenant_key_check/,
          'deployment is only for the enforcement flag',
        );
      } finally {
        await db.query('UPDATE rag_access_group_settings SET enforced = false');
      }
    });

    test('rag_security_event_record stores ids and the request id only', async () => {
      await assertFunction(db, 'rag_security_event_record');
      const record = (tenantKey: string, event: string, requestId: string | null = 'req-1') =>
        service(db, () =>
          db.query<{ id: string }>('SELECT public.rag_security_event_record($1, $2, $3, $4::uuid[], $5::uuid[], $6)::text AS id', [
            tenantKey,
            OUTSIDER,
            event,
            [CHUNK.restricted],
            [DOC.restricted],
            requestId,
          ]),
        );
      const created = (await record(fx.tenantKey, 'citation_access_violation')).rows[0]!.id;
      const row = (
        await db.query<Row>(
          'SELECT tenant_key, user_id::text, event, chunk_ids::text[], document_ids::text[], request_id FROM rag_access_security_events WHERE id = $1',
          [created],
        )
      ).rows[0];
      assert.deepEqual(row, {
        tenant_key: fx.tenantKey,
        user_id: OUTSIDER,
        event: 'citation_access_violation',
        chunk_ids: [CHUNK.restricted],
        document_ids: [DOC.restricted],
        request_id: 'req-1',
      });
      const nullIds = await service(db, () =>
        db.query<{ id: string }>("SELECT public.rag_security_event_record($1, NULL, 'citation_access_violation', NULL, NULL, NULL)::text AS id", [fx.tenantKey]),
      );
      const stored = await db.query<Row>('SELECT chunk_ids::text[], document_ids::text[] FROM rag_access_security_events WHERE id = $1', [nullIds.rows[0]!.id]);
      assert.deepEqual(stored.rows[0], { chunk_ids: [], document_ids: [] });
      await rejects(() => record(fx.tenantKey, 'something_else'), /rag_access_security_events_event_check/, 'event outside the CHECK');
      await rejects(() => record(multi ? 's:default' : `o:${ORG}`, 'citation_access_violation'), /tenant key/, 'tenant key of the other mode');
    });

    test('every 0923 resolution function is executable by service_role only', async () => {
      const rows = await db.query<{ sig: string; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `SELECT p.oid::regprocedure::text AS sig,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
                EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
        [
          [
            'rag_access_enforced',
            'rag_resolve_access_scope',
            'rag_access_group_by_key',
            'rag_access_user_in_tenant',
            'rag_set_document_access_groups',
            'rag_chunks_visible',
            'rag_documents_visible',
            'rag_access_set_enforced',
            'rag_security_event_record',
          ],
        ],
      );
      assert.equal(rows.rows.length, 9, 'nine functions');
      for (const row of rows.rows) {
        assert.deepEqual({ sig: row.sig, anon: row.anon, auth: row.auth, svc: row.svc, pub: row.pub }, { sig: row.sig, anon: false, auth: false, svc: true, pub: false });
      }
      await rejects(
        () => asRole(db, 'authenticated', MEMBER_A, () => db.query('SELECT * FROM public.rag_resolve_access_scope($1, $2)', [fx.tenantKey, MEMBER_A])),
        /permission denied/,
        'authenticated call',
      );
    });
  });
}
