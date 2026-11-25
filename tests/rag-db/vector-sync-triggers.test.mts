import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode, type FixtureDatabase } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_CORPUS = path.join(REPO_ROOT, 'eval/fixtures/corpus');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const PROFILE_1024 = 'voyage-4-large-1024';

interface OutboxRow {
  target: string;
  entity: string;
  entity_id: string;
  tenant_key: string | null;
  profile_id: string | null;
  status: string;
}

function halfvecLiteral(dims: number, seed: number): string {
  return `[${Array.from({ length: dims }, (_, i) => (((i * 31 + seed) % 97) / 97).toFixed(4)).join(',')}]`;
}

async function outbox(db: PGlite): Promise<OutboxRow[]> {
  const r = await db.query<OutboxRow>(
    'SELECT target, entity, entity_id, tenant_key, profile_id, status FROM public.vector_sync_outbox ORDER BY target, entity, entity_id, tenant_key, profile_id',
  );
  return r.rows;
}

async function outboxCount(db: PGlite): Promise<number> {
  return Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.vector_sync_outbox')).rows[0]?.n);
}

async function setTargets(db: PGlite, enabled: string[]): Promise<void> {
  await db.query('UPDATE public.rag_vector_sync_targets SET enabled = (target = ANY($1::text[]))', [enabled]);
}

async function resetOutbox(db: PGlite): Promise<void> {
  await db.exec('DELETE FROM public.vector_sync_outbox');
}

async function tenantOfDoc(db: PGlite, id: string): Promise<string> {
  return (await db.query<{ k: string }>('SELECT tenant_key AS k FROM public.documents WHERE id = $1', [id])).rows[0]!.k;
}

/** One document with `n` chunks written by a single INSERT statement. */
async function createDocument(db: PGlite, mode: DeploymentMode, n: number, opts: { userId?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  if (mode === 'multi-tenant') {
    await db.query('INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, $3, $4::jsonb, $5::uuid)', [
      id,
      `sync-${id}.txt`,
      'sync fixture',
      '{}',
      opts.userId ?? FIXTURE_USER_ID,
    ]);
  } else {
    await db.query('INSERT INTO public.documents (id, filename, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [id, `sync-${id}.txt`, 'sync fixture', '{}']);
  }
  await db.query(
    `INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index)
     SELECT gen_random_uuid(), $1::uuid, 'chunk ' || g, '{}'::jsonb, g FROM generate_series(0, $2::int - 1) AS g`,
    [id, n],
  );
  return id;
}

async function deleteDocument(db: PGlite, mode: DeploymentMode, id: string): Promise<void> {
  // Single-tenant chunks do not cascade from documents; delete them first as the app does.
  if (mode === 'single-tenant') await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [id]);
  await db.query('DELETE FROM public.documents WHERE id = $1', [id]);
}

async function addProfileVectors(db: PGlite, docId: string): Promise<void> {
  await db.query(
    `INSERT INTO public.chunk_embeddings (chunk_id, profile_id, tenant_key, embedding, embedding_model, dims)
     SELECT c.id, $2, c.tenant_key, $3::halfvec, 'voyage-4-large', 1024 FROM public.document_chunks c WHERE c.document_id = $1`,
    [docId, PROFILE_1024, halfvecLiteral(1024, 7)],
  );
}

async function createChunkingCandidate(db: PGlite, id: string, docType: string): Promise<void> {
  await db.query(
    `INSERT INTO public.chunking_profiles (id, doc_type, child_tokens, parent_mode, parent_tokens, status, preset)
     VALUES ($1, $2, 256, 'none', NULL, 'ready', 'custom') ON CONFLICT (id, doc_type) DO NOTHING`,
    [id, docType],
  );
}

async function flipChunking(db: PGlite, docType: string, toId: string): Promise<void> {
  await db.query("UPDATE public.chunking_profiles SET status = 'ready' WHERE doc_type = $1 AND status = 'active'", [docType]);
  await db.query("UPDATE public.chunking_profiles SET status = 'active' WHERE doc_type = $1 AND id = $2", [docType, toId]);
}

async function createOrganization(db: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await db.query('INSERT INTO public.organizations (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)', [id, 'Sync Org', `sync-${id}`, FIXTURE_USER_ID]);
  return id;
}

for (const mode of MODES) {
  describe(`vector sync triggers 0702 (${mode})`, () => {
    let fixture: FixtureDatabase;
    let db: PGlite;

    before(async () => {
      fixture = await createFixtureDatabase({ deploymentMode: mode, corpusDir: REAL_CORPUS });
      db = fixture.db;
    });

    after(async () => {
      await db.close();
    });

    beforeEach(async () => {
      await setTargets(db, []);
      await resetOutbox(db);
    });

    test('the triggers are installed, one per event and statement-level', async () => {
      const r = await db.query<{ t: string; name: string; def: string }>(
        `SELECT tgrelid::regclass::text AS t, tgname AS name, pg_get_triggerdef(oid) AS def FROM pg_trigger
          WHERE NOT tgisinternal AND tgname LIKE 'rag_vector_sync_%' ORDER BY 1, 2`,
      );
      const byTable = (t: string) => r.rows.filter((x) => x.t === t);
      assert.equal(byTable('document_chunks').length, 3);
      assert.equal(byTable('chunk_embeddings').length, 3);
      assert.equal(byTable('documents').length, 2);
      assert.equal(byTable('embedding_profiles').length, 1);
      assert.equal(byTable('chunking_profiles').length, 1);
      for (const row of r.rows) assert.match(row.def, /FOR EACH STATEMENT/, row.name);
    });

    test('no enabled target: the fixture load, writes, cascade, quarantine, release, soft delete, re-embed and profile flips leave the outbox empty', async () => {
      // The fixture corpus was loaded before any test ran, with the seeded (disabled) targets.
      assert.equal(await outboxCount(db), 0);
      const docId = await createDocument(db, mode, 50);
      await db.query("UPDATE public.document_chunks SET lexical_text = 'changed tokens', status = 'ready' WHERE document_id = $1", [docId]);
      await addProfileVectors(db, docId);
      await db.query('UPDATE public.chunk_embeddings SET embedding = $2::halfvec WHERE chunk_id IN (SELECT id FROM public.document_chunks WHERE document_id = $1)', [
        docId,
        halfvecLiteral(1024, 11),
      ]);
      await db.query("UPDATE public.documents SET status = 'quarantined' WHERE id = $1", [docId]);
      await db.query("UPDATE public.documents SET status = 'ready' WHERE id = $1", [docId]);
      const doc = (await db.query<{ lineage_id: string; source: string; tenant_key: string }>('SELECT lineage_id, source, tenant_key FROM public.documents WHERE id = $1', [docId]))
        .rows[0]!;
      await db.query('SELECT * FROM public.rag_soft_delete_document($1, $2, $3)', [doc.tenant_key, doc.lineage_id, doc.source]);
      await db.query("UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = $1", [PROFILE_1024]);
      await db.query("UPDATE public.embedding_profiles SET status = 'available' WHERE id = $1", [PROFILE_1024]);
      await createChunkingCandidate(db, 'sync-candidate', 'general');
      await flipChunking(db, 'general', 'sync-candidate');
      await flipChunking(db, 'general', 'legacy');
      await db.query('DELETE FROM public.chunk_embeddings WHERE chunk_id IN (SELECT id FROM public.document_chunks WHERE document_id = $1)', [docId]);
      await deleteDocument(db, mode, docId);
      const cascadeDoc = await createDocument(db, mode, 5);
      await addProfileVectors(db, cascadeDoc);
      await deleteDocument(db, mode, cascadeDoc);
      assert.equal(await outboxCount(db), 0);
    });

    test('qdrant enabled: 50 chunks of one document in one statement enqueue exactly one document row', async () => {
      await setTargets(db, ['qdrant']);
      const docId = await createDocument(db, mode, 50);
      const tenant = await tenantOfDoc(db, docId);
      assert.deepEqual(await outbox(db), [{ target: 'qdrant', entity: 'document', entity_id: docId, tenant_key: tenant, profile_id: null, status: 'pending' }]);
    });

    test('both targets enabled: one statement enqueues one row per target', async () => {
      await setTargets(db, ['qdrant', 'weaviate']);
      const docId = await createDocument(db, mode, 50);
      const rows = await outbox(db);
      assert.deepEqual(
        rows.map((r) => [r.target, r.entity, r.entity_id, r.profile_id]),
        [
          ['qdrant', 'document', docId, null],
          ['weaviate', 'document', docId, null],
        ],
      );
    });

    test('per-statement chunk inserts of one document coalesce into one pending row per target', async () => {
      await setTargets(db, ['qdrant']);
      const docId = await createDocument(db, mode, 1);
      for (let i = 1; i < 4; i += 1) {
        await db.query("INSERT INTO public.document_chunks (id, document_id, content, metadata, chunk_index) VALUES (gen_random_uuid(), $1, 'extra', '{}'::jsonb, $2)", [docId, i]);
      }
      assert.equal(await outboxCount(db), 1);
    });

    test('cascade: deleting a document whose dependants cascade enqueues it once per target with the OLD tenant key', async () => {
      await setTargets(db, []);
      const docId = await createDocument(db, mode, 20);
      await addProfileVectors(db, docId);
      const tenant = await tenantOfDoc(db, docId);
      await setTargets(db, ['qdrant', 'weaviate']);
      await deleteDocument(db, mode, docId);
      assert.equal(Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.document_chunks WHERE document_id = $1', [docId])).rows[0]?.n), 0);
      assert.equal(
        Number((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.chunk_embeddings WHERE tenant_key = $1 AND profile_id = $2', [tenant, PROFILE_1024])).rows[0]?.n),
        0,
      );
      assert.deepEqual(
        (await outbox(db)).map((r) => [r.target, r.entity, r.entity_id, r.tenant_key, r.profile_id]),
        [
          ['qdrant', 'document', docId, tenant, null],
          ['weaviate', 'document', docId, tenant, null],
        ],
      );
    });

    test('cascade: deleting chunks cascades their chunk_embeddings and enqueues the document once', async () => {
      const docId = await createDocument(db, mode, 10);
      await addProfileVectors(db, docId);
      await setTargets(db, ['qdrant']);
      await db.query('DELETE FROM public.document_chunks WHERE document_id = $1', [docId]);
      assert.deepEqual((await outbox(db)).map((r) => [r.entity, r.entity_id, r.profile_id]), [['document', docId, null]]);
    });

    test('a chunk update outside the synced columns enqueues nothing; status, is_current, embedding and lexical_text enqueue', async () => {
      const docId = await createDocument(db, mode, 3);
      await setTargets(db, ['qdrant']);
      await db.query(`UPDATE public.document_chunks SET metadata = metadata || '{"note": 1}'::jsonb, page_start = 4, section_path = ARRAY['x'] WHERE document_id = $1`, [docId]);
      await db.query("UPDATE public.document_chunks SET status = status WHERE document_id = $1", [docId]);
      await db.query("UPDATE public.documents SET filename = 'renamed.txt', metadata = '{\"a\": 1}'::jsonb WHERE id = $1", [docId]);
      assert.equal(await outboxCount(db), 0, 'non-synced or unchanged columns must not enqueue');

      const statusBefore = (await db.query<{ s: string }>('SELECT status AS s FROM public.document_chunks WHERE document_id = $1 LIMIT 1', [docId])).rows[0]!.s;
      const nextStatus = statusBefore === 'ready' ? 'failed' : 'ready';
      const changes: [string, string, unknown[]][] = [
        ['status', 'UPDATE public.document_chunks SET status = $2 WHERE document_id = $1', [docId, nextStatus]],
        ['is_current', 'UPDATE public.document_chunks SET is_current = NOT is_current WHERE document_id = $1', [docId]],
        ['embedding', `UPDATE public.document_chunks SET embedding = $2::vector WHERE document_id = $1`, [docId, `[${Array(1536).fill('0.01').join(',')}]`]],
        ['lexical_text', "UPDATE public.document_chunks SET lexical_text = 'fresh tokens' WHERE document_id = $1", [docId]],
      ];
      for (const [label, sql, params] of changes) {
        await resetOutbox(db);
        await db.query(sql, params);
        assert.deepEqual((await outbox(db)).map((r) => [r.entity, r.entity_id]), [['document', docId]], label);
      }
    });

    test('a document status or is_current change (quarantine, release, soft delete, publish) enqueues the document', async () => {
      const docId = await createDocument(db, mode, 2);
      const tenant = await tenantOfDoc(db, docId);
      await setTargets(db, ['weaviate']);
      await db.query("UPDATE public.documents SET status = 'quarantined' WHERE id = $1", [docId]);
      assert.deepEqual((await outbox(db)).map((r) => [r.target, r.entity_id, r.tenant_key]), [['weaviate', docId, tenant]]);
      await db.query("UPDATE public.vector_sync_outbox SET status = 'done'");
      await db.query("UPDATE public.documents SET status = 'ready' WHERE id = $1", [docId]);
      assert.equal(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM public.vector_sync_outbox WHERE status = 'pending'")).rows[0]?.n), 1);
    });

    test('a chunk_embeddings insert, update and delete enqueue the chunk document with that profile_id', async () => {
      const docId = await createDocument(db, mode, 4);
      const tenant = await tenantOfDoc(db, docId);
      await setTargets(db, ['qdrant']);
      await addProfileVectors(db, docId);
      assert.deepEqual(await outbox(db), [{ target: 'qdrant', entity: 'document', entity_id: docId, tenant_key: tenant, profile_id: PROFILE_1024, status: 'pending' }]);
      await resetOutbox(db);
      await db.query('UPDATE public.chunk_embeddings SET embedding = $2::halfvec WHERE chunk_id IN (SELECT id FROM public.document_chunks WHERE document_id = $1)', [
        docId,
        halfvecLiteral(1024, 3),
      ]);
      assert.deepEqual((await outbox(db)).map((r) => [r.entity_id, r.profile_id]), [[docId, PROFILE_1024]]);
      await resetOutbox(db);
      await db.query('DELETE FROM public.chunk_embeddings WHERE chunk_id IN (SELECT id FROM public.document_chunks WHERE document_id = $1)', [docId]);
      assert.deepEqual((await outbox(db)).map((r) => [r.entity_id, r.profile_id]), [[docId, PROFILE_1024]]);
    });

    test('an embedding profile status flip enqueues one profile row embedding:<id> per target', async () => {
      await setTargets(db, ['qdrant', 'weaviate']);
      await db.query("UPDATE public.embedding_profiles SET status = 'backfilling' WHERE id = $1", [PROFILE_1024]);
      assert.deepEqual(
        (await outbox(db)).map((r) => [r.target, r.entity, r.entity_id, r.tenant_key, r.profile_id]),
        [
          ['qdrant', 'profile', `embedding:${PROFILE_1024}`, null, PROFILE_1024],
          ['weaviate', 'profile', `embedding:${PROFILE_1024}`, null, PROFILE_1024],
        ],
      );
      await resetOutbox(db);
      await db.query("UPDATE public.embedding_profiles SET status = 'available' WHERE id = $1", [PROFILE_1024]);
      assert.equal(await outboxCount(db), 2);
      await resetOutbox(db);
      await db.query('UPDATE public.embedding_profiles SET query_instruction = query_instruction WHERE id = $1', [PROFILE_1024]);
      assert.equal(await outboxCount(db), 0);
    });

    test('a chunking pointer flip and rollback enqueue one chunking:<doc_type> profile row', async () => {
      await createChunkingCandidate(db, 'sync-flip', 'contract_legal');
      await setTargets(db, ['qdrant']);
      await flipChunking(db, 'contract_legal', 'sync-flip');
      assert.deepEqual((await outbox(db)).map((r) => [r.entity, r.entity_id, r.tenant_key]), [['profile', 'chunking:contract_legal', null]]);
      await resetOutbox(db);
      await flipChunking(db, 'contract_legal', 'legacy');
      assert.deepEqual((await outbox(db)).map((r) => [r.entity, r.entity_id]), [['profile', 'chunking:contract_legal']]);
      await resetOutbox(db);
      await createChunkingCandidate(db, 'sync-built', 'contract_legal');
      await db.query("UPDATE public.chunking_profiles SET status = 'retired' WHERE id = 'sync-built' AND doc_type = 'contract_legal'");
      assert.equal(await outboxCount(db), 0, 'a non-active profile change does not touch servability');
    });

    test('a leased row for the document does not absorb a new change', async () => {
      const docId = await createDocument(db, mode, 1);
      await setTargets(db, ['qdrant']);
      await db.query("UPDATE public.document_chunks SET lexical_text = 'one' WHERE document_id = $1", [docId]);
      await db.query("UPDATE public.vector_sync_outbox SET status = 'leased', lease_until = now() + interval '1 minute', attempts = 1");
      await db.query("UPDATE public.document_chunks SET lexical_text = 'two' WHERE document_id = $1", [docId]);
      const r = await db.query<{ status: string }>('SELECT status FROM public.vector_sync_outbox ORDER BY id');
      assert.deepEqual(r.rows.map((x) => x.status), ['leased', 'pending']);
    });

    if (mode === 'multi-tenant') {
      test('moving a document to an organisation enqueues it under the old and the new tenant key', async () => {
        const docId = await createDocument(db, mode, 3);
        const oldTenant = await tenantOfDoc(db, docId);
        const orgId = await createOrganization(db);
        await setTargets(db, ['qdrant']);
        await db.query('UPDATE public.documents SET organization_id = $2 WHERE id = $1', [docId, orgId]);
        assert.deepEqual(
          (await outbox(db)).map((r) => [r.entity_id, r.tenant_key]).sort(),
          [
            [docId, `o:${orgId}`],
            [docId, oldTenant],
          ].sort(),
        );
      });

      test('an upper-case user id never puts an upper-case tenant key in the outbox', async () => {
        await setTargets(db, ['qdrant', 'weaviate']);
        const docId = await createDocument(db, mode, 2, { userId: FIXTURE_USER_ID.toUpperCase() });
        await db.query("UPDATE public.documents SET status = 'quarantined' WHERE id = $1", [docId]);
        const rows = await outbox(db);
        assert.ok(rows.length > 0);
        for (const row of rows) {
          assert.equal(row.tenant_key, `u:${FIXTURE_USER_ID.toLowerCase()}`);
          assert.doesNotMatch(row.tenant_key ?? '', /[A-Z]/);
        }
      });

      test('an authenticated owner write enqueues through the definer trigger without outbox access', async () => {
        const docId = await createDocument(db, mode, 2);
        await setTargets(db, ['qdrant']);
        await db.exec('SET ROLE authenticated');
        try {
          await db.query("SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)", [FIXTURE_USER_ID]);
          const r = await db.query<{ id: string }>("UPDATE public.document_chunks SET lexical_text = 'owner edit' WHERE document_id = $1 RETURNING id", [docId]);
          assert.equal(r.rows.length, 2, 'the owner can update its chunks under RLS');
          await assert.rejects(() => db.query('SELECT 1 FROM public.vector_sync_outbox'), (e: unknown) => (e as { code?: string }).code === '42501');
        } finally {
          await db.exec('RESET ROLE');
          await db.query("SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', '', false)");
        }
        assert.deepEqual((await outbox(db)).map((r) => [r.entity_id]), [[docId]]);
      });
    }
  });
}
