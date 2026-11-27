import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * 0981 rag_tenant_doc_types (Phase 6.2 D-02, D-06, P-19): the distinct doc types of a tenant's current, ready documents, the
 * doc-type vocabulary of sub-question filters. Hardened like 0601; two-tenant isolation; idempotent re-apply.
 */
const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';
const FN = 'public.rag_tenant_doc_types(text, text[], boolean)';
const OLD_FN = 'public.rag_tenant_doc_types(text)';
const ACCESS_SQL = 'SELECT doc_type, docs FROM public.rag_tenant_doc_types(p_tenant_key => $1, p_access_keys => $2::text[], p_access_all => $3)';
const GROUP_KEY = 'g:00000000-0000-4000-8000-000000986001';
const OUTSIDER_KEYS = ['all', 'u:00000000-0000-4000-8000-000000986002'];
const MEMBER_KEYS = ['all', 'u:00000000-0000-4000-8000-000000986003', GROUP_KEY];

const USER_A = '00000000-0000-4000-8000-0000000062a1';
const USER_B = '00000000-0000-4000-8000-0000000062b1';
const ORG_O = '00000000-0000-4000-8000-0000000062c1';

type Role = 'anon' | 'authenticated' | 'service_role';

interface DocSpec {
  docType: string;
  accessGroups?: string[];
  status?: string;
  isCurrent?: boolean;
  userId?: string;
  organizationId?: string | null;
}

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function insertDocs(db: PGlite, mode: DeploymentMode, specs: DocSpec[]): Promise<void> {
  for (const spec of specs) {
    const id = crypto.randomUUID();
    if (mode === 'multi-tenant') {
      await db.query(
        `INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, lineage_id, source_key, status, is_current, doc_type)
         VALUES ($1, $2, 'placeholder', '{}'::jsonb, $3, $4, $1, $5, $6, $7, $8)`,
        [id, `doc-${id}.md`, spec.userId ?? FIXTURE_USER_ID, spec.organizationId ?? null, `legacy:${id}`, spec.status ?? 'ready', spec.isCurrent ?? true, spec.docType],
      );
    } else {
      await db.query(
        `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key, status, is_current, doc_type)
         VALUES ($1, $2, 'placeholder', '{}'::jsonb, $1, $3, $4, $5, $6)`,
        [id, `doc-${id}.md`, `legacy:${id}`, spec.status ?? 'ready', spec.isCurrent ?? true, spec.docType],
      );
    }
    if (spec.accessGroups) await db.query('UPDATE documents SET access_groups = $2::text[] WHERE id = $1', [id, spec.accessGroups]);
  }
}

async function accessDocTypes(db: PGlite, tenantKey: string, keys: string[] | null, all = false): Promise<Record<string, number>> {
  const result = await asRole(db, 'service_role', () => db.query<{ doc_type: string; docs: string | number }>(ACCESS_SQL, [tenantKey, keys, all]));
  return Object.fromEntries(result.rows.map((row) => [row.doc_type, Number(row.docs)]));
}

async function failure(db: PGlite, run: () => Promise<unknown>): Promise<{ message: string; code: string } | null> {
  await db.exec('SAVEPOINT doc_types_case');
  try {
    await run();
    return null;
  } catch (error) {
    return { message: (error as Error).message, code: codeOf(error) };
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT doc_types_case');
  }
}

async function docTypes(db: PGlite, tenantKey: string | null): Promise<Record<string, number>> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ doc_type: string; docs: string | number }>('SELECT doc_type, docs FROM public.rag_tenant_doc_types($1)', [tenantKey]),
  );
  return Object.fromEntries(result.rows.map((row) => [row.doc_type, Number(row.docs)]));
}

function excludedRows(): DocSpec[] {
  return [
    { docType: 'invoice_receipt', isCurrent: false },
    { docType: 'invoice_receipt', status: 'processing' },
    { docType: 'invoice_receipt', status: 'quarantined' },
    { docType: 'invoice_receipt', status: 'pending_review' },
    { docType: 'invoice_receipt', status: 'failed' },
  ];
}

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const wrongModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`rag_tenant_doc_types (${mode})`, () => {
    let db: PGlite;
    let edge: FakeEdge;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      edge = await startFakeEdge({ db, serviceKeys: [SERVICE_KEY], anonKey: ANON_KEY });
    });

    after(async () => {
      await edge?.close();
      await db?.close();
    });

    test('a tenant without documents gets an empty result', async () => {
      assert.deepEqual(await docTypes(db, tenant), {});
    });

    test('distinct doc types of current ready documents; non-current, non-ready, quarantined and pending_review never count', async () => {
      await insertDocs(db, mode, [
        ...Array.from({ length: 3 }, () => ({ docType: 'general' })),
        { docType: 'product_technical' },
        ...excludedRows(),
      ]);
      assert.deepEqual(await docTypes(db, tenant), { general: 3, product_technical: 1 });
    });

    for (const [label, key] of [
      ['NULL', null],
      ['x:1', 'x:1'],
      ['an upper-case uuid', `u:${FIXTURE_USER_ID.toUpperCase()}`],
      ['the other mode key', wrongModeKey],
    ] as const) {
      test(`${label} key raises 22023`, async () => {
        await assert.rejects(() => docTypes(db, key), (error: unknown) => codeOf(error) === '22023');
      });
    }

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501`, async () => {
        await assert.rejects(
          () => asRole(db, role, () => db.query('SELECT * FROM public.rag_tenant_doc_types($1)', [tenant])),
          (error: unknown) => codeOf(error) === '42501',
        );
      });
    }

    test('PUBLIC has no execute grant and only service_role of the API roles may execute', async () => {
      const result = await db.query<{ grantee: string }>(
        `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee
         FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(p.proacl) a
         LEFT JOIN pg_roles r ON r.oid = a.grantee
         WHERE p.oid = '${FN}'::regprocedure AND a.privilege_type = 'EXECUTE'`,
      );
      const grantees = result.rows.map((row) => row.grantee);
      assert.ok(!grantees.includes('PUBLIC'));
      assert.ok(!grantees.includes('anon'));
      assert.ok(!grantees.includes('authenticated'));
      assert.ok(grantees.includes('service_role'));
    });

    test('the function is SECURITY INVOKER with an empty search_path', async () => {
      const result = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = '${FN}'::regprocedure`,
      );
      assert.equal(result.rows[0]?.prosecdef, false);
      assert.ok((result.rows[0]?.proconfig ?? []).some((entry) => entry === 'search_path=""' || entry === "search_path=''"));
    });

    const rpc = async (apikey: string) => {
      const res = await fetch(`${edge.url}/rest/v1/rpc/rag_tenant_doc_types`, {
        method: 'POST',
        headers: { apikey, 'content-type': 'application/json' },
        body: JSON.stringify({ p_tenant_key: tenant }),
      });
      return { status: res.status, body: (await res.json()) as { code?: string; message?: string } };
    };

    test('the fake edge refuses the anon key with 42501', async () => {
      const res = await rpc(ANON_KEY);
      assert.equal(res.status, 403);
      assert.equal(res.body.code, '42501');
    });

    test('the fake edge returns rows for the service key', async () => {
      const res = await rpc(SERVICE_KEY);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    test('applying every migration a second time succeeds and keeps the grants and rows', async () => {
      const before = await docTypes(db, tenant);
      await applyMigrations(db, mode);
      assert.deepEqual(await docTypes(db, tenant), before);
      await assert.rejects(
        () => asRole(db, 'anon', () => db.query('SELECT * FROM public.rag_tenant_doc_types($1)', [tenant])),
        (error: unknown) => codeOf(error) === '42501',
      );
    });
  });
}

describe('rag_tenant_doc_types two-tenant isolation', () => {
  let db: PGlite;

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' }));
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [
      USER_A,
      'tenant-a@example.invalid',
      USER_B,
      'tenant-b@example.invalid',
    ]);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
      ORG_O,
      'Tenant O',
      'tenant-o-doc-types',
      USER_A,
    ]);
    await insertDocs(db, 'multi-tenant', [
      { docType: 'general', userId: USER_A },
      { docType: 'contract_legal', userId: USER_B },
      { docType: 'product_technical', userId: USER_A, organizationId: ORG_O },
      { docType: 'scanned_image', userId: USER_B, isCurrent: false },
    ]);
  });

  after(async () => {
    await db?.close();
  });

  test("tenant A sees only its own doc types, never B's", async () => {
    assert.deepEqual(await docTypes(db, `u:${USER_A}`), { general: 1 });
  });

  test("tenant B sees only its own doc types, never A's", async () => {
    assert.deepEqual(await docTypes(db, `u:${USER_B}`), { contract_legal: 1 });
  });

  test("the organization tenant sees only the organization's documents", async () => {
    assert.deepEqual(await docTypes(db, `o:${ORG_O}`), { product_technical: 1 });
  });

  test('a well-formed key with no documents gets nothing from other tenants', async () => {
    assert.deepEqual(await docTypes(db, `u:${crypto.randomUUID()}`), {});
  });
});

/**
 * Quick task doc-types-access (migration 0986): rag_tenant_doc_types takes the access filter of the other retrieval RPCs, so a caller
 * outside a document's access groups never sees that document's doc type in the sub-question filter vocabulary. Without keys the answer
 * is the one 0981 gave.
 */
for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';

  describe(`rag_tenant_doc_types access filter (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
      await insertDocs(db, mode, [
        { docType: 'general' },
        { docType: 'general', accessGroups: [GROUP_KEY] },
        { docType: 'contract_legal', accessGroups: [GROUP_KEY] },
        { docType: 'contract_legal', accessGroups: [GROUP_KEY], isCurrent: false },
      ]);
    });

    after(async () => {
      await db?.close();
    });

    test('exactly one overload, with the access parameters; the 0981 signature is gone', async () => {
      const old = await db.query<{ oid: string | null }>('SELECT to_regprocedure($1) AS oid', [OLD_FN]);
      assert.equal(old.rows[0]?.oid, null);
      const overloads = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'rag_tenant_doc_types'`,
      );
      assert.equal(overloads.rows[0]?.n, 1);
      const result = await db.query<{ provolatile: string }>(`SELECT provolatile FROM pg_proc WHERE oid = '${FN}'::regprocedure`);
      assert.equal(result.rows[0]?.provolatile, 's');
    });

    test('no keys (access off): the 0981 answer, restricted documents included', async () => {
      assert.deepEqual(await docTypes(db, tenant), { general: 2, contract_legal: 1 });
      assert.deepEqual(await accessDocTypes(db, tenant, null), { general: 2, contract_legal: 1 });
    });

    test('outsider keys: a doc type carried only by restricted documents is not listed, and counts leave them out', async () => {
      assert.deepEqual(await accessDocTypes(db, tenant, OUTSIDER_KEYS), { general: 1 });
    });

    test('member keys and admin_all: the restricted doc type is listed', async () => {
      assert.deepEqual(await accessDocTypes(db, tenant, MEMBER_KEYS), { general: 2, contract_legal: 1 });
      assert.deepEqual(await accessDocTypes(db, tenant, ['all'], true), { general: 2, contract_legal: 1 });
    });

    test('guard: no keys while enforcement is on raises access_scope_required; empty or NULL-holding keys raise access_keys_empty', async () => {
      await db.exec('BEGIN');
      try {
        await db.query('UPDATE public.rag_access_group_settings SET enforced = true');
        const failed = await failure(db, () => docTypes(db, tenant));
        assert.deepEqual(failed, { message: 'access_scope_required', code: '42501' });
        assert.deepEqual(await accessDocTypes(db, tenant, OUTSIDER_KEYS), { general: 1 });
      } finally {
        await db.exec('ROLLBACK');
      }
      for (const keys of [[], ['all', null]] as unknown as string[][]) {
        await db.exec('BEGIN');
        try {
          assert.deepEqual(await failure(db, () => accessDocTypes(db, tenant, keys)), { message: 'access_keys_empty', code: '22023' });
        } finally {
          await db.exec('ROLLBACK');
        }
      }
    });

    test('the tenant check still runs first: a wrong-mode key raises 22023 with any keys', async () => {
      const wrong = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;
      await assert.rejects(() => accessDocTypes(db, wrong, MEMBER_KEYS), (error: unknown) => codeOf(error) === '22023');
    });
  });
}
