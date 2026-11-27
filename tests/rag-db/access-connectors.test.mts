import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 plan 30 (DATA-22, D-20 to D-22, A-07, A-10): the service-role connector functions of 0925 in both deployment modes. Source
// principals become access keys in one audited, fail-closed call; addresses match tenant members without being returned; admins maintain
// mappings and sharing rules. Fixtures are neutral synthetic values (example.org, source-group-1).

type Role = 'anon' | 'authenticated' | 'service_role';

const CORPUS_DIR = path.resolve(import.meta.dirname, '../../eval/fixtures/corpus');
const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const OWNER = id('9251', 1);
const MEMBER_A = id('9251', 2);
const MEMBER_B = id('9251', 3);
const OUTSIDER = id('9251', 4);
const UNCONFIRMED = id('9251', 5);
const ORG = id('9252', 1);
const OTHER_ORG = id('9252', 2);

const DOC = {
  synced: id('9253', 1),
  syncedV2: id('9253', 2),
  second: id('9253', 3),
  personal: id('9253', 4),
  other: id('9253', 5),
} as const;

const ADDRESS = {
  owner: 'owner@example.org',
  memberA: 'Member-A@Example.org',
  memberB: 'member-b@example.org',
  outsider: 'outsider@example.org',
  unconfirmed: 'unconfirmed@example.org',
} as const;

const sortText = (values: readonly string[]): string[] => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

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
  otherGroup: string | null;
}

async function insertDoc(
  db: PGlite,
  multi: boolean,
  doc: { id: string; owner?: string; org?: string | null; lineage?: string; version?: number },
): Promise<void> {
  const org = doc.org === undefined ? ORG : doc.org;
  await db.query(
    `INSERT INTO documents (id, filename, content, metadata, user_id, language, lineage_id, version${multi ? ', organization_id' : ''})
     VALUES ($1, $2, 'A neutral synthetic connector record.', '{}'::jsonb, $3, 'en', $4, $5${multi ? ', $6' : ''})`,
    multi
      ? [doc.id, `${doc.id}.md`, doc.owner ?? OWNER, doc.lineage ?? doc.id, doc.version ?? 1, org]
      : [doc.id, `${doc.id}.md`, doc.owner ?? OWNER, doc.lineage ?? doc.id, doc.version ?? 1],
  );
}

async function build(mode: DeploymentMode): Promise<Fixture> {
  const multi = mode === 'multi-tenant';
  const { db } = await createFixtureDatabase({ deploymentMode: mode, corpusDir: CORPUS_DIR, supabaseGrants: true });
  await db.exec('ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz');
  const users: Array<[string, string, boolean]> = [
    [OWNER, ADDRESS.owner, true],
    [MEMBER_A, ADDRESS.memberA.toLowerCase(), true],
    [MEMBER_B, ADDRESS.memberB, true],
    [OUTSIDER, ADDRESS.outsider, true],
    [UNCONFIRMED, ADDRESS.unconfirmed, false],
  ];
  for (const [user, email, confirmed] of users) {
    await db.query(
      'INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, email_confirmed_at = EXCLUDED.email_confirmed_at',
      [user, email, confirmed],
    );
  }
  let groupA: string;
  let groupB: string;
  let otherGroup: string | null = null;
  if (multi) {
    await db.query(
      "INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace one', 'connectors-one', $3, false), ($2, 'Workspace two', 'connectors-two', $4, false)",
      [ORG, OTHER_ORG, OWNER, OUTSIDER],
    );
    await db.query(
      `INSERT INTO organization_members (organization_id, user_id, role) VALUES
         ($1, $3, 'owner'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $7, 'member'), ($2, $6, 'owner')`,
      [ORG, OTHER_ORG, OWNER, MEMBER_A, MEMBER_B, OUTSIDER, UNCONFIRMED],
    );
    const insert = async (key: string, org: string): Promise<string> =>
      (await db.query<{ id: string }>("INSERT INTO rag_access_groups (key, name, organization_id) VALUES ($1, 'Group', $2) RETURNING id", [key, org]))
        .rows[0]!.id;
    groupA = await insert('group-a', ORG);
    groupB = await insert('group-b', ORG);
    otherGroup = await insert('group-a', OTHER_ORG);
  } else {
    const insert = async (key: string): Promise<string> =>
      (await db.query<{ id: string }>("INSERT INTO rag_access_groups (key, name) VALUES ($1, 'Group') RETURNING id", [key])).rows[0]!.id;
    groupA = await insert('group-a');
    groupB = await insert('group-b');
  }

  await insertDoc(db, multi, { id: DOC.synced });
  await insertDoc(db, multi, { id: DOC.syncedV2, lineage: DOC.synced, version: 2 });
  await db.query('UPDATE documents SET is_current = false, superseded_by = $2 WHERE id = $1', [DOC.synced, DOC.syncedV2]);
  await insertDoc(db, multi, { id: DOC.second });
  if (multi) {
    await insertDoc(db, multi, { id: DOC.personal, org: null });
    await insertDoc(db, multi, { id: DOC.other, owner: OUTSIDER, org: OTHER_ORG });
  }
  await db.query(
    `INSERT INTO nango_sync_records (user_id, connection_id, provider, file_id, file_name, document_id, status) VALUES
       ($1, 'connection-1', 'google-drive', 'file-1', 'file-1', $2, 'completed'),
       ($1, 'connection-1', 'google-drive', 'file-2', 'file-2', $3, 'completed')`,
    [OWNER, DOC.syncedV2, DOC.second],
  );
  return { db, tenantKey: multi ? `o:${ORG}` : 's:default', groupA, groupB, otherGroup };
}

interface Applied {
  keys: string[];
  fail_closed: boolean;
  reason: string | null;
}

interface AuditRow {
  actor: string | null;
  actor_kind: string;
  reason: string | null;
  after_groups: string[] | null;
}

for (const mode of ['single-tenant', 'multi-tenant'] as const) {
  const multi = mode === 'multi-tenant';

  describe(`connector access functions (${mode})`, () => {
    let fx: Fixture;
    let db: PGlite;

    const apply = async (
      docId: string,
      principals: unknown[],
      status = 'ok',
      options: { provider?: string; tenantKey?: string; owner?: string } = {},
    ): Promise<Applied> => {
      await assertFunction(db, 'rag_connector_apply_access');
      const rows = await service(db, () =>
        db.query<Applied>('SELECT keys, fail_closed, reason FROM public.rag_connector_apply_access($1, $2, $3, $4::jsonb, $5, $6)', [
          options.tenantKey ?? fx.tenantKey,
          docId,
          options.provider ?? 'google-drive',
          JSON.stringify(principals),
          options.owner ?? OWNER,
          status,
        ]),
      );
      assert.equal(rows.rows.length, 1, 'one row');
      return rows.rows[0]!;
    };

    const labels = async (...docIds: string[]): Promise<string[][]> =>
      (await db.query<{ access_groups: string[] }>('SELECT access_groups FROM documents WHERE id = ANY($1::uuid[]) ORDER BY id', [docIds])).rows.map(
        (r) => r.access_groups,
      );

    const lastAudit = async (lineage: string): Promise<AuditRow | undefined> =>
      (
        await db.query<AuditRow>(
          "SELECT actor, actor_kind, reason, after_groups FROM rag_access_audit WHERE lineage_id = $1 AND action = 'document_set' ORDER BY created_at DESC, id DESC LIMIT 1",
          [lineage],
        )
      ).rows[0];

    const principalRows = async (docId: string): Promise<Array<{ kind: string; external_principal_id: string; mapped: boolean }>> =>
      (
        await db.query<{ kind: string; external_principal_id: string; mapped: boolean }>(
          'SELECT kind, external_principal_id, mapped FROM rag_connector_document_principals WHERE document_id = $1 ORDER BY kind, external_principal_id',
          [docId],
        )
      ).rows;

    before(async () => {
      fx = await build(mode);
      db = fx.db;
      await db.query(
        "INSERT INTO rag_connector_group_map (tenant_key, provider, external_principal_id, kind, group_id) VALUES ($1, 'google-drive', 'source-group-1@example.org', 'group', $2)",
        [fx.tenantKey, fx.groupA],
      );
    });

    after(async () => {
      await db?.close();
    });

    test('a mapped group and a matched member become the label of every version, audited as connector', async () => {
      const applied = await apply(DOC.syncedV2, [
        { kind: 'group', id: '  Source-Group-1@Example.org ' },
        { kind: 'user', member_id: MEMBER_A },
      ]);
      const expected = sortText([`g:${fx.groupA}`, `u:${MEMBER_A}`]);
      assert.deepEqual(applied.keys, expected);
      assert.equal(applied.fail_closed, false);
      assert.deepEqual(await labels(DOC.synced, DOC.syncedV2), [expected, expected], 'every version carries the label');
      const audit = await lastAudit(DOC.synced);
      assert.equal(audit?.actor, null);
      assert.equal(audit?.actor_kind, 'connector');
      assert.deepEqual(audit?.after_groups, expected);
      assert.deepEqual(await principalRows(DOC.syncedV2), [{ kind: 'group', external_principal_id: 'source-group-1@example.org', mapped: true }]);
    });

    test('an unmapped group principal sets the owner only, with reason unmapped_source', async () => {
      const applied = await apply(DOC.syncedV2, [
        { kind: 'group', id: 'source-group-1@example.org' },
        { kind: 'group', id: 'source-group-2@example.org' },
        { kind: 'user', member_id: MEMBER_A },
      ]);
      assert.deepEqual(applied, { keys: [`u:${OWNER}`], fail_closed: true, reason: 'unmapped_source' });
      assert.deepEqual(await labels(DOC.synced, DOC.syncedV2), [[`u:${OWNER}`], [`u:${OWNER}`]]);
      const audit = await lastAudit(DOC.synced);
      assert.equal(audit?.actor_kind, 'connector');
      assert.equal(audit?.reason, 'unmapped_source');
      assert.deepEqual(await principalRows(DOC.syncedV2), [
        { kind: 'group', external_principal_id: 'source-group-1@example.org', mapped: true },
        { kind: 'group', external_principal_id: 'source-group-2@example.org', mapped: false },
      ]);
    });

    test('a user without a matched member id is unmappable and never stored', async () => {
      const applied = await apply(DOC.second, [{ kind: 'group', id: 'source-group-1@example.org' }, { kind: 'user', member_id: null }]);
      assert.deepEqual(applied, { keys: [`u:${OWNER}`], fail_closed: true, reason: 'unmapped_source' });
      const kinds = (await principalRows(DOC.second)).map((r) => r.kind);
      assert.deepEqual(kinds, ['group'], 'no person in the principals table');
      const outsider = await apply(DOC.second, [{ kind: 'user', member_id: id('9259', 9) }]);
      assert.equal(outsider.fail_closed, true, 'an id that is no member of the tenant is unmappable');
    });

    test('a source error sets the owner only, with reason source_error, and replaces the principals', async () => {
      await apply(DOC.syncedV2, [{ kind: 'group', id: 'source-group-1@example.org' }]);
      assert.deepEqual(await labels(DOC.syncedV2), [[`g:${fx.groupA}`]]);
      const applied = await apply(DOC.syncedV2, [{ kind: 'group', id: 'source-group-1@example.org' }], 'source_error');
      assert.deepEqual(applied, { keys: [`u:${OWNER}`], fail_closed: true, reason: 'source_error' });
      assert.deepEqual(await labels(DOC.synced, DOC.syncedV2), [[`u:${OWNER}`], [`u:${OWNER}`]]);
      assert.equal((await lastAudit(DOC.synced))?.reason, 'source_error');
      assert.deepEqual(await principalRows(DOC.syncedV2), [], 'a source error leaves no stale principal');
    });

    test('the label is written while enforcement is off', async () => {
      const flag = await db.query<{ enforced: boolean }>('SELECT public.rag_access_enforced() AS enforced');
      assert.equal(flag.rows[0]?.enforced, false, 'enforcement is off in the fixture');
      await apply(DOC.second, [{ kind: 'group', id: 'source-group-1@example.org' }]);
      assert.deepEqual(await labels(DOC.second), [[`g:${fx.groupA}`]]);
    });

    test('bad input is refused before any write', async () => {
      await apply(DOC.second, [{ kind: 'group', id: 'source-group-1@example.org' }]);
      await rejects(() => apply(DOC.second, [{ kind: 'person', id: 'x' }]), /^invalid_principal/, 'unknown kind');
      await rejects(() => apply(DOC.second, [{ kind: 'group', id: '' }]), /^invalid_principal/, 'empty id');
      await rejects(() => apply(DOC.second, [], 'ok', { provider: 'other' }), /^invalid_provider/, 'provider');
      await rejects(() => apply(DOC.second, [], 'maybe'), /^invalid_status/, 'status');
      await rejects(() => apply(id('9253', 99), []), /^document_not_found/, 'missing document');
      assert.deepEqual(await labels(DOC.second), [[`g:${fx.groupA}`]], 'nothing changed');
      assert.equal((await principalRows(DOC.second)).length, 1);
    });

    const match = async (addresses: Array<string | null>, tenantKey = fx.tenantKey): Promise<Array<{ idx: number; user_id: string }>> => {
      await assertFunction(db, 'rag_connector_match_members');
      return (
        await service(db, () =>
          db.query<{ idx: number; user_id: string }>('SELECT * FROM public.rag_connector_match_members($1, $2::text[]) ORDER BY idx', [
            tenantKey,
            addresses,
          ]),
        )
      ).rows;
    };

    test('member matching returns positions and ids of confirmed tenant members only', async () => {
      const rows = await match([ADDRESS.memberA, 'unknown@example.org', ADDRESS.unconfirmed, null, ` ${ADDRESS.memberB.toUpperCase()} `, ADDRESS.outsider]);
      const expected = [
        { idx: 1, user_id: MEMBER_A },
        { idx: 5, user_id: MEMBER_B },
      ];
      if (!multi) expected.push({ idx: 6, user_id: OUTSIDER });
      assert.deepEqual(rows, expected, multi ? 'a user of another organization does not match' : 'every confirmed user is a single-tenant member');
      for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['idx', 'user_id'], 'no address is returned');
      assert.deepEqual(await match([]), []);
      if (multi) {
        assert.deepEqual(await match([ADDRESS.owner, ADDRESS.memberA], `u:${OWNER}`), [{ idx: 1, user_id: OWNER }], 'a personal tenant has its owner only');
      }
    });

    test('member matching is service-role only and SECURITY DEFINER with an empty search path', async () => {
      await assertFunction(db, 'rag_connector_match_members');
      const info = await db.query<{ secdef: boolean; config: string[] | null }>(
        "SELECT p.prosecdef AS secdef, p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'rag_connector_match_members'",
      );
      assert.equal(info.rows[0]?.secdef, true);
      assert.ok(info.rows[0]?.config?.includes('search_path=""'), 'search_path is empty');
      for (const role of ['anon', 'authenticated'] as const) {
        await rejects(
          () => asRole(db, role, MEMBER_A, () => db.query("SELECT * FROM public.rag_connector_match_members($1, ARRAY['x@example.org'])", [fx.tenantKey])),
          /permission denied/,
          `${role} cannot match addresses`,
        );
      }
    });

    test('domain and link sharing count as everyone only under an enabled rule of that provider', async () => {
      const domain = [{ kind: 'domain', id: ' Example.org ' }];
      assert.equal((await apply(DOC.second, domain)).fail_closed, true, 'no rule');
      await db.query(
        "INSERT INTO rag_connector_sharing_rules (tenant_key, provider, kind, domain, enabled) VALUES ($1, 'google-drive', 'domain', 'example.org', false), ($1, 'dropbox', 'anyone', NULL, true)",
        [fx.tenantKey],
      );
      assert.deepEqual(await apply(DOC.second, domain), { keys: [`u:${OWNER}`], fail_closed: true, reason: 'unmapped_source' }, 'disabled rule');
      assert.equal((await apply(DOC.second, [{ kind: 'anyone' }])).fail_closed, true, 'a rule of another provider does not count');
      await db.query("UPDATE rag_connector_sharing_rules SET enabled = true WHERE tenant_key = $1 AND provider = 'google-drive'", [fx.tenantKey]);
      assert.deepEqual(await apply(DOC.second, [...domain, { kind: 'group', id: 'source-group-1@example.org' }, { kind: 'user', member_id: MEMBER_B }]), {
        keys: ['all'],
        fail_closed: false,
        reason: 'source_mapped',
      });
      assert.deepEqual(await labels(DOC.second), [['all']], 'all alone');
      assert.equal((await apply(DOC.second, [{ kind: 'domain', id: 'other.example.org' }])).fail_closed, true, 'another domain');
      assert.equal((await apply(DOC.second, [{ kind: 'public' }])).fail_closed, true, 'no published rule');
      assert.deepEqual((await apply(DOC.second, [{ kind: 'anyone' }], 'ok', { provider: 'dropbox' })).keys, ['all'], 'enabled link rule');
      await db.query('DELETE FROM rag_connector_sharing_rules WHERE tenant_key = $1', [fx.tenantKey]);
    });

    if (multi) {
      test('a personal-tenant document with a group principal falls back to the owner (A-10)', async () => {
        const applied = await apply(DOC.personal, [{ kind: 'group', id: 'source-group-1@example.org' }], 'ok', { tenantKey: `u:${OWNER}` });
        assert.deepEqual(applied, { keys: [`u:${OWNER}`], fail_closed: true, reason: 'unmapped_source' });
        assert.deepEqual(await labels(DOC.personal), [[`u:${OWNER}`]]);
      });

      test("another tenant's document is not found", async () => {
        await rejects(() => apply(DOC.other, []), /^document_not_found/, 'cross-tenant document');
      });
    }
  });
}
