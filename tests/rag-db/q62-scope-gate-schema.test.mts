import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from '../../eval/harness/migrations.mts';
import { FIXTURE_USER_ID, createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const LEGACY = 'openai-3-small-1536';
const HALF = 'bge-m3-1024';
const ACTOR = '00000000-0000-4000-8000-0000000006f1';
const USER_A = '00000000-0000-4000-8000-0000000007a1';
const USER_B = '00000000-0000-4000-8000-0000000007b1';

type Role = 'anon' | 'authenticated' | 'service_role';

function codeOf(error: unknown): string {
  return typeof (error as { code?: string }).code === 'string' ? (error as { code: string }).code : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

function sparse(dims: number, values: number[]): string {
  const out = new Array<number>(dims).fill(0);
  values.forEach((value, index) => {
    out[index] = value;
  });
  return `[${out.join(',')}]`;
}

function parseVector(text: string): number[] {
  return text.replace(/^\[|\]$/g, '').split(',').map(Number);
}

interface DocOptions {
  userId?: string;
  docType?: string;
  status?: string;
  isCurrent?: boolean;
  scopes?: string[];
}

async function insertDoc(db: PGlite, mode: DeploymentMode, options: DocOptions = {}): Promise<string> {
  const id = crypto.randomUUID();
  const cols = ['id', 'filename', 'content', 'metadata', 'lineage_id', 'source_key', 'status', 'is_current', 'doc_type', 'scopes'];
  const vals: unknown[] = [id, `doc-${id}.md`, 'A neutral synthetic paragraph.', '{}', id, `legacy:${id}`, options.status ?? 'ready', options.isCurrent ?? true, options.docType ?? 'general', options.scopes ?? []];
  if (mode === 'multi-tenant') {
    cols.push('user_id');
    vals.push(options.userId ?? FIXTURE_USER_ID);
  }
  const placeholders = cols.map((_, index) => `$${index + 1}`).join(', ');
  await db.query(`INSERT INTO documents (${cols.join(', ')}) VALUES (${placeholders})`, vals);
  return id;
}

async function insertChunk(
  db: PGlite,
  documentId: string,
  language: string,
  legacyVector: string | null,
  options: { isCurrent?: boolean; status?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO document_chunks (id, document_id, content, chunk_index, metadata, language, embedding, is_current, status)
     VALUES ($1, $2, 'A neutral synthetic sentence.', 0, '{}'::jsonb, $3, $4::vector, $5, $6)`,
    [id, documentId, language, legacyVector, options.isCurrent ?? true, options.status ?? 'ready'],
  );
  return id;
}

async function addHalf(db: PGlite, chunkId: string, vector: string): Promise<void> {
  await db.query(
    `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
     SELECT c.id, $2, c.tenant_key, $3::halfvec, 'BAAI/bge-m3', 1024 FROM document_chunks c WHERE c.id = $1`,
    [chunkId, HALF, vector],
  );
}

async function rebuild(db: PGlite, tenant: string | null, profile: string) {
  const result = await asRole(db, 'service_role', () =>
    db.query<{ group_kind: string; groups: number; chunks: string | number }>(
      'SELECT group_kind, groups, chunks FROM public.rag_scope_centroids_rebuild($1, $2)',
      [tenant, profile],
    ),
  );
  return Object.fromEntries(result.rows.map((row) => [row.group_kind, { groups: Number(row.groups), chunks: Number(row.chunks) }]));
}

interface CentroidRow {
  group_kind: string;
  group_key: string;
  centroid: string;
  dims: number;
  member_count: number;
}

async function list(db: PGlite, tenant: string, profile: string): Promise<CentroidRow[]> {
  const result = await asRole(db, 'service_role', () =>
    db.query<CentroidRow>(
      'SELECT group_kind, group_key, centroid::text AS centroid, dims, member_count FROM public.rag_scope_centroids_list($1, $2)',
      [tenant, profile],
    ),
  );
  return result.rows;
}

async function centroidCount(db: PGlite, tenant: string): Promise<number> {
  const result = await db.query<{ n: string | number }>('SELECT count(*) AS n FROM public.rag_scope_centroids WHERE tenant_key = $1', [tenant]);
  return Number(result.rows[0]?.n ?? 0);
}

async function addExample(db: PGlite, tenant: string | null, text: string, profile = HALF) {
  return asRole(db, 'service_role', () =>
    db.query<{ id: string }>('SELECT id FROM public.rag_scope_example_add($1, $2, $3, $4::halfvec, $5)', [
      tenant,
      profile,
      text,
      sparse(1024, [0.5]),
      ACTOR,
    ]),
  );
}

const FUNCTIONS: Array<{ signature: string; call: string; args: (tenant: string | null) => unknown[] }> = [
  { signature: 'rag_scope_centroids_rebuild(text,text)', call: 'SELECT * FROM public.rag_scope_centroids_rebuild($1, $2)', args: (t) => [t, HALF] },
  { signature: 'rag_scope_centroids_list(text,text)', call: 'SELECT * FROM public.rag_scope_centroids_list($1, $2)', args: (t) => [t, HALF] },
  { signature: 'rag_scope_status(text,text)', call: 'SELECT * FROM public.rag_scope_status($1, $2)', args: (t) => [t, HALF] },
  {
    signature: 'rag_scope_example_add(text,text,text,halfvec,uuid)',
    call: 'SELECT * FROM public.rag_scope_example_add($1, $2, $3, $4::halfvec, $5)',
    args: (t) => [t, HALF, 'a neutral synthetic example', sparse(1024, [0.5]), ACTOR],
  },
  { signature: 'rag_scope_examples_list(text,text)', call: 'SELECT * FROM public.rag_scope_examples_list($1, $2)', args: (t) => [t, HALF] },
  { signature: 'rag_scope_example_delete(text,uuid)', call: 'SELECT public.rag_scope_example_delete($1, $2)', args: (t) => [t, crypto.randomUUID()] },
];

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  const tenant = mode === 'multi-tenant' ? `u:${FIXTURE_USER_ID}` : 's:default';
  const wrongModeKey = mode === 'multi-tenant' ? 's:default' : `u:${FIXTURE_USER_ID}`;

  describe(`scope-gate storage (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      ({ db } = await createEmptyFixtureDatabase({ deploymentMode: mode }));
    });

    after(async () => {
      await db?.close();
    });

    beforeEach(async () => {
      await db.exec('DELETE FROM public.rag_scope_negative_examples; DELETE FROM public.rag_scope_centroids;');
      await db.exec('DELETE FROM chunk_embeddings; DELETE FROM document_chunks; DELETE FROM documents;');
    });

    test('both tables have RLS on, no policies and no client grants', async () => {
      const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
        "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('rag_scope_centroids', 'rag_scope_negative_examples') ORDER BY relname",
      );
      assert.deepEqual(rls.rows.map((row) => [row.relname, row.relrowsecurity]), [
        ['rag_scope_centroids', true],
        ['rag_scope_negative_examples', true],
      ]);
      const policies = await db.query("SELECT 1 FROM pg_policies WHERE tablename IN ('rag_scope_centroids', 'rag_scope_negative_examples')");
      assert.equal(policies.rows.length, 0);
      for (const role of ['anon', 'authenticated'] as const) {
        for (const table of ['rag_scope_centroids', 'rag_scope_negative_examples']) {
          await assert.rejects(
            () => asRole(db, role, () => db.query(`SELECT * FROM public.${table}`)),
            (error: unknown) => codeOf(error) === '42501',
          );
        }
      }
    });

    test('legacy rebuild: language-specific groups, member counts and means over current ready chunks only', async () => {
      const docA = await insertDoc(db, mode, { docType: 'general', scopes: ['region:north'] });
      const docB = await insertDoc(db, mode, { docType: 'general' });
      await insertChunk(db, docA, 'en', sparse(1536, [0.5, 0.25]));
      await insertChunk(db, docA, 'en', sparse(1536, [0.25, 0.5]));
      await insertChunk(db, docB, 'en', sparse(1536, [0.75, 0, 0.5]));
      await insertChunk(db, docB, 'it', sparse(1536, [0, 0, 1]));
      await insertChunk(db, docB, 'en', sparse(1536, [9, 9, 9]), { isCurrent: false });
      for (const status of ['quarantined', 'processing', 'pending_review', 'failed']) {
        const excluded = await insertDoc(db, mode, { status });
        await insertChunk(db, excluded, 'en', sparse(1536, [9, 9, 9]));
      }
      const superseded = await insertDoc(db, mode, { isCurrent: false });
      await insertChunk(db, superseded, 'en', sparse(1536, [9, 9, 9]));

      const summary = await rebuild(db, tenant, LEGACY);
      assert.deepEqual(summary, {
        doc_type: { groups: 2, chunks: 4 },
        scope_tag: { groups: 1, chunks: 2 },
        tenant: { groups: 2, chunks: 4 },
      });
      const rows = await list(db, tenant, LEGACY);
      const byKey = Object.fromEntries(rows.map((row) => [`${row.group_kind}|${row.group_key}`, row]));
      assert.deepEqual(Object.keys(byKey).sort(), [
        'doc_type|general/en',
        'doc_type|general/it',
        'scope_tag|region:north/en',
        'tenant|tenant/en',
        'tenant|tenant/it',
      ]);
      const general = byKey['doc_type|general/en'];
      assert.equal(general?.member_count, 3);
      assert.equal(general?.dims, 1536);
      const mean = parseVector(general?.centroid ?? '');
      assert.equal(mean.length, 1536);
      assert.ok(Math.abs((mean[0] ?? 0) - 0.5) < 1e-3);
      assert.ok(Math.abs((mean[1] ?? 0) - 0.25) < 1e-3);
      assert.ok(Math.abs((mean[2] ?? 0) - 0.5 / 3) < 1e-3);
      assert.equal(byKey['scope_tag|region:north/en']?.member_count, 2);
    });

    test('a halfvec profile reads chunk_embeddings, not the legacy column', async () => {
      const doc = await insertDoc(db, mode, { docType: 'product_technical' });
      const c1 = await insertChunk(db, doc, 'zh', sparse(1536, [1]));
      const c2 = await insertChunk(db, doc, 'zh', sparse(1536, [1]));
      await insertChunk(db, doc, 'zh', sparse(1536, [1]));
      await addHalf(db, c1, sparse(1024, [0, 0.5]));
      await addHalf(db, c2, sparse(1024, [0, 1]));
      await rebuild(db, tenant, HALF);
      const rows = await list(db, tenant, HALF);
      const docType = rows.find((row) => row.group_kind === 'doc_type');
      assert.equal(docType?.group_key, 'product_technical/zh');
      assert.equal(docType?.member_count, 2);
      assert.equal(docType?.dims, 1024);
      const mean = parseVector(docType?.centroid ?? '');
      assert.ok(Math.abs((mean[1] ?? 0) - 0.75) < 1e-3);
      assert.ok(Math.abs(mean[0] ?? 1) < 1e-6);
    });

    test('document and scope-tag changes delete the tenant centroids in the same transaction', async () => {
      const doc = await insertDoc(db, mode);
      await insertChunk(db, doc, 'en', sparse(1536, [1]));
      const changes = [
        `UPDATE documents SET doc_type = 'product_technical' WHERE id = '${doc}'`,
        `UPDATE documents SET scopes = ARRAY['region:south'] WHERE id = '${doc}'`,
        `UPDATE document_chunks SET language = 'it' WHERE document_id = '${doc}'`,
        `UPDATE document_chunks SET embedding = '${sparse(1536, [0, 1])}'::vector WHERE document_id = '${doc}'`,
        `UPDATE documents SET status = 'quarantined' WHERE id = '${doc}'`,
      ];
      for (const sql of changes) {
        await rebuild(db, tenant, LEGACY);
        assert.ok((await centroidCount(db, tenant)) > 0, `rows before: ${sql}`);
        await db.exec(sql);
        assert.equal(await centroidCount(db, tenant), 0, `cleared by: ${sql}`);
      }
      await db.exec(`UPDATE documents SET doc_type = 'general', scopes = '{}', status = 'ready' WHERE id = '${doc}'`);
      await rebuild(db, tenant, LEGACY);
      await db.exec(`UPDATE documents SET metadata = '{"note":1}'::jsonb WHERE id = '${doc}'`);
      assert.ok((await centroidCount(db, tenant)) > 0, 'an unrelated column change keeps the rows');
      const empty = await insertDoc(db, mode);
      assert.equal(await centroidCount(db, tenant), 0, 'insert clears');
      await rebuild(db, tenant, LEGACY);
      await db.exec(`DELETE FROM documents WHERE id = '${empty}'`);
      assert.equal(await centroidCount(db, tenant), 0, 'document delete clears');
      await rebuild(db, tenant, LEGACY);
      await db.exec(`DELETE FROM document_chunks WHERE document_id = '${doc}'`);
      assert.equal(await centroidCount(db, tenant), 0, 'chunk delete clears');
    });

    test('a chunk_embeddings write clears only that profile', async () => {
      const doc = await insertDoc(db, mode);
      const c1 = await insertChunk(db, doc, 'en', sparse(1536, [1]));
      const c2 = await insertChunk(db, doc, 'en', sparse(1536, [1]));
      await addHalf(db, c1, sparse(1024, [1]));
      await rebuild(db, tenant, LEGACY);
      await rebuild(db, tenant, HALF);
      await addHalf(db, c2, sparse(1024, [0, 1]));
      const left = await db.query<{ embedding_profile_id: string }>(
        'SELECT DISTINCT embedding_profile_id FROM public.rag_scope_centroids WHERE tenant_key = $1',
        [tenant],
      );
      assert.deepEqual(left.rows.map((row) => row.embedding_profile_id), [LEGACY]);
    });

    test('examples: length, duplicate and per-tenant limit are enforced in SQL with distinct codes', async () => {
      await assert.rejects(() => addExample(db, tenant, 'x'.repeat(501)), (error: unknown) => codeOf(error) === '22001' && /example_too_long/.test(messageOf(error)));
      await assert.rejects(() => addExample(db, tenant, '   '), (error: unknown) => codeOf(error) === '22023');
      await addExample(db, tenant, 'x'.repeat(500));
      await addExample(db, tenant, 'A neutral   synthetic example');
      await assert.rejects(
        () => addExample(db, tenant, 'a neutral synthetic EXAMPLE'),
        (error: unknown) => codeOf(error) === '23505' && /example_duplicate/.test(messageOf(error)),
      );
      for (let index = 2; index < 100; index += 1) await addExample(db, tenant, `neutral synthetic example number ${index}`);
      await assert.rejects(() => addExample(db, tenant, 'one more neutral example'), (error: unknown) => codeOf(error) === '54000' && /example_limit/.test(messageOf(error)));
      await assert.rejects(
        () =>
          asRole(db, 'service_role', () =>
            db.query('SELECT * FROM public.rag_scope_example_add($1, $2, $3, $4::halfvec, $5)', [tenant, HALF, 'wrong dims example', sparse(8, [1]), ACTOR]),
          ),
        (error: unknown) => codeOf(error) === '22023',
      );
      const listed = await asRole(db, 'service_role', () => db.query<{ id: string }>('SELECT id FROM public.rag_scope_examples_list($1, $2)', [tenant, HALF]));
      assert.equal(listed.rows.length, 100);
      const status = await asRole(db, 'service_role', () => db.query<{ examples: number }>('SELECT examples FROM public.rag_scope_status($1, $2)', [tenant, HALF]));
      assert.equal(Number(status.rows[0]?.examples), 100);
      const first = listed.rows[0]?.id;
      const deleted = await asRole(db, 'service_role', () => db.query<{ ok: boolean }>('SELECT public.rag_scope_example_delete($1, $2) AS ok', [tenant, first]));
      assert.equal(deleted.rows[0]?.ok, true);
      await addExample(db, tenant, 'one more neutral example');
    });

    test('status reports group counts, included chunks and a scoped binding', async () => {
      const doc = await insertDoc(db, mode);
      await insertChunk(db, doc, 'en', sparse(1536, [1]));
      await rebuild(db, tenant, LEGACY);
      const read = async () =>
        (
          await asRole(db, 'service_role', () =>
            db.query<{ doc_type_groups: number; tenant_groups: number; chunks_included: string | number; newest_update: Date | null; has_scoped_binding: boolean }>(
              'SELECT * FROM public.rag_scope_status($1, $2)',
              [tenant, LEGACY],
            ),
          )
        ).rows[0];
      const status = await read();
      assert.equal(Number(status?.doc_type_groups), 1);
      assert.equal(Number(status?.tenant_groups), 1);
      assert.equal(Number(status?.chunks_included), 1);
      assert.ok(status?.newest_update);
      assert.equal(status?.has_scoped_binding, false);
      await db.query(
        `INSERT INTO embedding_profile_bindings (doc_type, tenant_key, profile_id, status, created_by) VALUES ('contract_legal', $1, 'voyage-law-2-1024', 'active', 'test')`,
        [tenant],
      ).catch(async () => {
        await db.exec('ALTER TABLE embedding_profile_bindings DISABLE TRIGGER USER');
        await db.query(
          `INSERT INTO embedding_profile_bindings (doc_type, tenant_key, profile_id, status, created_by) VALUES ('contract_legal', $1, 'voyage-law-2-1024', 'active', 'test')`,
          [tenant],
        );
        await db.exec('ALTER TABLE embedding_profile_bindings ENABLE TRIGGER USER');
      });
      assert.equal((await read())?.has_scoped_binding, true);
      await db.exec('DELETE FROM embedding_profile_bindings');
    });

    test('an unknown profile raises 22023', async () => {
      await assert.rejects(() => rebuild(db, tenant, 'no-such-profile'), (error: unknown) => codeOf(error) === '22023');
    });

    for (const fn of FUNCTIONS) {
      test(`${fn.signature}: malformed and wrong-mode keys raise 22023; anon and authenticated get 42501`, async () => {
        for (const key of [null, 'x:1', `u:${FIXTURE_USER_ID.toUpperCase()}`, wrongModeKey]) {
          await assert.rejects(
            () => asRole(db, 'service_role', () => db.query(fn.call, fn.args(key))),
            (error: unknown) => codeOf(error) === '22023',
            `key ${String(key)}`,
          );
        }
        for (const role of ['anon', 'authenticated'] as const) {
          await assert.rejects(() => asRole(db, role, () => db.query(fn.call, fn.args(tenant))), (error: unknown) => codeOf(error) === '42501');
        }
        await asRole(db, 'service_role', () => db.query(fn.call, fn.args(tenant)));
      });
    }

    test('every 0983 function is revoked from PUBLIC, anon, authenticated, granted to service_role, with an empty search_path', async () => {
      const result = await db.query<{ proname: string; proconfig: string[] | null; grantees: string[] }>(
        `SELECT p.proname, p.proconfig,
                ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END
                      FROM aclexplode(p.proacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
                      WHERE a.privilege_type = 'EXECUTE') AS grantees
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname LIKE 'rag\\_scope\\_%' AND p.proname NOT IN (
           'rag_scope_slug', 'rag_scope_admin', 'rag_scope_name_key', 'rag_scope_clean_aliases', 'rag_scope_names_taken', 'rag_scope_lock_dimension'
         ) AND p.proname NOT LIKE 'rag\\_scope\\_vocabulary%'`,
      );
      const names = result.rows.map((row) => row.proname).sort();
      assert.ok(names.includes('rag_scope_centroids_rebuild') && names.includes('rag_scope_centroids_on_documents_update'), names.join(','));
      for (const row of result.rows) {
        assert.ok(!row.grantees.includes('PUBLIC'), row.proname);
        assert.ok(!row.grantees.includes('anon'), row.proname);
        assert.ok(!row.grantees.includes('authenticated'), row.proname);
        assert.ok(row.grantees.includes('service_role'), row.proname);
        assert.ok((row.proconfig ?? []).some((entry) => entry === 'search_path=""' || entry === "search_path=''"), row.proname);
      }
    });

    test('applying every migration a second time succeeds and keeps the rows', async () => {
      const doc = await insertDoc(db, mode);
      await insertChunk(db, doc, 'en', sparse(1536, [1]));
      await rebuild(db, tenant, LEGACY);
      await addExample(db, tenant, 'a neutral synthetic example');
      await applyMigrations(db, mode);
      assert.equal(await centroidCount(db, tenant), 2);
      const listed = await asRole(db, 'service_role', () => db.query('SELECT id FROM public.rag_scope_examples_list($1, $2)', [tenant, HALF]));
      assert.equal(listed.rows.length, 1);
    });
  });
}

describe('scope-gate two-tenant isolation (multi-tenant)', () => {
  let db: PGlite;
  const tenantA = `u:${USER_A}`;
  const tenantB = `u:${USER_B}`;

  before(async () => {
    ({ db } = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant' }));
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)', [USER_A, 'scope-a@example.invalid', USER_B, 'scope-b@example.invalid']);
    for (const userId of [USER_A, USER_B]) {
      const doc = await insertDoc(db, 'multi-tenant', { userId });
      await insertChunk(db, doc, 'en', sparse(1536, [1]));
    }
  });

  after(async () => {
    await db?.close();
  });

  test('a rebuild, list and change of tenant A never touch tenant B', async () => {
    await rebuild(db, tenantA, LEGACY);
    await rebuild(db, tenantB, LEGACY);
    assert.equal((await list(db, tenantA, LEGACY)).length, 2);
    assert.equal(await centroidCount(db, tenantB), 2);
    await insertDoc(db, 'multi-tenant', { userId: USER_A });
    assert.equal(await centroidCount(db, tenantA), 0);
    assert.equal(await centroidCount(db, tenantB), 2);
    await rebuild(db, tenantA, LEGACY);
    assert.equal(await centroidCount(db, tenantB), 2);
  });

  test("tenant A cannot list or delete tenant B's examples", async () => {
    const added = await addExample(db, tenantB, 'a neutral synthetic example');
    const id = added.rows[0]?.id;
    const listedA = await asRole(db, 'service_role', () => db.query('SELECT id FROM public.rag_scope_examples_list($1, $2)', [tenantA, HALF]));
    assert.equal(listedA.rows.length, 0);
    const deleted = await asRole(db, 'service_role', () => db.query<{ ok: boolean }>('SELECT public.rag_scope_example_delete($1, $2) AS ok', [tenantA, id]));
    assert.equal(deleted.rows[0]?.ok, false);
    const listedB = await asRole(db, 'service_role', () => db.query('SELECT id FROM public.rag_scope_examples_list($1, $2)', [tenantB, HALF]));
    assert.equal(listedB.rows.length, 1);
    await addExample(db, tenantA, 'a neutral synthetic example');
  });
});
