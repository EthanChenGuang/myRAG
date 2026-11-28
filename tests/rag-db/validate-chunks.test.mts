import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { embedText } from '../../eval/harness/fixture-embedder.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const LEGACY = 'openai-3-small-1536';
const HALFVEC = 'voyage-4-large-1024';
const ACTIVE_CHUNKING = 'p-validate-256';
const PROFILE_DOC_TYPE = 'product_technical';
const VALIDATE_SQL = 'SELECT chunk_id::text AS id FROM rag_validate_chunks($1, $2::uuid[], $3) ORDER BY 1';

interface Tenant {
  key: string;
  userId: string | null;
}

interface ChunkSpec {
  status?: string;
  isCurrent?: boolean;
  profile?: string;
  embedding?: boolean;
  chunkKind?: string;
  docType?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

function vec(text: string): string {
  return `[${embedText(text).join(',')}]`;
}

function halfvec(seed: number): string {
  return `[${Array.from({ length: 1024 }, (_, i) => (((i * 31 + seed) % 97) / 97).toFixed(4)).join(',')}]`;
}

async function validate(db: PGlite, key: string, ids: string[], profile = LEGACY): Promise<string[]> {
  return (await db.query<{ id: string }>(VALIDATE_SQL, [key, ids, profile])).rows.map((row) => row.id);
}

async function errorOf(db: PGlite, sql: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (error) {
    return { code: codeOf(error), message: messageOf(error) };
  }
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

for (const mode of MODES) {
  describe(`rag_validate_chunks isolation layer 2 (${mode})`, () => {
    let db: PGlite;
    let a: Tenant;
    let b: Tenant | null = null;
    const ids: Record<string, string> = {};

    async function insertDoc(tenant: Tenant, opts: { status?: string; isCurrent?: boolean; docType?: string } = {}): Promise<string> {
      const id = crypto.randomUUID();
      const docType = opts.docType ?? 'general';
      if (mode === 'multi-tenant') {
        await db.query(
          'INSERT INTO documents (id, filename, content, user_id, is_current, status, doc_type) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [id, `validate-${id}.md`, 'validate fixture', tenant.userId, opts.isCurrent ?? true, opts.status ?? 'ready', docType],
        );
      } else {
        await db.query('INSERT INTO documents (id, filename, content, is_current, status, doc_type) VALUES ($1, $2, $3, $4, $5, $6)', [
          id,
          `validate-${id}.md`,
          'validate fixture',
          opts.isCurrent ?? true,
          opts.status ?? 'ready',
          docType,
        ]);
      }
      return id;
    }

    async function insertChunk(docId: string, tenant: Tenant, spec: ChunkSpec = {}): Promise<string> {
      const id = crypto.randomUUID();
      const body = `validate synthetic sentence ${id}`;
      await db.query(
        `INSERT INTO document_chunks (id, document_id, content, metadata, chunk_index, embedding, lexical_text, tenant_key, doc_type, is_current, status,
                                      chunking_profile_id, chunk_kind)
         VALUES ($1, $2, $3, '{}'::jsonb, 0, $4::vector, $3, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          docId,
          body,
          spec.embedding === false ? null : vec(body),
          tenant.key,
          spec.docType ?? 'general',
          spec.isCurrent ?? true,
          spec.status ?? 'ready',
          spec.profile ?? 'legacy',
          spec.chunkKind ?? 'text',
        ],
      );
      return id;
    }

    async function addHalfvec(chunkId: string, tenant: Tenant): Promise<void> {
      await db.query(
        `INSERT INTO chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
         VALUES ($1, $2, $3, $4::halfvec, 'voyage-4-large', 1024)`,
        [chunkId, HALFVEC, tenant.key, halfvec(chunkId.charCodeAt(0))],
      );
    }

    before(async () => {
      if (mode === 'multi-tenant') {
        db = (await createTwoTenantDatabase()).db;
        a = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
        b = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };
      } else {
        db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS })).db;
        a = { key: 's:default', userId: null };
      }

      const docA = await insertDoc(a);
      ids.a1 = await insertChunk(docA, a);
      ids.a2 = await insertChunk(docA, a);
      if (b) {
        const docB = await insertDoc(b);
        ids.b1 = await insertChunk(docB, b);
        ids.b2 = await insertChunk(docB, b);
      }

      ids.superseded = await insertChunk(docA, a, { isCurrent: false });
      const oldVersion = await insertDoc(a, { isCurrent: false });
      ids.supersededDoc = await insertChunk(oldVersion, a, { isCurrent: false });
      const quarantined = await insertDoc(a, { status: 'quarantined' });
      ids.quarantined = await insertChunk(quarantined, a, { status: 'quarantined' });
      const quarantinedDocOnly = await insertDoc(a);
      ids.quarantinedDocOnly = await insertChunk(quarantinedDocOnly, a);
      await db.query("UPDATE documents SET status = 'quarantined' WHERE id = $1", [quarantinedDocOnly]);
      const failed = await insertDoc(a);
      ids.failed = await insertChunk(failed, a, { status: 'failed' });
      const softDeleted = await insertDoc(a);
      ids.softDeleted = await insertChunk(softDeleted, a);
      await db.query("UPDATE documents SET is_current = false, status = 'deleted' WHERE id = $1", [softDeleted]);
      await db.query("UPDATE document_chunks SET is_current = false, status = 'deleted' WHERE document_id = $1", [softDeleted]);
      ids.variantInactive = await insertChunk(docA, a, { profile: 'p-not-active' });
      ids.noVector = await insertChunk(docA, a, { embedding: false });

      ids.halfvecWith = await insertChunk(docA, a);
      await addHalfvec(ids.halfvecWith, a);

      // An active non-legacy chunking profile for one doc type: one document has its children, another is missing from it.
      await db.query(`UPDATE chunking_profiles SET status = 'retired' WHERE doc_type = $1 AND id = 'legacy'`, [PROFILE_DOC_TYPE]);
      await db.query(
        `INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
         VALUES ($1, $2, 256, 'none', NULL, 'active', '256/1024') ON CONFLICT (id, doc_type) DO UPDATE SET status = 'active'`,
        [ACTIVE_CHUNKING, PROFILE_DOC_TYPE],
      );
      const rechunked = await insertDoc(a, { docType: PROFILE_DOC_TYPE });
      ids.rechunkedLegacy = await insertChunk(rechunked, a, { docType: PROFILE_DOC_TYPE });
      ids.rechunkedLegacyImage = await insertChunk(rechunked, a, { docType: PROFILE_DOC_TYPE, chunkKind: 'image' });
      ids.child = await insertChunk(rechunked, a, { docType: PROFILE_DOC_TYPE, profile: ACTIVE_CHUNKING });
      const missing = await insertDoc(a, { docType: PROFILE_DOC_TYPE });
      ids.missingLegacy = await insertChunk(missing, a, { docType: PROFILE_DOC_TYPE });
    });

    after(async () => {
      await db?.close();
    });

    test('the chunk statuses follow the fixture (variant for non-legacy profiles)', async () => {
      const rows = (await db.query<{ status: string }>('SELECT status FROM document_chunks WHERE id = $1', [ids.child])).rows;
      assert.equal(rows[0]?.status, 'variant');
    });

    test('foreign: ids of another tenant are not returned with this key; mixed input returns only own ids', { skip: mode === 'single-tenant' }, async () => {
      assert.ok(b);
      assert.deepEqual(await validate(db, a.key, [ids.b1, ids.b2]), []);
      assert.deepEqual(await validate(db, a.key, [ids.a1, ids.a2]), sorted([ids.a1, ids.a2]));
      assert.deepEqual(await validate(db, a.key, [ids.a1, ids.b1, ids.a2, ids.b2]), sorted([ids.a1, ids.a2]));
    });

    test('foreign negative control: the same input with the other key returns only that tenant\'s ids', { skip: mode === 'single-tenant' }, async () => {
      assert.ok(b);
      assert.deepEqual(await validate(db, b.key, [ids.a1, ids.b1, ids.a2, ids.b2]), sorted([ids.b1, ids.b2]));
    });

    test('foreign: a key of the other deployment mode raises 22023 (single-tenant refuses u:, multi-tenant refuses s:default)', async () => {
      const wrong = mode === 'single-tenant' ? `u:${TWO_TENANT_IDS.userA}` : 's:default';
      const error = await errorOf(db, VALIDATE_SQL, [wrong, [ids.a1], LEGACY]);
      assert.equal(error?.code, '22023', error?.message);
    });

    test('superseded, quarantined, soft-deleted, failed and variant-of-inactive-profile chunks are not returned', async () => {
      for (const name of ['superseded', 'supersededDoc', 'quarantined', 'quarantinedDocOnly', 'failed', 'softDeleted', 'variantInactive']) {
        assert.deepEqual(await validate(db, a.key, [ids[name] as string]), [], name);
      }
      assert.deepEqual(await validate(db, a.key, [ids.a1, ids.quarantined, ids.softDeleted]), [ids.a1]);
    });

    test('an active non-legacy chunking profile: children are returned, legacy rows of a rechunked document are not (except image), a missing document is served by its legacy rows', async () => {
      assert.deepEqual(await validate(db, a.key, [ids.child]), [ids.child]);
      assert.deepEqual(await validate(db, a.key, [ids.rechunkedLegacy]), []);
      assert.deepEqual(await validate(db, a.key, [ids.rechunkedLegacyImage]), [ids.rechunkedLegacyImage]);
      assert.deepEqual(await validate(db, a.key, [ids.missingLegacy]), [ids.missingLegacy]);
    });

    test('legacy_column profile: a chunk with a null embedding is dropped, one with a vector is kept', async () => {
      assert.deepEqual(await validate(db, a.key, [ids.noVector]), []);
      assert.deepEqual(await validate(db, a.key, [ids.a1]), [ids.a1]);
    });

    test('halfvec profile: a chunk without a chunk_embeddings row for the profile is dropped', async () => {
      assert.deepEqual(await validate(db, a.key, [ids.halfvecWith, ids.a1], HALFVEC), [ids.halfvecWith]);
      assert.deepEqual(await validate(db, a.key, [ids.noVector], HALFVEC), []);
    });

    test('the hit columns are hydrated from Supabase', async () => {
      const rows = (await db.query<Record<string, unknown>>('SELECT * FROM rag_validate_chunks($1, $2::uuid[], $3)', [a.key, [ids.a1], LEGACY])).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(Object.keys(rows[0] as object).sort(), [
        'chunk_id',
        'chunk_index',
        'chunk_kind',
        'content',
        'doc_type',
        'document_content_preview',
        'document_created_at',
        'document_filename',
        'document_id',
        'document_metadata',
        'language',
        'metadata',
        'parent_id',
        'section_path',
      ]);
      assert.match(String(rows[0]?.content), /^validate synthetic sentence /);
      assert.match(String(rows[0]?.document_filename), /^validate-/);
    });

    test('more than 500 ids raises; NULL, empty and duplicate input are handled', async () => {
      const many = Array.from({ length: 501 }, () => crypto.randomUUID());
      assert.equal((await errorOf(db, VALIDATE_SQL, [a.key, many, LEGACY]))?.code, '22023');
      assert.deepEqual(await validate(db, a.key, many.slice(0, 500)), []);
      assert.deepEqual((await db.query('SELECT * FROM rag_validate_chunks($1, NULL, $2)', [a.key, LEGACY])).rows, []);
      assert.deepEqual(await validate(db, a.key, []), []);
      assert.deepEqual(await validate(db, a.key, [ids.a1, ids.a1]), [ids.a1]);
    });

    test('NULL, malformed and upper-case keys raise 22023; an unknown profile raises 22023', async () => {
      const upper = mode === 'single-tenant' ? 'S:DEFAULT' : `u:${TWO_TENANT_IDS.userA.toUpperCase()}`;
      for (const key of [null, '', 'tenant', 'u:not-a-uuid', upper, `x:${TWO_TENANT_IDS.userA}`]) {
        const error = await errorOf(db, VALIDATE_SQL, [key, [ids.a1], LEGACY]);
        assert.equal(error?.code, '22023', `${String(key)}: ${error?.message ?? 'no error'}`);
      }
      assert.equal((await errorOf(db, VALIDATE_SQL, [a.key, [ids.a1], 'no-such-profile']))?.code, '22023');
    });

    test('SET ROLE anon and authenticated get 42501 on the function and the view; service_role succeeds', async () => {
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          assert.equal((await errorOf(db, VALIDATE_SQL, [a.key, [ids.a1], LEGACY]))?.code, '42501', role);
          assert.equal((await errorOf(db, 'SELECT count(*) FROM rag_servable_chunks'))?.code, '42501', `${role} view`);
        } finally {
          await db.exec('RESET ROLE');
        }
      }
      await db.exec('SET ROLE service_role');
      try {
        assert.deepEqual(await validate(db, a.key, [ids.a1]), [ids.a1]);
        assert.ok(Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM rag_servable_chunks')).rows[0]?.n) > 0);
      } finally {
        await db.exec('RESET ROLE');
      }
    });

    test('no switch: exactly three parameters, SECURITY INVOKER, empty search_path, no setting read in the body; the view is security_invoker', async () => {
      const rows = (
        await db.query<Record<string, unknown>>(
          `SELECT p.pronargs AS nargs, p.prosecdef AS definer, p.prosrc AS src,
                  COALESCE((SELECT c FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'), '') AS search_path,
                  COALESCE((SELECT bool_or(g.grantee = 0) FROM aclexplode(p.proacl) g WHERE g.privilege_type = 'EXECUTE'), true) AS public_exec
             FROM pg_proc p WHERE p.oid = to_regprocedure('public.rag_validate_chunks(text,uuid[],text)')`,
        )
      ).rows;
      assert.equal(rows.length, 1);
      const row = rows[0] as Record<string, unknown>;
      assert.equal(row.nargs, 3);
      assert.equal(row.definer, false);
      assert.equal(String(row.search_path).replace(/\s/g, ''), 'search_path=""');
      assert.equal(row.public_exec, false);
      assert.doesNotMatch(String(row.src), /current_setting|set_config/i);
      const overloads = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'rag_validate_chunks'")).rows[0]?.n;
      assert.equal(overloads, 1);
      const view = (await db.query<{ opts: string[] | null }>("SELECT reloptions AS opts FROM pg_class WHERE oid = 'public.rag_servable_chunks'::regclass")).rows[0];
      assert.ok((view?.opts ?? []).includes('security_invoker=true'), String(view?.opts));
    });

    async function parityDiff(): Promise<Map<string, { onlyHybrid: string[]; onlyValidate: string[] }>> {
      const out = new Map<string, { onlyHybrid: string[]; onlyValidate: string[] }>();
      const tenants = (await db.query<{ k: string }>('SELECT DISTINCT tenant_key AS k FROM document_chunks WHERE tenant_key IS NOT NULL ORDER BY 1')).rows.map(
        (row) => row.k,
      );
      assert.ok(tenants.includes(a.key));
      const query = vec('validate synthetic sentence');
      for (const key of tenants) {
        const candidates = (await db.query<{ id: string }>('SELECT id::text AS id FROM document_chunks WHERE tenant_key = $1', [key])).rows.map((row) => row.id);
        const kept: string[] = [];
        for (let i = 0; i < candidates.length; i += 500) kept.push(...(await validate(db, key, candidates.slice(i, i + 500))));

        const docs = (await db.query<{ id: string }>('SELECT DISTINCT document_id::text AS id FROM document_chunks WHERE tenant_key = $1', [key])).rows.map(
          (row) => row.id,
        );
        const searched: string[] = [];
        for (const doc of docs) {
          const rows = (
            await db.query<{ id: string; mode: string }>(
              `SELECT chunk_id::text AS id, dense_mode AS mode FROM hybrid_search_chunks(
                 p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => '{}'::text[],
                 p_dense_limit => 200, p_lexical_limit => 0, p_document_ids => ARRAY[$4::uuid], p_exact_scan_cutoff => 100000)`,
              [key, LEGACY, query, doc],
            )
          ).rows;
          assert.ok(rows.length < 200, `document ${doc} has too many chunks for one exact call`);
          for (const row of rows) assert.equal(row.mode, 'exact');
          searched.push(...rows.map((row) => row.id));
        }
        const keptSet = new Set(kept);
        const searchedSet = new Set(searched);
        out.set(key, {
          onlyHybrid: sorted(searched.filter((id) => !keptSet.has(id))),
          onlyValidate: sorted(kept.filter((id) => !searchedSet.has(id))),
        });
      }
      return out;
    }

    test('parity: the one difference is a chunk left ready under a non-ready document, which only the view also refuses', async () => {
      const diff = await parityDiff();
      for (const [key, d] of diff) {
        assert.deepEqual(d.onlyValidate, [], `tenant ${key}: validate kept an id hybrid_search_chunks does not serve`);
        assert.deepEqual(d.onlyHybrid, key === a.key ? [ids.quarantinedDocOnly] : [], `tenant ${key}`);
      }
    });

    test('parity: per tenant, the ids returned for every candidate equal the ids hybrid_search_chunks returns on its exact path', async () => {
      // The writers set chunk and document status together; restore that state for the inconsistent fixture row.
      await db.query("UPDATE document_chunks SET status = 'quarantined' WHERE id = $1", [ids.quarantinedDocOnly]);
      const diff = await parityDiff();
      assert.ok(diff.has(a.key));
      for (const [key, d] of diff) assert.deepEqual(d, { onlyHybrid: [], onlyValidate: [] }, `tenant ${key}`);
    });
  });
}
