import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0440_embedding_bindings.sql';
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const PHASE3_PROFILES = ['openai-3-small-1536', 'qwen3-8b-1024', 'qwen3-8b-2048', 'voyage-4-large-1024', 'voyage-4-large-2048'];
const SCOPED: Record<string, { model: string; docTypes: string[]; index: string }> = {
  'voyage-4-large-1024-domain': {
    model: 'voyage-4-large',
    docTypes: ['contract_legal', 'financial_report', 'invoice_receipt'],
    index: 'chunk_embeddings_voyage_4_large_1024_domain_hnsw',
  },
  'voyage-finance-2-1024': { model: 'voyage-finance-2', docTypes: ['financial_report', 'invoice_receipt'], index: 'chunk_embeddings_voyage_finance_2_1024_hnsw' },
  'voyage-law-2-1024': { model: 'voyage-law-2', docTypes: ['contract_legal'], index: 'chunk_embeddings_voyage_law_2_1024_hnsw' },
};
const BINDING_FUNCTIONS = ['rag_embedding_profiles_scope_guard()', 'rag_embedding_bindings_guard()', 'rag_chunk_embeddings_guard()'];

type Role = 'anon' | 'authenticated' | 'service_role';

function vectorLiteral(dims: number, value = 0.1): string {
  return `[${Array.from({ length: dims }, () => value).join(',')}]`;
}

async function errorOf(run: () => Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const e = error as { code?: unknown; message?: unknown };
    return { code: typeof e.code === 'string' ? e.code : '', message: typeof e.message === 'string' ? e.message : String(error) };
  }
}

async function expectRefusal(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await errorOf(run);
  assert.ok(error, `expected a refusal matching ${pattern}`);
  assert.match(error.message, pattern);
}

async function asRole<T>(db: PGlite, role: Role, run: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function insertChunk(db: PGlite, mode: DeploymentMode, userId: string, docType: string): Promise<{ documentId: string; chunkId: string }> {
  const documentId = crypto.randomUUID();
  const chunkId = crypto.randomUUID();
  if (mode === 'multi-tenant') {
    await db.query('INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
      documentId,
      `scope-${documentId.slice(0, 8)}.md`,
      'A neutral synthetic paragraph about a sample record.',
      '{}',
      userId,
      docType,
    ]);
  } else {
    await db.query('INSERT INTO public.documents (id, filename, content, metadata, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5)', [
      documentId,
      `scope-${documentId.slice(0, 8)}.md`,
      'A neutral synthetic paragraph about a sample record.',
      '{}',
      docType,
    ]);
  }
  await db.query('INSERT INTO public.document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, 0, $4::jsonb)', [
    chunkId,
    documentId,
    'A neutral synthetic sentence.',
    '{}',
  ]);
  return { documentId, chunkId };
}

async function insertVector(db: PGlite, chunkId: string, profileId: string, dims: number, tenantKey: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
     SELECT c.id, $2, COALESCE($5, c.tenant_key), $3::public.halfvec, 'test-model', $4 FROM public.document_chunks c WHERE c.id = $1`,
    [chunkId, profileId, vectorLiteral(dims), dims, tenantKey],
  );
}

async function insertBinding(db: PGlite, docType: string, tenantKey: string | null, profileId: string, status: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO public.embedding_profile_bindings (doc_type, tenant_key, profile_id, status, created_by)
     VALUES ($1, $2, $3, $4, 'test') RETURNING id`,
    [docType, tenantKey, profileId, status],
  );
  return result.rows[0]!.id;
}

/** The schema objects and seeded rows 0440 owns, as text, so two builds can be compared. */
async function snapshot(db: PGlite): Promise<string> {
  const parts: unknown[] = [];
  parts.push(
    (
      await db.query(
        `SELECT id, provider, model, dims, storage, status, doc_types, query_instruction, score_calibration
           FROM public.embedding_profiles ORDER BY id`,
      )
    ).rows,
  );
  parts.push((await db.query(`SELECT indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND tablename IN ('chunk_embeddings', 'embedding_profiles', 'embedding_profile_bindings') ORDER BY 1`)).rows);
  parts.push(
    (
      await db.query(
        `SELECT conrelid::regclass::text AS rel, conname, pg_catalog.pg_get_constraintdef(oid) AS def FROM pg_catalog.pg_constraint
          WHERE conrelid IN ('public.embedding_profiles'::regclass, 'public.embedding_profile_bindings'::regclass) ORDER BY 1, 2`,
      )
    ).rows,
  );
  parts.push(
    (
      await db.query(
        `SELECT tgrelid::regclass::text AS rel, tgname, pg_catalog.pg_get_triggerdef(oid) AS def FROM pg_catalog.pg_trigger
          WHERE NOT tgisinternal AND tgrelid IN ('public.embedding_profiles'::regclass, 'public.embedding_profile_bindings'::regclass, 'public.chunk_embeddings'::regclass)
          ORDER BY 1, 2`,
      )
    ).rows,
  );
  parts.push(
    (
      await db.query(
        `SELECT p.oid::regprocedure::text AS sig, pg_catalog.pg_get_functiondef(p.oid) AS def, p.proacl::text AS acl FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rag_embedding_profiles_scope_guard', 'rag_embedding_bindings_guard', 'rag_chunk_embeddings_guard')
          ORDER BY 1`,
      )
    ).rows,
  );
  parts.push((await db.query(`SELECT relname, relacl::text AS acl, relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.embedding_profile_bindings'::regclass`)).rows);
  return JSON.stringify(parts);
}

for (const mode of MODES) {
  describe(`0440 embedding bindings schema (${mode})`, () => {
    let db: PGlite;
    let userId: string;
    let tenantKey: string;

    before(async () => {
      const fixture = await createEmptyFixtureDatabase({ deploymentMode: mode });
      db = fixture.db;
      userId = fixture.fixtureUserId;
      tenantKey = mode === 'multi-tenant' ? `u:${userId}` : 's:default';
    });

    after(async () => {
      await db?.close();
    });

    test('Phase 3 profiles stay unscoped and the three scoped candidates are seeded available', async () => {
      const rows = (
        await db.query<{ id: string; provider: string; model: string; dims: number; storage: string; status: string; doc_types: string[] | null; query_instruction: string | null }>(
          'SELECT id, provider, model, dims, storage, status, doc_types, query_instruction FROM public.embedding_profiles ORDER BY id',
        )
      ).rows;
      for (const id of PHASE3_PROFILES) {
        const row = rows.find((r) => r.id === id);
        assert.ok(row, `${id} missing`);
        assert.equal(row.doc_types, null, `${id} must stay unscoped`);
      }
      for (const [id, spec] of Object.entries(SCOPED)) {
        const row = rows.find((r) => r.id === id);
        assert.ok(row, `${id} missing`);
        assert.equal(row.provider, 'voyage');
        assert.equal(row.model, spec.model);
        assert.equal(row.dims, 1024);
        assert.equal(row.storage, 'halfvec');
        assert.equal(row.status, 'available');
        assert.equal(row.query_instruction, null);
        assert.deepEqual([...(row.doc_types ?? [])].sort(), [...spec.docTypes].sort());
      }
    });

    test('each scoped profile has its own partial halfvec(1024) HNSW index', async () => {
      for (const [id, spec] of Object.entries(SCOPED)) {
        const result = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [spec.index]);
        const def = result.rows[0]?.indexdef ?? '';
        assert.match(def, /USING hnsw/, `${spec.index} missing`);
        assert.match(def, /halfvec\(1024\)/);
        assert.match(def, /halfvec_cosine_ops/);
        assert.match(def, /m='?64'?/);
        assert.match(def, /ef_construction='?200'?/);
        assert.ok(def.includes(`'${id}'::text`), `${spec.index} must be partial on ${id}: ${def}`);
      }
    });

    test('a scoped profile can never become backfilling or active; unscoped profiles still can', async () => {
      await expectRefusal(() => db.query("SELECT * FROM public.rag_set_embedding_profile_status('voyage-law-2-1024', 'backfilling', 'test')"), /profile_status_refused: scoped_profile/);
      await expectRefusal(() => db.query("UPDATE public.embedding_profiles SET status = 'active' WHERE id = 'voyage-law-2-1024'"), /activation_refused: scoped_profile/);
      await expectRefusal(
        () =>
          db.query(
            `INSERT INTO public.embedding_profiles (id, provider, model, dims, storage, status, doc_types)
             VALUES ('scoped-insert-test', 'voyage', 'voyage-4-large', 1024, 'halfvec', 'backfilling', '{general}')`,
          ),
        /profile_status_refused: scoped_profile/,
      );
      await expectRefusal(
        () => db.query("UPDATE public.embedding_profiles SET doc_types = '{general}' WHERE id = 'openai-3-small-1536'"),
        /activation_refused: scoped_profile|scope_locked/,
      );

      await db.query("SELECT * FROM public.rag_set_embedding_profile_status('voyage-4-large-1024', 'backfilling', 'test')");
      const status = await db.query<{ status: string }>("SELECT status FROM public.embedding_profiles WHERE id = 'voyage-4-large-1024'");
      assert.equal(status.rows[0]?.status, 'backfilling');
      await db.query("SELECT * FROM public.rag_set_embedding_profile_status('voyage-4-large-1024', 'available', 'test')");
      await db.query("SELECT * FROM public.rag_set_embedding_profile_status('voyage-law-2-1024', 'retired', 'test')");
      await db.query("SELECT * FROM public.rag_set_embedding_profile_status('voyage-law-2-1024', 'available', 'test')");
    });

    test('doc_types must be NULL or a non-empty subset of the six doc type ids', async () => {
      await expectRefusal(() => db.query("UPDATE public.embedding_profiles SET doc_types = '{}' WHERE id = 'voyage-finance-2-1024'"), /embedding_profiles_doc_types_check/);
      await expectRefusal(() => db.query("UPDATE public.embedding_profiles SET doc_types = '{memo}' WHERE id = 'voyage-finance-2-1024'"), /embedding_profiles_doc_types_check/);
    });

    test('a scoped profile accepts vectors only inside its scope; dims and tenant rules are unchanged', async () => {
      const inScope = await insertChunk(db, mode, userId, 'contract_legal');
      const outOfScope = await insertChunk(db, mode, userId, 'general');

      await insertVector(db, inScope.chunkId, 'voyage-law-2-1024', 1024, 'x:forged');
      const stored = await db.query<{ tenant_key: string; dims: number }>(
        "SELECT tenant_key, dims FROM public.chunk_embeddings WHERE chunk_id = $1 AND profile_id = 'voyage-law-2-1024'",
        [inScope.chunkId],
      );
      assert.equal(stored.rows[0]?.tenant_key, tenantKey, 'tenant_key is copied from the chunk, never from the writer');
      assert.equal(stored.rows[0]?.dims, 1024);

      await expectRefusal(() => insertVector(db, outOfScope.chunkId, 'voyage-law-2-1024', 1024), /embedding_profile_mismatch: doc_type_scope/);
      const other = await insertChunk(db, mode, userId, 'contract_legal');
      await expectRefusal(() => insertVector(db, other.chunkId, 'voyage-law-2-1024', 512), /expected 1024 dimensions, not 512/);

      await expectRefusal(
        () => db.query("UPDATE public.chunk_embeddings SET chunk_id = $1 WHERE chunk_id = $2 AND profile_id = 'voyage-law-2-1024'", [outOfScope.chunkId, inScope.chunkId]),
        /embedding_profile_mismatch: doc_type_scope/,
      );

      await insertVector(db, outOfScope.chunkId, 'voyage-4-large-1024', 1024);
      const unscoped = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.chunk_embeddings WHERE chunk_id = $1 AND profile_id = 'voyage-4-large-1024'", [
        outOfScope.chunkId,
      ]);
      assert.equal(unscoped.rows[0]?.n, 1, 'an unscoped profile still takes any doc type');
    });

    test('the scope can change while a profile has no vectors and is locked once it has one', async () => {
      await db.query("UPDATE public.embedding_profiles SET doc_types = '{general}' WHERE id = 'voyage-4-large-1024-domain'");
      await db.query(
        "UPDATE public.embedding_profiles SET doc_types = '{contract_legal,financial_report,invoice_receipt}' WHERE id = 'voyage-4-large-1024-domain'",
      );
      const chunk = await insertChunk(db, mode, userId, 'financial_report');
      await insertVector(db, chunk.chunkId, 'voyage-4-large-1024-domain', 1024);
      await expectRefusal(
        () => db.query("UPDATE public.embedding_profiles SET doc_types = '{financial_report}' WHERE id = 'voyage-4-large-1024-domain'"),
        /profile_status_refused: scope_locked/,
      );
      await expectRefusal(
        () => db.query("UPDATE public.embedding_profiles SET doc_types = NULL WHERE id = 'voyage-4-large-1024-domain'"),
        /profile_status_refused: scope_locked/,
      );
      await db.query("UPDATE public.embedding_profiles SET status = 'retired' WHERE id = 'voyage-4-large-1024-domain'");
      await db.query("UPDATE public.embedding_profiles SET status = 'available' WHERE id = 'voyage-4-large-1024-domain'");
    });

    test('bindings: one active and one backfilling row per doc type and tenant, one row per profile', async () => {
      await insertBinding(db, 'contract_legal', null, 'voyage-law-2-1024', 'backfilling');
      const second = await errorOf(() => insertBinding(db, 'contract_legal', null, 'voyage-4-large-1024-domain', 'backfilling'));
      assert.equal(second?.code, '23505', `second backfilling row must violate a unique index: ${second?.message}`);
      assert.match(second.message, /embedding_profile_bindings_single_backfilling/);

      const triple = await errorOf(() => insertBinding(db, 'contract_legal', null, 'voyage-law-2-1024', 'available'));
      assert.equal(triple?.code, '23505');
      assert.match(triple.message, /embedding_profile_bindings_triple_ux/);

      await insertBinding(db, 'contract_legal', tenantKey, 'voyage-4-large-1024-domain', 'backfilling');

      await insertBinding(db, 'financial_report', null, 'voyage-finance-2-1024', 'active');
      const doubleActive = await errorOf(() => insertBinding(db, 'financial_report', null, 'voyage-4-large-1024-domain', 'active'));
      assert.equal(doubleActive?.code, '23505');
      assert.match(doubleActive.message, /embedding_profile_bindings_single_active/);
      await insertBinding(db, 'financial_report', null, 'voyage-4-large-1024-domain', 'available');
    });

    test('a binding must point at a scoped profile that contains its doc type', async () => {
      await expectRefusal(() => insertBinding(db, 'contract_legal', null, 'voyage-4-large-1024', 'available'), /binding_refused: profile_scope_mismatch/);
      await expectRefusal(() => insertBinding(db, 'general', null, 'voyage-law-2-1024', 'available'), /binding_refused: profile_scope_mismatch/);
      await expectRefusal(() => insertBinding(db, 'memo', null, 'voyage-law-2-1024', 'available'), /binding_refused|embedding_profile_bindings_doc_type_check/);
      const binding = await insertBinding(db, 'invoice_receipt', null, 'voyage-finance-2-1024', 'available');
      await expectRefusal(
        () => db.query("UPDATE public.embedding_profile_bindings SET profile_id = 'voyage-law-2-1024' WHERE id = $1", [binding]),
        /binding_refused: profile_scope_mismatch/,
      );
      await expectRefusal(
        () => db.query("UPDATE public.embedding_profile_bindings SET doc_type = 'general' WHERE id = $1", [binding]),
        /binding_refused: profile_scope_mismatch/,
      );
    });

    test('a profile cannot be re-scoped away from a doc type it is bound to', async () => {
      await db.query(
        `INSERT INTO public.embedding_profiles (id, provider, model, dims, storage, status, doc_types)
         VALUES ('scope-binding-test', 'voyage', 'voyage-4-large', 1024, 'halfvec', 'available', '{product_technical,scanned_image}')`,
      );
      await insertBinding(db, 'product_technical', null, 'scope-binding-test', 'available');
      await expectRefusal(
        () => db.query("UPDATE public.embedding_profiles SET doc_types = '{scanned_image}' WHERE id = 'scope-binding-test'"),
        /profile_status_refused: scope_locked/,
      );
      await db.query("UPDATE public.embedding_profiles SET doc_types = '{product_technical}' WHERE id = 'scope-binding-test'");
    });

    test('binding tenant keys go through rag_assert_tenant_key for this deployment mode', async () => {
      await expectRefusal(() => insertBinding(db, 'contract_legal', 'x:bad', 'voyage-law-2-1024', 'available'), /malformed tenant key/);
      const otherMode = mode === 'multi-tenant' ? 's:default' : `u:${crypto.randomUUID()}`;
      await expectRefusal(() => insertBinding(db, 'contract_legal', otherMode, 'voyage-law-2-1024', 'available'), /tenant key not valid for this deployment mode/);
      if (mode === 'multi-tenant') {
        await insertBinding(db, 'contract_legal', `u:${crypto.randomUUID()}`, 'voyage-law-2-1024', 'backfilling');
      } else {
        await insertBinding(db, 'contract_legal', 's:default', 'voyage-law-2-1024', 'available');
      }
    });

    test('only service_role can read the bindings table or run the new functions', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        const error = await errorOf(() => asRole(db, role, () => db.query('SELECT id FROM public.embedding_profile_bindings')));
        assert.equal(error?.code, '42501', `${role} must not read bindings: ${error?.message ?? 'no error'}`);
        const write = await errorOf(() =>
          asRole(db, role, () =>
            db.query("INSERT INTO public.embedding_profile_bindings (doc_type, profile_id, status, created_by) VALUES ('contract_legal', 'voyage-law-2-1024', 'available', 'x')"),
          ),
        );
        assert.equal(write?.code, '42501');
      }
      const rows = await asRole(db, 'service_role', () => db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.embedding_profile_bindings'));
      assert.ok((rows.rows[0]?.n ?? 0) > 0);

      const rls = await db.query<{ on: boolean }>("SELECT relrowsecurity AS on FROM pg_catalog.pg_class WHERE oid = 'public.embedding_profile_bindings'::regclass");
      assert.equal(rls.rows[0]?.on, true);
      const policies = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_catalog.pg_policy WHERE polrelid = 'public.embedding_profile_bindings'::regclass");
      assert.equal(policies.rows[0]?.n, 0);

      for (const sig of BINDING_FUNCTIONS) {
        const acl = await db.query<{ anon: boolean; auth: boolean; svc: boolean; public_exec: boolean; path: string[] | null; definer: boolean }>(
          `SELECT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
                  pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
                  p.proconfig AS path, p.prosecdef AS definer,
                  EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0) AS public_exec
             FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`,
          [`public.${sig}`],
        );
        const row = acl.rows[0];
        assert.ok(row, `${sig} missing`);
        assert.equal(row.anon, false, `${sig} executable by anon`);
        assert.equal(row.auth, false, `${sig} executable by authenticated`);
        assert.equal(row.public_exec, false, `${sig} executable by PUBLIC`);
        assert.equal(row.svc, true, `${sig} not executable by service_role`);
        assert.deepEqual(row.path, ['search_path=""'], `${sig} must SET search_path = ''`);
      }
      const definer = await db.query<{ sig: string; definer: boolean }>(
        `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer FROM pg_catalog.pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('rag_embedding_profiles_scope_guard', 'rag_embedding_bindings_guard')`,
      );
      assert.deepEqual(
        Object.fromEntries(definer.rows.map((r) => [r.sig, r.definer])),
        { 'rag_embedding_bindings_guard()': true, 'rag_embedding_profiles_scope_guard()': false },
      );
    });

    test('the replaced chunk_embeddings guard differs from the 0425 body only by the scope check', async () => {
      const body = (await db.query<{ src: string }>("SELECT prosrc AS src FROM pg_catalog.pg_proc WHERE oid = 'public.rag_chunk_embeddings_guard()'::regprocedure")).rows[0]!.src;
      assert.match(body, /public\.vector_dims\(NEW\.embedding\)/);
      assert.match(body, /NEW\.tenant_key := v_tenant;/);
      assert.match(body, /embedding_profile_mismatch: doc_type_scope/);
      assert.doesNotMatch(body, /\b(FROM|JOIN)\s+(embedding_profiles|document_chunks|documents)\b/);
    });

    test('applying 0440 a second time changes nothing', async () => {
      const first = await snapshot(db);
      await db.exec(fs.readFileSync(path.join(REPO_ROOT, MIGRATION), 'utf8'));
      const second = await snapshot(db);
      assert.equal(second, first);
    });
  });
}
