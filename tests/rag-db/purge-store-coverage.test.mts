import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { MODES, asRole, errorOf } from '../helpers/purge-fixture.mts';

interface InventoryRow {
  relation: string;
  store_id: string;
  handling: 'purge_step' | 'cascade' | 'exempt';
  reason: string;
}

const PURGE_STEPS = [
  'document_chunks',
  'documents',
  'ingestion_jobs',
  'ingestion_jobs_archive',
  'rag_parse_cache',
  'rag_semantic_cache',
  'rag_answer_records',
  'chats',
  'nango_sync_records',
];
const CASCADES = ['chunk_embeddings', 'embedding_backfill_gaps', 'document_parents', 'chunking_build_gaps'];
const EXEMPT = ['rag_purge_audit', 'rag_admin_audit', 'vector_sync_outbox', 'rag_upload_approval_exemptions', 'ingestion_batches', 'rag_identifier_patterns'];

// Every public table that references a document, chunk or parent: by foreign key, or by a column named
// document_id / chunk_id / lineage_id (singular or plural, any prefix such as source_ or older_, scalar or array), or keyed by a
// document's source_key (rag_staged_attributes holds no document id; G1 of the 6.3 verification).
const REFERENCING_TABLES_SQL = `
  SELECT c.relname AS relation
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND (
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_constraint k
           JOIN pg_catalog.pg_class r ON r.oid = k.confrelid
          WHERE k.conrelid = c.oid AND k.contype = 'f'
            AND r.relnamespace = n.oid AND r.relname IN ('documents', 'document_chunks', 'document_parents')
       )
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND (a.attname ~ '(^|_)(document|chunk|lineage)_ids?$' OR a.attname = 'source_key')
       )
     )
   ORDER BY 1`;

async function referencingTables(db: PGlite): Promise<string[]> {
  return (await db.query<{ relation: string }>(REFERENCING_TABLES_SQL)).rows.map((row) => row.relation);
}

async function inventory(db: PGlite): Promise<InventoryRow[]> {
  return (await db.query<InventoryRow>('SELECT * FROM public.rag_purge_store_inventory()')).rows;
}

function missingFromInventory(found: string[], rows: InventoryRow[]): string[] {
  const listed = new Set(rows.map((row) => row.relation));
  return found.filter((relation) => !listed.has(relation));
}

for (const mode of MODES) {
  describe(`purge store coverage (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db?.close();
    });

    test('every table that references documents, chunks or parents is in rag_purge_store_inventory()', async () => {
      const found = await referencingTables(db);
      console.log(`[purge coverage] ${mode} found ${found.length}: ${found.join(', ')}`);
      assert.ok(found.includes('documents') && found.includes('document_chunks'), 'the catalog walk sees the core stores');
      assert.deepEqual(missingFromInventory(found, await inventory(db)), [], 'stores without a purge step, cascade or exemption');
    });

    test('a new extra_store table with a document_id column is reported as missing', async () => {
      await db.exec('CREATE TABLE public.extra_store (id uuid PRIMARY KEY, document_id uuid)');
      try {
        assert.deepEqual(missingFromInventory(await referencingTables(db), await inventory(db)), ['extra_store']);
      } finally {
        await db.exec('DROP TABLE public.extra_store');
      }
    });

    test('a new table keyed by source_key is reported as missing', async () => {
      await db.exec('CREATE TABLE public.extra_source_store (tenant_key text, source text, source_key text, PRIMARY KEY (tenant_key, source, source_key))');
      try {
        assert.deepEqual(missingFromInventory(await referencingTables(db), await inventory(db)), ['extra_source_store']);
      } finally {
        await db.exec('DROP TABLE public.extra_source_store');
      }
    });

    test('a new table with only a foreign key to document_chunks is reported as missing', async () => {
      await db.exec('CREATE TABLE public.extra_fk_store (id uuid PRIMARY KEY, ref uuid REFERENCES public.document_chunks (id) ON DELETE CASCADE)');
      try {
        assert.deepEqual(missingFromInventory(await referencingTables(db), await inventory(db)), ['extra_fk_store']);
      } finally {
        await db.exec('DROP TABLE public.extra_fk_store');
      }
    });

    test('the inventory marks the core stores, the cascades and the exemptions, each with a reason', async () => {
      const rows = await inventory(db);
      const byRelation = new Map(rows.map((row) => [row.relation, row]));
      assert.equal(byRelation.size, rows.length, 'one row per relation');
      for (const relation of PURGE_STEPS) assert.equal(byRelation.get(relation)?.handling, 'purge_step', relation);
      for (const relation of CASCADES) assert.equal(byRelation.get(relation)?.handling, 'cascade', relation);
      for (const relation of EXEMPT) assert.equal(byRelation.get(relation)?.handling, 'exempt', relation);
      for (const row of rows) {
        assert.ok(['purge_step', 'cascade', 'exempt'].includes(row.handling), `${row.relation} handling`);
        assert.ok(row.reason.trim().length > 0, `${row.relation} has a reason`);
        if (row.handling !== 'exempt') assert.ok(row.store_id.trim().length > 0, `${row.relation} names its store id`);
      }
      assert.match(byRelation.get('rag_purge_audit')?.reason ?? '', /ids and hashes/);
      for (const relation of ['rag_retrieval_log', 'rag_review_items']) {
        assert.equal(byRelation.get(relation)?.handling, 'exempt', relation);
        assert.equal(byRelation.get(relation)?.reason, 'ids only, 30 and 90 day retention', relation);
      }
    });

    test('every cascade relation that exists has an ON DELETE CASCADE foreign key to a purged store', async () => {
      const cascades = (await inventory(db)).filter((row) => row.handling === 'cascade').map((row) => row.relation);
      const result = await db.query<{ relation: string }>(
        `SELECT c.relname AS relation
           FROM pg_catalog.pg_class c
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          WHERE c.relname = ANY ($1::text[])
            AND EXISTS (
              SELECT 1 FROM pg_catalog.pg_constraint k
                JOIN pg_catalog.pg_class r ON r.oid = k.confrelid
               WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confdeltype = 'c'
                 AND r.relname IN ('documents', 'document_chunks', 'document_parents', 'chunk_translations')
            )`,
        [cascades],
      );
      const existing = (await db.query<{ relname: string }>("SELECT relname FROM pg_catalog.pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY ($1::text[])", [cascades])).rows.map(
        (row) => row.relname,
      );
      assert.deepEqual(result.rows.map((row) => row.relation).sort(), existing.sort());
    });

    test('anon and authenticated get 42501 on rag_purge_store_inventory', async () => {
      for (const role of ['anon', 'authenticated'] as const) {
        const refused = await errorOf(() => asRole(db, role, null, () => db.query('SELECT * FROM public.rag_purge_store_inventory()')));
        assert.equal(refused.code, '42501', role);
      }
      const allowed = await asRole(db, 'service_role', null, () => db.query('SELECT count(*) AS n FROM public.rag_purge_store_inventory()'));
      assert.ok(Number((allowed.rows[0] as { n: number }).n) > 0);
    });
  });
}
