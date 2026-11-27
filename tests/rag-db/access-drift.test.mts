import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

// Phase 4.3 plan 04 (D-03, D-17, D-19, D-30, D-33, A-08, A-11): every derived row of a document carries the document's access_groups after
// ingest, rechunk, relabel, version replace and quarantine release, current and superseded rows alike, and rag_access_groups_drift() proves it.
// Fixtures are neutral synthetic sentences.

const MIGRATION = 'supabase/migrations/0921_access_groups_columns.sql';
const id = (kind: string, n: number): string => `00000000-0000-4000-8000-${kind}${String(n).padStart(8, '0')}`;

const OWNER = id('9411', 1);
const ORG = id('9412', 1);
const DOC = id('9413', 1);
const CHUNK = id('9414', 1);
const PARENT = id('9415', 1);

type Row = Record<string, unknown>;
type Drift = { store: string; rows: number };

async function rows<T = Row>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function drift(db: PGlite): Promise<Drift[]> {
  return (await rows<{ store: string; rows: string | number }>(db, 'SELECT store, rows FROM public.rag_access_groups_drift() ORDER BY store')).map((row) => ({
    store: row.store,
    rows: Number(row.rows),
  }));
}

async function assertNoDrift(db: PGlite, label: string): Promise<Drift[]> {
  const result = await drift(db);
  assert.ok(result.length >= 2, `${label}: drift lists chunks and parents`);
  for (const entry of result) assert.equal(entry.rows, 0, `${label}: ${entry.store} drifts`);
  return result;
}

async function asServiceRole<T>(db: PGlite, run: () => Promise<T>): Promise<T> {
  await db.exec('SET ROLE service_role');
  try {
    return await run();
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function labelsOf(db: PGlite, table: string, documentId: string): Promise<string[][]> {
  return (await rows<{ access_groups: string[] }>(db, `SELECT access_groups FROM public.${table} WHERE document_id = $1`, [documentId])).map(
    (row) => row.access_groups,
  );
}

async function assertAllLabelled(db: PGlite, table: string, documentId: string, expected: string[], label: string): Promise<void> {
  const labels = await labelsOf(db, table, documentId);
  assert.ok(labels.length > 0, `${label}: ${table} has rows`);
  for (const value of labels) assert.deepEqual(value, expected, `${label}: ${table}`);
}

for (const mode of ['single-tenant', 'multi-tenant'] as DeploymentMode[]) {
  describe(`access_groups follow the document on every derived store (${mode})`, () => {
    let db: PGlite;
    let groupA: string;
    let groupB: string;
    let corpusDir: string;
    const multi = mode === 'multi-tenant';
    const tenantKey = multi ? `o:${ORG}` : 's:default';
    const keyA = (): string => `g:${groupA}`;
    const keyB = (): string => `g:${groupB}`;

    async function insertChunk(documentId: string, index: number, profile = 'legacy', groups = '{all}', chunkId?: string): Promise<string> {
      const result = await rows<{ id: string }>(
        db,
        `INSERT INTO public.document_chunks (id, document_id, content, chunk_index, chunking_profile_id, access_groups)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::text[]) RETURNING id`,
        [chunkId ?? null, documentId, `Neutral synthetic sentence number ${index} of the drift record.`, index, profile, groups],
      );
      return result[0]!.id;
    }

    async function insertParent(documentId: string, index: number, profile = 'legacy', parentId?: string): Promise<void> {
      await db.query(
        `INSERT INTO public.document_parents (id, document_id, tenant_key, chunking_profile_id, content, token_count, parent_index, access_groups)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, 'Neutral synthetic parent section.', 4, $5, '{all}')`,
        [parentId ?? null, documentId, tenantKey, profile, index],
      );
    }

    async function begin(sourceKey: string, sha: string): Promise<string> {
      const begun = await rows<{ outcome: string; document_id: string }>(
        db,
        `SELECT * FROM rag_begin_document_version(
           p_tenant_key => $1, p_user_id => $2::uuid, p_org_id => $3::uuid, p_source => 'config_upload', p_source_key => $4, p_filename => $4,
           p_file_sha256 => $5, p_doc_type => 'general', p_doc_type_origin => 'fallback', p_profile_id => 'general@1', p_profile_version => 1)`,
        [tenantKey, OWNER, multi ? ORG : null, sourceKey, crypto.createHash('sha256').update(sha).digest('hex')],
      );
      assert.equal(begun[0]?.outcome, 'created', `${sourceKey} ${sha} begins`);
      return begun[0]!.document_id;
    }

    async function writeChunks(documentId: string, label: string): Promise<void> {
      const chunk = { content: `${label} neutral synthetic clause`, chunk_index: 0, section_path: ['Record'], chunk_kind: 'text', embedding_text_version: 1, metadata: {} };
      await db.query('SELECT * FROM rag_write_chunks(p_document_id => $1, p_tenant_key => $2, p_chunks => $3::jsonb, p_embeddings => NULL, p_final => true, p_total => 1)', [
        documentId,
        tenantKey,
        JSON.stringify([chunk]),
      ]);
    }

    async function publish(documentId: string): Promise<string> {
      const published = await rows<{ outcome: string }>(db, 'SELECT * FROM rag_publish_document_version(p_document_id => $1, p_tenant_key => $2)', [documentId, tenantKey]);
      return String(published[0]?.outcome);
    }

    async function groupsOf(documentId: string): Promise<string[]> {
      return (await rows<{ access_groups: string[] }>(db, 'SELECT access_groups FROM public.documents WHERE id = $1', [documentId]))[0]!.access_groups;
    }

    before(async () => {
      corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-drift-corpus-'));
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir, supabaseGrants: true })).db;
      await db.query("INSERT INTO auth.users (id, email) VALUES ($1, 'owner@example.invalid') ON CONFLICT DO NOTHING", [OWNER]);
      await db.query('INSERT INTO admin_users (id) VALUES ($1) ON CONFLICT DO NOTHING', [OWNER]);
      if (multi) {
        await db.query("INSERT INTO organizations (id, name, slug, owner_id, is_personal) VALUES ($1, 'Workspace', 'access-drift', $2, false)", [ORG, OWNER]);
        await db.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [ORG, OWNER]);
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-a', 'Group', $1) RETURNING id", [ORG]))[0]!.id;
        groupB = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name, organization_id) VALUES ('group-b', 'Group', $1) RETURNING id", [ORG]))[0]!.id;
      } else {
        groupA = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name) VALUES ('group-a', 'Group') RETURNING id"))[0]!.id;
        groupB = (await rows<{ id: string }>(db, "INSERT INTO rag_access_groups (key, name) VALUES ('group-b', 'Group') RETURNING id"))[0]!.id;
      }
      await db.query(
        `INSERT INTO public.documents (id, filename, content, user_id${multi ? ', organization_id' : ''})
         VALUES ($1, 'drift-record.md', 'Neutral synthetic drift record.', $2${multi ? ', $3' : ''})`,
        multi ? [DOC, OWNER, ORG] : [DOC, OWNER],
      );
      await insertParent(DOC, 0, 'legacy', PARENT);
      await insertChunk(DOC, 0, 'legacy', '{all}', CHUNK);
      await insertChunk(DOC, 1);
    });

    after(async () => {
      await db?.close();
      if (corpusDir) fs.rmSync(corpusDir, { recursive: true, force: true });
    });

    test('a relabel by service_role reaches every chunk and parent in the same statement, and drift stays at zero', async () => {
      await asServiceRole(db, () => db.query('UPDATE public.documents SET access_groups = $2::text[] WHERE id = $1', [DOC, [keyA()]]));
      await assertAllLabelled(db, 'document_chunks', DOC, [keyA()], 'relabel');
      await assertAllLabelled(db, 'document_parents', DOC, [keyA()], 'relabel');
      const result = await assertNoDrift(db, 'relabel');
      assert.deepEqual(result.map((entry) => entry.store), ['chunk_translations', 'document_chunks', 'document_parents', 'rag_table_rows']);
    });

    test('a writer sending {all} on insert or update still stores the document label, also after a rechunk', async () => {
      await insertChunk(DOC, 2);
      await db.query("UPDATE public.document_chunks SET access_groups = '{all}' WHERE id = $1", [CHUNK]);
      await db.query("UPDATE public.document_parents SET access_groups = '{all}' WHERE id = $1", [PARENT]);
      await insertParent(DOC, 0, 'access-drift-profile');
      await insertChunk(DOC, 0, 'access-drift-profile');
      await assertAllLabelled(db, 'document_chunks', DOC, [keyA()], 'rechunk');
      await assertAllLabelled(db, 'document_parents', DOC, [keyA()], 'rechunk');
      await assertNoDrift(db, 'rechunk');
    });

    test('chunk_translations and rag_table_rows are present, copy the label on write and follow a relabel', async () => {
      assert.ok((await rows(db, "SELECT to_regclass('public.chunk_translations') AS t WHERE to_regclass('public.chunk_translations') IS NOT NULL")).length === 1);
      await db.query(
        `INSERT INTO public.chunk_translations (chunk_id, document_id, tenant_key, language, content, source_content_hash, model, access_groups)
         VALUES ($1, $2, $3, 'xx', 'Neutral synthetic translated sentence.', 'hash-1', 'fixture-model', '{all}')`,
        [CHUNK, DOC, tenantKey],
      );
      await db.query(
        `INSERT INTO public.rag_table_rows (tenant_key, document_id, version, is_current, status, table_key, row_index, access_groups)
         SELECT d.tenant_key, d.id, COALESCE(d.version, 1), d.is_current, d.status, 'table-1', 0, '{all}' FROM public.documents d WHERE d.id = $1`,
        [DOC],
      );
      await assertAllLabelled(db, 'chunk_translations', DOC, [keyA()], 'insert');
      await assertAllLabelled(db, 'rag_table_rows', DOC, [keyA()], 'insert');
      await asServiceRole(db, () => db.query('UPDATE public.documents SET access_groups = $2::text[] WHERE id = $1', [DOC, [keyA(), keyB()]]));
      for (const table of ['document_chunks', 'document_parents', 'chunk_translations', 'rag_table_rows']) {
        await assertAllLabelled(db, table, DOC, [keyA(), keyB()], 'relabel');
      }
      await db.query("UPDATE public.chunk_translations SET access_groups = '{all}' WHERE document_id = $1", [DOC]);
      await db.query("UPDATE public.rag_table_rows SET access_groups = '{all}' WHERE document_id = $1", [DOC]);
      await assertAllLabelled(db, 'chunk_translations', DOC, [keyA(), keyB()], 'writer update');
      await assertAllLabelled(db, 'rag_table_rows', DOC, [keyA(), keyB()], 'writer update');
      await assertNoDrift(db, 'derived stores');
    });

    test('a new version inherits its lineage label; an explicit label is kept; drift is zero after publish and quarantine release', async () => {
      const sourceKey = 'access-drift/lineage.md';
      const first = await begin(sourceKey, 'one');
      await writeChunks(first, 'first');
      assert.equal(await publish(first), 'published');
      await asServiceRole(db, () => db.query('UPDATE public.documents SET access_groups = $2::text[] WHERE id = $1', [first, [keyA()]]));
      await assertAllLabelled(db, 'document_chunks', first, [keyA()], 'first version');

      const second = await begin(sourceKey, 'two');
      assert.deepEqual(await groupsOf(second), [keyA()], 'the new version inherits the current version label');
      await writeChunks(second, 'second');
      await assertAllLabelled(db, 'document_chunks', second, [keyA()], 'second version chunks');
      assert.equal(await publish(second), 'published');
      const currency = await rows<{ id: string; is_current: boolean }>(db, 'SELECT id, is_current FROM public.documents WHERE id = ANY($1::uuid[])', [[first, second]]);
      assert.deepEqual(Object.fromEntries(currency.map((row) => [row.id, row.is_current])), { [first]: false, [second]: true });
      await assertAllLabelled(db, 'document_chunks', first, [keyA()], 'superseded chunks keep their label');
      await assertNoDrift(db, 'version replace');

      const lineage = (await rows<{ lineage_id: string }>(db, 'SELECT lineage_id FROM public.documents WHERE id = $1', [second]))[0]!.lineage_id;
      const explicit = id('9413', 9);
      await db.query(
        `INSERT INTO public.documents (id, lineage_id, version, is_current, status, source, source_key, filename, content, user_id${multi ? ', organization_id' : ''}, access_groups)
         VALUES ($1, $2, 99, false, 'processing', 'config_upload', $3, 'explicit.md', '', $4${multi ? ', $6' : ''}, $5::text[])`,
        multi ? [explicit, lineage, sourceKey, OWNER, [keyB()], ORG] : [explicit, lineage, sourceKey, OWNER, [keyB()]],
      );
      assert.deepEqual(await groupsOf(explicit), [keyB()], 'an explicit non-default label is kept');
      await db.query('DELETE FROM public.documents WHERE id = $1', [explicit]);

      const third = await begin(sourceKey, 'three');
      assert.deepEqual(await groupsOf(third), [keyA()]);
      await writeChunks(third, 'third');
      await db.query("UPDATE public.documents SET status = 'quarantined' WHERE id = $1", [third]);
      await db.query("UPDATE public.document_chunks SET status = 'quarantined' WHERE document_id = $1", [third]);
      const released = await rows<{ outcome: string }>(db, 'SELECT * FROM rag_release_quarantine($1, $2)', [third, OWNER]);
      assert.equal(released[0]?.outcome, 'published');
      assert.deepEqual(await groupsOf(third), [keyA()], 'release keeps the label');
      await assertAllLabelled(db, 'document_chunks', third, [keyA()], 'released chunks');
      await assertNoDrift(db, 'quarantine release');
    });

    test('an absent optional store is skipped, and re-applying 0921 after it appears completes it', async () => {
      // Simulate a database without Phase 4.2's table-row store: the table and 0852's follow trigger on documents.
      await db.query('DROP TRIGGER IF EXISTS rag_table_rows_follow_document ON public.documents');
      await db.query('DROP TABLE public.rag_table_rows CASCADE');
      await applyMigrationFiles(db, [MIGRATION]);
      assert.deepEqual((await drift(db)).map((entry) => entry.store), ['chunk_translations', 'document_chunks', 'document_parents']);
      await asServiceRole(db, () => db.query('UPDATE public.documents SET access_groups = $2::text[] WHERE id = $1', [DOC, [keyB()]]));
      await assertAllLabelled(db, 'document_chunks', DOC, [keyB()], 'relabel without the store');

      await db.query('CREATE TABLE public.rag_table_rows (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document_id uuid NOT NULL REFERENCES public.documents (id) ON DELETE CASCADE)');
      await db.query('INSERT INTO public.rag_table_rows (document_id) VALUES ($1)', [DOC]);
      await applyMigrationFiles(db, [MIGRATION]);
      await assertAllLabelled(db, 'rag_table_rows', DOC, [keyB()], 'alignment on re-run');
      const index = await rows(db, "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'rag_table_rows_access_groups_gin'");
      assert.equal(index.length, 1, 'GIN index added on re-run');
      await db.query("INSERT INTO public.rag_table_rows (document_id, access_groups) VALUES ($1, '{all}')", [DOC]);
      await asServiceRole(db, () => db.query('UPDATE public.documents SET access_groups = $2::text[] WHERE id = $1', [DOC, [keyA()]]));
      await assertAllLabelled(db, 'rag_table_rows', DOC, [keyA()], 'stand-in store follows a relabel');
      const result = await assertNoDrift(db, 'stand-in store');
      assert.ok(result.some((entry) => entry.store === 'rag_table_rows'), 'drift lists the completed store');
    });

    test('the drift function is service_role only and fixed to an empty search_path', async () => {
      const meta = await rows<{ prosecdef: boolean; proconfig: string[] | null; volatile: string }>(
        db,
        "SELECT prosecdef, proconfig, provolatile AS volatile FROM pg_proc WHERE oid = 'public.rag_access_groups_drift()'::regprocedure",
      );
      assert.deepEqual(meta[0], { prosecdef: false, proconfig: ['search_path=""'], volatile: 's' });
      for (const role of ['anon', 'authenticated']) {
        const allowed = await rows<{ ok: boolean }>(db, "SELECT has_function_privilege($1, 'public.rag_access_groups_drift()', 'EXECUTE') AS ok", [role]);
        assert.equal(allowed[0]?.ok, false, role);
      }
      assert.equal((await asServiceRole(db, () => drift(db))).length >= 2, true);
    });
  });
}
