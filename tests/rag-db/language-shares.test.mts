import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { startFakeEdge, type FakeEdge } from '../../eval/harness/fake-edge.mts';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const ANON_KEY = 'fixture-anon-key-placeholder';
const SERVICE_KEY = 'fixture-service-role-key-placeholder';

const USER_A = '00000000-0000-4000-8000-0000000006a1';
const USER_B = '00000000-0000-4000-8000-0000000006b1';
const ORG_O = '00000000-0000-4000-8000-0000000006c1';

type Role = 'anon' | 'authenticated' | 'service_role';

interface ShareRow {
  language: string;
  share: number;
  docs: number;
}

interface DocSpec {
  language: string | null;
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
        `INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, lineage_id, source_key, status, is_current, language)
         VALUES ($1, $2, 'placeholder', '{}'::jsonb, $3, $4, $1, $5, $6, $7, $8)`,
        [id, `doc-${id}.md`, spec.userId ?? FIXTURE_USER_ID, spec.organizationId ?? null, `legacy:${id}`, spec.status ?? 'ready', spec.isCurrent ?? true, spec.language],
      );
    } else {
      await db.query(
        `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key, status, is_current, language)
         VALUES ($1, $2, 'placeholder', '{}'::jsonb, $1, $3, $4, $5, $6)`,
        [id, `doc-${id}.md`, `legacy:${id}`, spec.status ?? 'ready', spec.isCurrent ?? true, spec.language],
      );
    }
  }
}

async function shares(db: PGlite, tenantKey: string | null): Promise<ShareRow[]> {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ language: string; share: number; docs: string | number }>(
      'SELECT language, share, docs FROM public.rag_tenant_language_shares($1) ORDER BY language',
      [tenantKey],
    ),
  );
  return result.rows.map((row) => ({ language: row.language, share: Number(row.share), docs: Number(row.docs) }));
}

function byLanguage(rows: ShareRow[]): Record<string, { share: number; docs: number }> {
  return Object.fromEntries(rows.map((row) => [row.language, { share: row.share, docs: row.docs }]));
}

function excludedRows(): DocSpec[] {
  return [
    { language: 'it', isCurrent: false },
    { language: 'it', status: 'processing' },
    { language: 'it', status: 'quarantined' },
    { language: 'it', status: 'failed' },
    { language: null },
  ];
}

for (const mode of ['multi-tenant', 'single-tenant'] as DeploymentMode[]) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const wrongModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`rag_tenant_language_shares (${mode})`, () => {
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
      assert.deepEqual(await shares(db, tenant), []);
    });

    test('current ready documents give per-language shares summing to 1; non-current, non-ready and NULL language never count', async () => {
      await insertDocs(db, mode, [
        ...Array.from({ length: 6 }, () => ({ language: 'zh' })),
        ...Array.from({ length: 2 }, () => ({ language: 'en' })),
        ...excludedRows(),
      ]);
      const rows = await shares(db, tenant);
      const map = byLanguage(rows);
      assert.deepEqual(Object.keys(map).sort(), ['en', 'zh']);
      assert.equal(map.zh?.docs, 6);
      assert.equal(map.en?.docs, 2);
      assert.ok(Math.abs((map.zh?.share ?? 0) - 0.75) < 1e-9);
      assert.ok(Math.abs((map.en?.share ?? 0) - 0.25) < 1e-9);
      assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
    });

    for (const [label, key] of [
      ['NULL', null],
      ['x:1', 'x:1'],
      ['an upper-case uuid', `u:${FIXTURE_USER_ID.toUpperCase()}`],
      ['the other mode key', wrongModeKey],
    ] as const) {
      test(`${label} key raises 22023`, async () => {
        await assert.rejects(() => shares(db, key), (error: unknown) => codeOf(error) === '22023');
      });
    }

    for (const role of ['anon', 'authenticated'] as const) {
      test(`${role} gets 42501`, async () => {
        await assert.rejects(
          () => asRole(db, role, () => db.query('SELECT * FROM public.rag_tenant_language_shares($1)', [tenant])),
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
         WHERE p.oid = 'public.rag_tenant_language_shares(text)'::regprocedure AND a.privilege_type = 'EXECUTE'`,
      );
      const grantees = result.rows.map((row) => row.grantee);
      assert.ok(!grantees.includes('PUBLIC'));
      assert.ok(!grantees.includes('anon'));
      assert.ok(!grantees.includes('authenticated'));
      assert.ok(grantees.includes('service_role'));
    });

    test('the function is SECURITY INVOKER with an empty search_path', async () => {
      const result = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.rag_tenant_language_shares(text)'::regprocedure`,
      );
      assert.equal(result.rows[0]?.prosecdef, false);
      assert.ok((result.rows[0]?.proconfig ?? []).some((entry) => entry === 'search_path=""' || entry === "search_path=''"));
    });

    const rpc = async (apikey: string) => {
      const res = await fetch(`${edge.url}/rest/v1/rpc/rag_tenant_language_shares`, {
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
      assert.match(String(res.body.message ?? ''), /rag_tenant_language_shares/);
    });

    test('the fake edge returns rows for the service key', async () => {
      const res = await rpc(SERVICE_KEY);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    test('applying every migration a second time succeeds and keeps the grants and shares', async () => {
      const before = await shares(db, tenant);
      await applyMigrations(db, mode);
      assert.deepEqual(await shares(db, tenant), before);
      await assert.rejects(
        () => asRole(db, 'anon', () => db.query('SELECT * FROM public.rag_tenant_language_shares($1)', [tenant])),
        (error: unknown) => codeOf(error) === '42501',
      );
    });
  });
}

describe('rag_tenant_language_shares two-tenant isolation', () => {
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
      'tenant-o-shares',
      USER_A,
    ]);
    await insertDocs(db, 'multi-tenant', [
      ...Array.from({ length: 3 }, () => ({ language: 'zh', userId: USER_A })),
      { language: 'it', userId: USER_B },
      ...Array.from({ length: 3 }, () => ({ language: 'en', userId: USER_B })),
      { language: 'de', userId: USER_A, organizationId: ORG_O },
      { language: 'fr', userId: USER_A, isCurrent: false },
      { language: 'fr', userId: USER_B, status: 'processing' },
    ]);
  });

  after(async () => {
    await db?.close();
  });

  test('tenant A sees only its own zh documents', async () => {
    assert.deepEqual(byLanguage(await shares(db, `u:${USER_A}`)), { zh: { share: 1, docs: 3 } });
  });

  test('tenant B sees only its own it and en documents', async () => {
    const map = byLanguage(await shares(db, `u:${USER_B}`));
    assert.deepEqual(Object.keys(map).sort(), ['en', 'it']);
    assert.equal(map.en?.docs, 3);
    assert.equal(map.it?.docs, 1);
    assert.ok(Math.abs((map.en?.share ?? 0) - 0.75) < 1e-9);
    assert.ok(Math.abs((map.it?.share ?? 0) - 0.25) < 1e-9);
  });

  test("the organization tenant sees only the organization's documents, not its member's personal ones", async () => {
    assert.deepEqual(byLanguage(await shares(db, `o:${ORG_O}`)), { de: { share: 1, docs: 1 } });
  });

  test('a well-formed key with no documents gets nothing from other tenants', async () => {
    assert.deepEqual(await shares(db, `u:${crypto.randomUUID()}`), []);
  });
});
