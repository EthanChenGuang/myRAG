import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const USER_A = '00000000-0000-4000-8000-0000000006a3';
const USER_B = '00000000-0000-4000-8000-0000000006b3';
const USER_C = '00000000-0000-4000-8000-0000000006c3';
const ORG_O = '00000000-0000-4000-8000-0000000006d3';
const TENANT_A = `u:${USER_A}`;
const TENANT_B = `u:${USER_B}`;
const TENANT_C = `u:${USER_C}`;
const TENANT_O = `o:${ORG_O}`;

type Role = 'anon' | 'authenticated' | 'service_role';

const TRIGGER_FUNCTIONS = [
  'public.rag_semantic_cache_on_documents_insert()',
  'public.rag_semantic_cache_on_documents_update()',
  'public.rag_semantic_cache_on_documents_delete()',
];

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
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

async function seedCache(db: PGlite, tenantKey: string, rows = 2): Promise<void> {
  for (let i = 0; i < rows; i += 1) {
    await db.query(
      `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, is_refusal, expires_at)
       VALUES ($1, $2, 'p1', '[1,0,0,0]'::halfvec, 'masked placeholder', '{}'::jsonb, '[]'::jsonb, false, now() + interval '1 hour')`,
      [tenantKey, crypto.randomBytes(32).toString('hex')],
    );
  }
}

async function cacheCount(db: PGlite, tenantKey: string): Promise<number> {
  const result = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE tenant_key = $1', [tenantKey]);
  return result.rows[0]!.n;
}

const INSERT_DOC = `INSERT INTO documents (id, filename, content, metadata, user_id, organization_id, lineage_id, source_key, status, is_current, version)
  VALUES ($1, $2, 'placeholder', '{}'::jsonb, $3, $4, $5, $6, $7, $8, $9)`;

interface DocSpec {
  userId: string;
  organizationId?: string | null;
  status?: string;
  isCurrent?: boolean;
  version?: number;
  lineageId?: string;
  sourceKey?: string;
}

function docParams(id: string, spec: DocSpec): unknown[] {
  return [
    id,
    `doc-${id}.md`,
    spec.userId,
    spec.organizationId ?? null,
    spec.lineageId ?? id,
    spec.sourceKey ?? `legacy:${id}`,
    spec.status ?? 'ready',
    spec.isCurrent ?? true,
    spec.version ?? 1,
  ];
}

async function insertDoc(db: PGlite, spec: DocSpec): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(INSERT_DOC, docParams(id, spec));
  return id;
}

describe('semantic cache invalidation triggers on documents', () => {
  let db: PGlite;

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' }));
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4), ($5, $6)', [
      USER_A,
      'tenant-a@example.invalid',
      USER_B,
      'tenant-b@example.invalid',
      USER_C,
      'tenant-c@example.invalid',
    ]);
    await db.query('INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, $2, $3, $4, false)', [
      ORG_O,
      'Tenant O',
      'tenant-o-cache',
      USER_A,
    ]);
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    await seedCache(db, TENANT_A);
    await seedCache(db, TENANT_B);
  });

  test("inserting a document as service_role deletes the tenant's rows and leaves other tenants'", async () => {
    await asRole(db, 'service_role', null, () => db.query(INSERT_DOC, docParams(crypto.randomUUID(), { userId: USER_A })));
    assert.equal(await cacheCount(db, TENANT_A), 0);
    assert.equal(await cacheCount(db, TENANT_B), 2);
  });

  test("inserting a document as the authenticated owner through the legacy path deletes the tenant's rows", async () => {
    await asRole(db, 'authenticated', USER_A, () =>
      db.query(`INSERT INTO documents (filename, content, metadata, user_id) VALUES ('legacy.md', 'placeholder', '{}'::jsonb, $1)`, [USER_A]),
    );
    assert.equal(await cacheCount(db, TENANT_A), 0);
    assert.equal(await cacheCount(db, TENANT_B), 2);
  });

  test('the authenticated owner still cannot read or delete cache rows directly', async () => {
    await assert.rejects(
      () => asRole(db, 'authenticated', USER_A, () => db.query('DELETE FROM public.rag_semantic_cache')),
      (error: unknown) => codeOf(error) === '42501',
    );
  });

  test('the invalidation is part of the inserting transaction: a rollback keeps the rows', async () => {
    await db.exec('BEGIN');
    await db.query(INSERT_DOC, docParams(crypto.randomUUID(), { userId: USER_A }));
    assert.equal(await cacheCount(db, TENANT_A), 0);
    await db.exec('ROLLBACK');
    assert.equal(await cacheCount(db, TENANT_A), 2);
  });

  test("rag_publish_document_version deletes the tenant's rows; a rolled-back publish keeps them", async () => {
    const lineage = crypto.randomUUID();
    const sourceKey = `upload:${lineage}`;
    await insertDoc(db, { userId: USER_A, lineageId: lineage, sourceKey });
    const v2 = await insertDoc(db, { userId: USER_A, lineageId: lineage, sourceKey, status: 'processing', isCurrent: false, version: 2 });
    await seedCache(db, TENANT_A);

    await db.exec('BEGIN');
    await asRole(db, 'service_role', null, () => db.query('SELECT * FROM rag_publish_document_version($1, $2)', [v2, TENANT_A]));
    assert.equal(await cacheCount(db, TENANT_A), 0);
    await db.exec('ROLLBACK');
    assert.equal(await cacheCount(db, TENANT_A), 2);

    const published = await asRole(db, 'service_role', null, () =>
      db.query<{ outcome: string }>('SELECT outcome FROM rag_publish_document_version($1, $2)', [v2, TENANT_A]),
    );
    assert.equal(published.rows[0]?.outcome, 'published');
    assert.equal(await cacheCount(db, TENANT_A), 0);
    assert.equal(await cacheCount(db, TENANT_B), 2);
  });

  test("a soft delete (is_current false, status deleted) deletes the tenant's rows", async () => {
    const doc = await insertDoc(db, { userId: USER_A });
    await seedCache(db, TENANT_A);
    await asRole(db, 'service_role', null, () =>
      db.query("UPDATE documents SET is_current = false, status = 'deleted' WHERE id = $1", [doc]),
    );
    assert.equal(await cacheCount(db, TENANT_A), 0);
    assert.equal(await cacheCount(db, TENANT_B), 2);
  });

  test('an UPDATE that changes only processing-progress columns keeps the rows', async () => {
    const doc = await insertDoc(db, { userId: USER_A, status: 'processing', isCurrent: false });
    await seedCache(db, TENANT_A);
    await asRole(db, 'service_role', null, () =>
      db.query(
        `UPDATE documents SET processing_status = 'chunking', processing_state = '{"progress": 0.5}'::jsonb, needs_review = true, filename = 'renamed.md'
         WHERE id = $1`,
        [doc],
      ),
    );
    await asRole(db, 'service_role', null, () =>
      db.query("UPDATE documents SET status = 'processing', is_current = false, version = version WHERE id = $1", [doc]),
    );
    assert.equal(await cacheCount(db, TENANT_A), 2);
  });

  for (const [label, change] of [
    ['is_current', 'UPDATE documents SET is_current = false WHERE id = $1'],
    ['status', "UPDATE documents SET status = 'quarantined' WHERE id = $1"],
    ['version', 'UPDATE documents SET version = version + 1 WHERE id = $1'],
  ] as const) {
    test(`an UPDATE of ${label} deletes the tenant's rows only`, async () => {
      const doc = await insertDoc(db, { userId: USER_A });
      await seedCache(db, TENANT_A);
      await asRole(db, 'service_role', null, () => db.query(change, [doc]));
      assert.equal(await cacheCount(db, TENANT_A), 0);
      assert.equal(await cacheCount(db, TENANT_B), 2);
    });
  }

  test('moving a document to an organization deletes the rows of both the old and the new tenant', async () => {
    const doc = await insertDoc(db, { userId: USER_A });
    await seedCache(db, TENANT_A);
    await seedCache(db, TENANT_O);
    await db.query('UPDATE documents SET organization_id = $2 WHERE id = $1', [doc, ORG_O]);
    assert.equal(await cacheCount(db, TENANT_A), 0);
    assert.equal(await cacheCount(db, TENANT_O), 0);
    assert.equal(await cacheCount(db, TENANT_B), 2);
  });

  test("a hard DELETE of a document deletes the tenant's rows, also when the authenticated owner deletes it", async () => {
    const doc = await insertDoc(db, { userId: USER_A });
    await seedCache(db, TENANT_A);
    await asRole(db, 'service_role', null, () => db.query('DELETE FROM documents WHERE id = $1', [doc]));
    assert.equal(await cacheCount(db, TENANT_A), 0);

    const own = await insertDoc(db, { userId: USER_A });
    await seedCache(db, TENANT_A);
    const deleted = await asRole(db, 'authenticated', USER_A, () => db.query('DELETE FROM documents WHERE id = $1', [own]));
    assert.equal(deleted.affectedRows, 1);
    assert.equal(await cacheCount(db, TENANT_A), 0);
    assert.equal(await cacheCount(db, TENANT_B), 2);
  });

  test('one statement touching two tenants deletes both tenants and no third', async () => {
    const docA = await insertDoc(db, { userId: USER_A });
    const docB = await insertDoc(db, { userId: USER_B });
    await seedCache(db, TENANT_A);
    await seedCache(db, TENANT_B);
    await seedCache(db, TENANT_C);
    await db.query('UPDATE documents SET is_current = false WHERE id = ANY($1::uuid[])', [[docA, docB]]);
    assert.equal(await cacheCount(db, TENANT_A), 0);
    assert.equal(await cacheCount(db, TENANT_B), 0);
    assert.equal(await cacheCount(db, TENANT_C), 2);
  });

  test('a statement that changes no rows deletes nothing', async () => {
    await db.query('UPDATE documents SET is_current = false WHERE id = $1', [crypto.randomUUID()]);
    await db.query('DELETE FROM documents WHERE id = $1', [crypto.randomUUID()]);
    assert.equal(await cacheCount(db, TENANT_A), 2);
    assert.equal(await cacheCount(db, TENANT_B), 2);
  });

  test('three single-event FOR EACH STATEMENT triggers exist on documents', async () => {
    const result = await db.query<{ tgname: string; tgtype: number }>(
      "SELECT tgname, tgtype FROM pg_trigger WHERE tgrelid = 'public.documents'::regclass AND tgname LIKE 'rag_semantic_cache_%' ORDER BY tgname",
    );
    assert.equal(result.rows.length, 3);
    for (const row of result.rows) {
      assert.equal(row.tgtype & 1, 0, `${row.tgname} is FOR EACH STATEMENT`);
    }
  });

  for (const signature of TRIGGER_FUNCTIONS) {
    test(`${signature} is SECURITY DEFINER with an empty search_path and no API-role execute grant`, async () => {
      const meta = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
        `SELECT prosecdef, proconfig FROM pg_proc WHERE oid = '${signature}'::regprocedure`,
      );
      assert.equal(meta.rows[0]?.prosecdef, true);
      assert.ok((meta.rows[0]?.proconfig ?? []).some((entry) => entry === 'search_path=""' || entry === "search_path=''"));
      for (const role of ['anon', 'authenticated']) {
        const ok = await db.query<{ ok: boolean }>('SELECT has_function_privilege($1, $2, $3) AS ok', [role, signature, 'EXECUTE']);
        assert.equal(ok.rows[0]?.ok, false, role);
      }
      const acl = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
         WHERE p.oid = '${signature}'::regprocedure AND a.grantee = 0`,
      );
      assert.equal(acl.rows[0]?.n, 0);
    });
  }
});

describe('semantic cache invalidation triggers (single-tenant)', () => {
  let db: PGlite;

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'single-tenant' }));
  });

  after(async () => {
    await db?.close();
  });

  test('inserting, soft-deleting and deleting a document each delete the s:default rows; progress updates keep them', async () => {
    const id = crypto.randomUUID();
    await seedCache(db, 's:default');
    await db.query(
      `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key) VALUES ($1, 'a.md', 'placeholder', '{}'::jsonb, $1, $2)`,
      [id, `legacy:${id}`],
    );
    assert.equal(await cacheCount(db, 's:default'), 0);
    await seedCache(db, 's:default');
    await db.query("UPDATE documents SET processing_status = 'done' WHERE id = $1", [id]);
    assert.equal(await cacheCount(db, 's:default'), 2);
    await db.query("UPDATE documents SET is_current = false, status = 'deleted' WHERE id = $1", [id]);
    assert.equal(await cacheCount(db, 's:default'), 0);
    await seedCache(db, 's:default');
    await db.query('DELETE FROM documents WHERE id = $1', [id]);
    assert.equal(await cacheCount(db, 's:default'), 0);
  });

  test('with the cache table empty, document writes behave as before', async () => {
    await db.query('DELETE FROM public.rag_semantic_cache');
    const id = crypto.randomUUID();
    const inserted = await db.query(
      `INSERT INTO documents (id, filename, content, metadata, lineage_id, source_key) VALUES ($1, 'b.md', 'placeholder', '{}'::jsonb, $1, $2)`,
      [id, `legacy:${id}`],
    );
    assert.equal(inserted.affectedRows, 1);
    const updated = await db.query("UPDATE documents SET status = 'failed' WHERE id = $1", [id]);
    assert.equal(updated.affectedRows, 1);
    const deleted = await db.query('DELETE FROM documents WHERE id = $1', [id]);
    assert.equal(deleted.affectedRows, 1);
    assert.equal(await cacheCount(db, 's:default'), 0);
  });
});
