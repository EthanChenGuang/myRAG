import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureDatabase, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { TWO_TENANT_IDS, createTwoTenantDatabase } from '../../eval/harness/two-tenant.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

const LEGACY_EMBEDDING = 'openai-3-small-1536';
const VOYAGE = 'voyage-4-large-2048';
const P256 = 'p256';
const P_GENERAL = 'p256-general';
const FOREIGN_KEY = 'u:00000000-0000-4000-8000-000000000999';
const SIGNATURE = 'rag_write_profile_chunks(uuid,text,text,jsonb,jsonb,jsonb,boolean,integer)';

type Row = Record<string, unknown>;

interface Tenant {
  key: string;
  userId: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The deterministic id of a profile row: the first 16 bytes of sha256(document id : profile id : kind : index) as a UUID. */
function profileRowId(documentId: string, profileId: string, kind: 'parent' | 'child', index: number): string {
  const hex = crypto.createHash('sha256').update(`${documentId}:${profileId}:${kind}:${index}`, 'utf8').digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function vector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

function parentsOf(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    parent_index: index,
    section_path: ['Contract', `Clause ${index + 1}`],
    content: `Clause ${index + 1} governs the supply of equipment. ${'The supplier shall deliver on time. '.repeat(4)}`,
    token_count: 40 + index,
  }));
}

function childrenOf(count: number, parentCount: number, label = 'child') {
  return Array.from({ length: count }, (_, index) => ({
    chunk_index: index,
    parent_index: index % parentCount,
    content: `${label} ${index} equipment warranty delivery`,
    section_path: ['Contract', `Clause ${(index % parentCount) + 1}`],
    chunk_kind: 'text',
    embedding_text_version: 1,
    content_hash: `hash-${label}-${index}`,
    lexical_text: `contract clause ${label}${index} warranty delivery`,
    metadata: { lexical_version: 1 },
  }));
}

for (const mode of MODES) {
  describe(`rag_write_profile_chunks and the build-run tables (${mode})`, () => {
    let fixture: FixtureDatabase;
    let a: Tenant;
    let b: Tenant | null;
    let sequence = 0;

    before(async () => {
      if (mode === 'multi-tenant') {
        fixture = await createTwoTenantDatabase();
        a = { key: `u:${TWO_TENANT_IDS.userA}`, userId: TWO_TENANT_IDS.userA };
        b = { key: `u:${TWO_TENANT_IDS.userB}`, userId: TWO_TENANT_IDS.userB };
      } else {
        fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
        a = { key: 's:default', userId: null };
        b = null;
      }
      await fixture.db.exec(`
        INSERT INTO chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
        VALUES ('${P256}', 'contract_legal', 256, 'structure', 1024, 'building', '256/1024'),
               ('${P_GENERAL}', 'general', 256, 'structure', 1024, 'building', '256/1024')
        ON CONFLICT DO NOTHING`);
    });

    after(async () => {
      await fixture?.db.close();
    });

    const query = async (sql: string, params: unknown[] = []): Promise<Row[]> => {
      try {
        return (await fixture.db.query<Row>(sql, params)).rows;
      } catch (error) {
        return assert.fail(`${sql.slice(0, 70).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
      }
    };

    async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
      try {
        await fixture.db.query(sql, params);
        return null;
      } catch (error) {
        return messageOf(error);
      }
    }

    async function begin(tenant: Tenant, docType = 'contract_legal'): Promise<string> {
      sequence += 1;
      const sourceKey = `profile-writer-${mode}-${sequence}.md`;
      const rows = await query(
        `SELECT * FROM rag_begin_document_version(
           p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => NULL, p_source => 'config_upload', p_source_key => $3, p_filename => $3,
           p_file_sha256 => $4, p_doc_type => $5, p_doc_type_origin => 'fallback', p_profile_id => 'contract_legal@1', p_profile_version => 1)`,
        [tenant.key, tenant.userId, sourceKey, crypto.createHash('sha256').update(`${sourceKey}:${sequence}`).digest('hex'), docType],
      );
      assert.equal(rows[0]?.outcome, 'created');
      const documentId = String(rows[0]?.document_id);
      await query(`SELECT * FROM rag_set_document_fields(p_document_id => $1, p_tenant_key => $2, p_fields => '{"language":"en"}'::jsonb)`, [
        documentId,
        tenant.key,
      ]);
      return documentId;
    }

    async function writeLegacy(documentId: string, tenant: Tenant): Promise<void> {
      await query(
        `SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => NULL, p_final => true, p_total => 1)`,
        [
          documentId,
          tenant.key,
          JSON.stringify([{ content: 'legacy chunk of the contract', chunk_index: 0, section_path: [], chunk_kind: 'text', embedding_text_version: 1, metadata: {} }]),
        ],
      );
    }

    const publish = (documentId: string, tenant: Tenant) =>
      query('SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, tenant.key]);

    const WRITE_SQL = `SELECT * FROM rag_write_profile_chunks(
      p_document_id => $1, p_tenant_key => $2, p_profile_id => $3, p_parents => $4::jsonb, p_children => $5::jsonb, p_embeddings => $6::jsonb,
      p_final => $7, p_total => $8)`;

    const writeParams = (
      documentId: string,
      tenantKey: string,
      profileId: string,
      parents: unknown[],
      children: unknown[],
      embeddings: unknown = null,
    ): unknown[] => [documentId, tenantKey, profileId, JSON.stringify(parents), JSON.stringify(children), JSON.stringify(embeddings), true, children.length];

    const write = (documentId: string, tenant: Tenant, profileId: string, parents: unknown[], children: unknown[], embeddings: unknown = null) =>
      query(WRITE_SQL, writeParams(documentId, tenant.key, profileId, parents, children, embeddings));

    const writeError = (documentId: string, tenantKey: string, profileId: string, parents: unknown[], children: unknown[], embeddings: unknown = null) =>
      errorOf(WRITE_SQL, writeParams(documentId, tenantKey, profileId, parents, children, embeddings));

    const childRows = (documentId: string, profileId: string) =>
      query(
        `SELECT id::text, chunk_index, parent_id::text, chunking_profile_id, tenant_key, doc_type, language, version, status, is_current, content,
                lexical_text, lexical_tsv::text AS lexical_tsv, section_path, embedding IS NOT NULL AS has_embedding
         FROM document_chunks WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY chunk_index`,
        [documentId, profileId],
      );

    const parentRows = (documentId: string, profileId: string) =>
      query(
        `SELECT id::text, parent_index, tenant_key, version, chunking_profile_id, section_path, content, token_count
         FROM document_parents WHERE document_id = $1 AND chunking_profile_id = $2 ORDER BY parent_index`,
        [documentId, profileId],
      );

    test('the writer exists with the documented signature and only service_role may execute it', async () => {
      const found = await query('SELECT to_regprocedure($1)::text AS signature', [SIGNATURE]);
      assert.ok(found[0]?.signature, `${SIGNATURE} does not exist`);
      const acl = await query(
        `SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
                COALESCE((SELECT bool_or(g.grantee = 0) FROM aclexplode(p.proacl) g WHERE g.privilege_type = 'EXECUTE'), true) AS public_exec,
                p.prosecdef AS definer
         FROM pg_proc p WHERE p.oid = to_regprocedure($1)`,
        [SIGNATURE],
      );
      assert.deepEqual(acl[0], { anon: false, authenticated: false, service_role: true, public_exec: false, definer: true });
    });

    test('2 parents and 6 children get deterministic ids, parent links and the document columns; the write is idempotent; 5 children remove the sixth', async () => {
      const documentId = await begin(a);
      await writeLegacy(documentId, a);
      const parents = parentsOf(2);
      const children = childrenOf(6, 2);

      const first = await write(documentId, a, P256, parents, children);
      assert.equal(first[0]?.parents_written, 2);
      assert.equal(first[0]?.children_written, 6);

      const storedParents = await parentRows(documentId, P256);
      assert.deepEqual(
        storedParents.map((row) => row.id),
        [0, 1].map((index) => profileRowId(documentId, P256, 'parent', index)),
      );
      assert.equal(storedParents[0]?.tenant_key, a.key);
      assert.deepEqual(storedParents[1]?.section_path, ['Contract', 'Clause 2']);
      assert.equal(storedParents[1]?.token_count, 41);

      const stored = await childRows(documentId, P256);
      assert.equal(stored.length, 6);
      assert.deepEqual(
        stored.map((row) => row.id),
        [0, 1, 2, 3, 4, 5].map((index) => profileRowId(documentId, P256, 'child', index)),
      );
      assert.deepEqual(
        stored.map((row) => row.parent_id),
        [0, 1, 0, 1, 0, 1].map((index) => profileRowId(documentId, P256, 'parent', index)),
      );
      const document = (await query('SELECT tenant_key, doc_type, language, version FROM documents WHERE id = $1', [documentId]))[0];
      for (const row of stored) {
        assert.equal(row.chunking_profile_id, P256);
        assert.equal(row.tenant_key, document?.tenant_key);
        assert.equal(row.doc_type, 'contract_legal');
        assert.equal(row.language, 'en');
        assert.equal(row.version, document?.version);
      }
      const expectedTsv = (await query('SELECT rag_lexical_tsvector($1)::text AS tsv', [children[0]?.lexical_text]))[0]?.tsv;
      assert.ok(String(expectedTsv).length > 0);
      assert.equal(stored[0]?.lexical_tsv, expectedTsv);
      assert.equal(stored[0]?.lexical_text, children[0]?.lexical_text);

      const snapshot = JSON.stringify([await parentRows(documentId, P256), await childRows(documentId, P256)]);
      await write(documentId, a, P256, parents, children);
      assert.equal(JSON.stringify([await parentRows(documentId, P256), await childRows(documentId, P256)]), snapshot);

      const smaller = await write(documentId, a, P256, parentsOf(1), childrenOf(5, 1));
      assert.equal(smaller[0]?.children_deleted, 1);
      assert.equal(smaller[0]?.parents_deleted, 1);
      assert.equal((await childRows(documentId, P256)).length, 5);
      assert.equal((await parentRows(documentId, P256)).length, 1);
      const legacy = await childRows(documentId, 'legacy');
      assert.equal(legacy.length, 1, 'the legacy chunk is not touched');
    });

    test('children are processing until the version is published and variant afterwards; legacy readers and the hybrid RPC never see them unless the profile is named', async () => {
      const documentId = await begin(a);
      await writeLegacy(documentId, a);
      const children = childrenOf(4, 2);
      await write(documentId, a, P256, parentsOf(2), children, {
        [VOYAGE]: { vectors: children.map((_, index) => vector(2048, index)), host: 'fixture' },
      });
      assert.deepEqual(
        (await childRows(documentId, P256)).map((row) => [row.status, row.is_current]),
        [0, 1, 2, 3].map(() => ['processing', false]),
      );

      await publish(documentId, a);
      const published = await childRows(documentId, P256);
      assert.deepEqual(
        published.map((row) => [row.status, row.is_current]),
        [0, 1, 2, 3].map(() => ['variant', true]),
      );

      const legacyHits = await query(
        'SELECT id::text FROM match_chunks_by_profile($1, $2, 2048, $3::halfvec, 100, -1::float8, false)',
        [a.key, VOYAGE, `[${vector(2048, 0).join(',')}]`],
      );
      assert.deepEqual(legacyHits, [], 'a legacy reader returned a variant child');

      const hybrid = (override: unknown) =>
        query(
          `SELECT chunk_id::text, parent_id::text FROM hybrid_search_chunks(
             p_tenant_key => $1, p_profile_id => $2, p_query_embedding => $3::vector, p_lexical_tokens => $4::text[],
             p_dense_limit => 0, p_lexical_limit => 20, p_chunking_override => $5::jsonb)`,
          [a.key, LEGACY_EMBEDDING, `[${vector(1536, 0).join(',')}]`, ['warranty', 'child1', 'child2'], override === null ? null : JSON.stringify(override)],
        );
      const childIds = new Set(published.map((row) => row.id));
      assert.equal((await hybrid(null)).filter((row) => childIds.has(String(row.chunk_id))).length, 0, 'hybrid search returned children while p256 is not active');
      const named = (await hybrid({ contract_legal: P256 })).filter((row) => childIds.has(String(row.chunk_id)));
      assert.ok(named.length > 0, 'hybrid search did not return children for the named profile');
      assert.ok(named.every((row) => row.parent_id !== null));
    });

    test('a foreign tenant key raises tenant_mismatch and writes nothing; so does a profile that is legacy, unknown or of another doc type', async () => {
      const documentId = await begin(a);
      const parents = parentsOf(1);
      const children = childrenOf(2, 1);

      assert.match((await writeError(documentId, FOREIGN_KEY, P256, parents, children)) ?? 'no error', /tenant_mismatch/);
      if (b) assert.match((await writeError(documentId, b.key, P256, parents, children)) ?? 'no error', /tenant_mismatch/);
      assert.match((await writeError(documentId, a.key, 'legacy', parents, children)) ?? 'no error', /invalid_profile/);
      assert.match((await writeError(documentId, a.key, 'no-such-profile', parents, children)) ?? 'no error', /chunking_profile_unsupported/);
      assert.match((await writeError(documentId, a.key, P_GENERAL, parents, children)) ?? 'no error', /chunking_profile_unsupported/);

      assert.equal((await childRows(documentId, P256)).length, 0);
      assert.equal((await parentRows(documentId, P256)).length, 0);
      assert.equal((await childRows(documentId, 'legacy')).length, 0);
    });

    test('a malformed payload raises a named reason and rolls the whole call back', async () => {
      const documentId = await begin(a);
      const parents = parentsOf(1);
      const dangling = childrenOf(2, 1).map((child, index) => (index === 1 ? { ...child, parent_index: 7 } : child));
      assert.match((await writeError(documentId, a.key, P256, parents, dangling)) ?? 'no error', /invalid_chunk/);
      const duplicate = childrenOf(2, 1).map((child) => ({ ...child, chunk_index: 0 }));
      assert.match((await writeError(documentId, a.key, P256, parents, duplicate)) ?? 'no error', /invalid_chunk/);
      assert.match((await writeError(documentId, a.key, P256, { not: 'an array' } as unknown as unknown[], childrenOf(1, 1))) ?? 'no error', /invalid_parents/);
      assert.equal((await childRows(documentId, P256)).length, 0);
      assert.equal((await parentRows(documentId, P256)).length, 0);
    });

    test('embeddings land in document_chunks.embedding for the legacy-storage profile and in chunk_embeddings for a halfvec profile; a wrong length rolls everything back', async () => {
      const documentId = await begin(a);
      const children = childrenOf(3, 1);
      await write(documentId, a, P256, parentsOf(1), children, {
        [LEGACY_EMBEDDING]: children.map((_, index) => vector(1536, index)),
        [VOYAGE]: { vectors: children.map((_, index) => vector(2048, index)), host: 'fixture' },
      });
      assert.deepEqual(
        (await childRows(documentId, P256)).map((row) => row.has_embedding),
        [true, true, true],
      );
      const halfvec = await query(
        `SELECT e.chunk_id::text, e.profile_id, e.tenant_key, e.dims, e.embedding_host
         FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id
         WHERE c.document_id = $1 AND c.chunking_profile_id = $2 ORDER BY c.chunk_index`,
        [documentId, P256],
      );
      assert.equal(halfvec.length, 3);
      assert.ok(halfvec.every((row) => row.profile_id === VOYAGE && row.dims === 2048 && row.tenant_key === a.key && row.embedding_host === 'fixture'));
      assert.equal(halfvec[0]?.chunk_id, profileRowId(documentId, P256, 'child', 0));

      const other = await begin(a);
      const message = await writeError(other, a.key, P256, parentsOf(1), childrenOf(2, 1), {
        [VOYAGE]: { vectors: [vector(2048, 0), vector(100, 1)], host: null },
      });
      assert.match(message ?? 'no error', /embedding_profile_mismatch/);
      assert.equal((await childRows(other, P256)).length, 0);
      assert.equal((await parentRows(other, P256)).length, 0);
    });

    test('a rewrite with changed text drops the old vectors of that child', async () => {
      const documentId = await begin(a);
      const children = childrenOf(2, 1);
      await write(documentId, a, P256, parentsOf(1), children, { [VOYAGE]: { vectors: children.map((_, index) => vector(2048, index)), host: 'fixture' } });
      const changed = children.map((child, index) => (index === 0 ? { ...child, content: 'changed text of the first child' } : child));
      await write(documentId, a, P256, parentsOf(1), changed, null);
      const left = await query(
        `SELECT c.chunk_index FROM chunk_embeddings e JOIN document_chunks c ON c.id = e.chunk_id
         WHERE c.document_id = $1 AND c.chunking_profile_id = $2 ORDER BY c.chunk_index`,
        [documentId, P256],
      );
      assert.deepEqual(left.map((row) => row.chunk_index), [1]);
    });

    test('rag_write_chunks of the legacy writer does not delete or touch profile children', async () => {
      const documentId = await begin(a);
      await writeLegacy(documentId, a);
      await write(documentId, a, P256, parentsOf(2), childrenOf(4, 2));
      await writeLegacy(documentId, a);
      assert.equal((await childRows(documentId, P256)).length, 4);
    });

    test('chunking_build_runs and chunking_build_gaps are server-only tables with RLS on and no policies', async () => {
      for (const table of ['chunking_build_runs', 'chunking_build_gaps']) {
        const meta = await query(
          `SELECT c.relrowsecurity AS rls,
                  (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = $1) AS policies,
                  has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon,
                  has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated,
                  has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS service_role
           FROM pg_class c WHERE c.oid = to_regclass('public.' || $1)`,
          [table],
        );
        assert.ok(meta[0], `${table} does not exist`);
        assert.deepEqual(meta[0], { rls: true, policies: 0, anon: false, authenticated: false, service_role: true });
      }
      const documentId = await begin(a);
      const run = await query(
        `INSERT INTO chunking_build_runs (profile_id, doc_type, tenant_key, docs_total, status) VALUES ($1, 'contract_legal', NULL, 3, 'running') RETURNING id::text`,
        [P256],
      );
      await query(`INSERT INTO chunking_build_gaps (run_id, document_id, reason, detail) VALUES ($1::uuid, $2, 'no_parse_output', 'written before Phase 3')`, [
        run[0]?.id,
        documentId,
      ]);
      const badReason = await errorOf(`INSERT INTO chunking_build_gaps (run_id, document_id, reason) VALUES ($1::uuid, $2, 'other')`, [run[0]?.id, documentId]);
      assert.ok(badReason, 'an unknown gap reason was accepted');
      const unknownProfile = await errorOf(`INSERT INTO chunking_build_runs (profile_id, doc_type, status) VALUES ('missing', 'contract_legal', 'running')`);
      assert.ok(unknownProfile, 'a run of an unknown profile was accepted');
    });
  });
}
