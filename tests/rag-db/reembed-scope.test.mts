import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles, migrationFiles } from '../../eval/harness/migrations.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATION = 'supabase/migrations/0442_reembed_scope.sql';

const LAW = 'voyage-law-2-1024';
const FINANCE = 'voyage-finance-2-1024';
const UNSCOPED = 'voyage-4-large-1024';
const QWEN_2048 = 'qwen3-8b-2048';
const LEGACY = 'openai-3-small-1536';
const SECOND_USER = '00000000-0000-4000-8000-0000000000b7';

type Row = Record<string, unknown>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unitVector(dims: number, hot: number): number[] {
  return Array.from({ length: dims }, (_, index) => (index === hot % dims ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------------
// The SQL functions, on a database built without 0442 and then upgraded with it.
// ---------------------------------------------------------------------------------------------------------------------

describe('0442 scoped re-embed SQL (multi-tenant)', () => {
  let db: PGlite;
  let tenantA: string;
  let tenantB: string;
  const ids: Record<string, string[]> = {};
  let before0442: { counts: Row[]; countA: Row[]; pick: string[]; preview: string[] };
  let applyError: string | null = null;

  async function query(sql: string, params: unknown[] = []): Promise<Row[]> {
    try {
      return (await db.query<Row>(sql, params)).rows;
    } catch (error) {
      return assert.fail(`${sql.slice(0, 80).replace(/\s+/g, ' ')} failed: ${messageOf(error)}`);
    }
  }

  async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
    try {
      await db.query(sql, params);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  }

  async function insertDocument(owner: string, docType: string, chunks: number, chunkDocType: string | null = null): Promise<string[]> {
    const documentId = crypto.randomUUID();
    await db.query('INSERT INTO public.documents (id, filename, content, metadata, user_id, doc_type) VALUES ($1, $2, $3, $4::jsonb, $5, $6)', [
      documentId,
      `scope-${documentId.slice(0, 8)}.md`,
      'A neutral synthetic paragraph about a sample record.',
      '{}',
      owner,
      docType,
    ]);
    const out: string[] = [];
    for (let index = 0; index < chunks; index += 1) {
      const chunkId = crypto.randomUUID();
      await db.query('INSERT INTO public.document_chunks (id, document_id, content, chunk_index, metadata) VALUES ($1, $2, $3, $4, $5::jsonb)', [
        chunkId,
        documentId,
        `A neutral synthetic sentence number ${index}.`,
        index,
        '{}',
      ]);
      if (chunkDocType !== null) await db.query('UPDATE public.document_chunks SET doc_type = $2 WHERE id = $1', [chunkId, chunkDocType]);
      out.push(chunkId);
    }
    return out;
  }

  const counts = (profileId: string, tenantKey: string | null) =>
    query('SELECT tenant_key, chunks::int AS chunks, chunks_missing::int AS chunks_missing, content_chars::int AS content_chars FROM public.rag_reembed_count($1, $2) ORDER BY tenant_key', [
      profileId,
      tenantKey,
    ]);

  const pickIds = async (profileId: string, tenantKey: string | null): Promise<string[]> =>
    (await query('SELECT id FROM public.rag_reembed_pick($1, $2, NULL, 1000)', [profileId, tenantKey])).map((row) => String(row.id));

  const previewIds = async (profileId: string, tenantKey: string | null): Promise<string[]> =>
    (await query('SELECT id FROM public.rag_reembed_preview_batch($1, $2, NULL, 1000)', [profileId, tenantKey])).map((row) => String(row.id));

  const startRun = async (profileId: string, tenantKey: string | null): Promise<Row> =>
    (await query("SELECT * FROM public.rag_reembed_start_run($1, $2, 'test', NULL)", [profileId, tenantKey]))[0] as Row;

  const startError = (profileId: string, tenantKey: string | null, derivedFrom: string | null = null) =>
    errorOf("SELECT * FROM public.rag_reembed_start_run($1, $2, 'test', $3)", [profileId, tenantKey, derivedFrom]);

  const profileStatus = async (profileId: string): Promise<string> =>
    String((await query('SELECT status FROM public.embedding_profiles WHERE id = $1', [profileId]))[0]?.status);

  async function binding(docType: string, tenantKey: string | null, profileId: string, status: 'available' | 'backfilling' | 'active'): Promise<string> {
    const created = (await query("SELECT * FROM public.rag_create_embedding_binding($1, $2, $3, 'operator-test')", [docType, tenantKey, profileId]))[0] as Row;
    const id = String(created.binding_id);
    if (status === 'backfilling') await query("SELECT * FROM public.rag_set_embedding_binding_status($1, 'backfilling', 'operator-test')", [id]);
    if (status === 'active') await query("UPDATE public.embedding_profile_bindings SET status = 'active' WHERE id = $1", [id]);
    return id;
  }

  /** Fills a run the way the job does: next_batch with the cursor, write_batch, then finish. Returns the chunk ids written. */
  async function fill(runId: string, batch = 2, stopAfter = Infinity): Promise<string[]> {
    const written: string[] = [];
    let after: string | null = null;
    let batches = 0;
    for (;;) {
      if (batches >= stopAfter) return written;
      const chunks = await query('SELECT id FROM public.rag_reembed_next_batch($1, $2, $3)', [runId, after, batch]);
      if (chunks.length === 0) break;
      const rows = chunks.map((row, index) => ({ chunk_id: String(row.id), vector: unitVector(1024, index), host: 'fake-host' }));
      await query('SELECT * FROM public.rag_reembed_write_batch($1, $2::jsonb, $3, 0)', [runId, JSON.stringify(rows), String(chunks[chunks.length - 1]?.id)]);
      written.push(...chunks.map((row) => String(row.id)));
      after = String(chunks[chunks.length - 1]?.id);
      batches += 1;
    }
    for (;;) {
      const missing = await query('SELECT id FROM public.rag_reembed_missing_batch($1, NULL, $2)', [runId, batch]);
      if (missing.length === 0) break;
      const rows = missing.map((row, index) => ({ chunk_id: String(row.id), vector: unitVector(1024, index), host: 'fake-host' }));
      await query('SELECT * FROM public.rag_reembed_write_batch($1, $2::jsonb, NULL, 0)', [runId, JSON.stringify(rows)]);
      written.push(...missing.map((row) => String(row.id)));
    }
    await query("SELECT * FROM public.rag_reembed_finish_run($1, 'completed')", [runId]);
    return written;
  }

  const vectorChunks = async (profileId: string): Promise<string[]> =>
    (await query('SELECT chunk_id FROM public.chunk_embeddings WHERE profile_id = $1 ORDER BY chunk_id', [profileId])).map((row) => String(row.chunk_id));

  const sorted = (values: string[]) => [...values].sort();

  before(async () => {
    const fixture = await createEmptyFixtureDatabase({ deploymentMode: 'multi-tenant', migrations: false });
    db = fixture.db;
    await applyMigrationFiles(
      db,
      migrationFiles('multi-tenant').filter((file) => !file.startsWith('supabase/migrations/0442_')),
    );
    await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [SECOND_USER, 'second-user@example.invalid']);
    tenantA = `u:${fixture.fixtureUserId}`;
    tenantB = `u:${SECOND_USER}`;

    ids.contractA = await insertDocument(fixture.fixtureUserId, 'contract_legal', 3);
    ids.financialA = await insertDocument(fixture.fixtureUserId, 'financial_report', 2);
    ids.invoiceA = await insertDocument(fixture.fixtureUserId, 'invoice_receipt', 1);
    ids.generalA = await insertDocument(fixture.fixtureUserId, 'general', 2);
    ids.overrideA = await insertDocument(fixture.fixtureUserId, 'general', 1, 'contract_legal');
    ids.contractB = await insertDocument(SECOND_USER, 'contract_legal', 2);
    ids.generalB = await insertDocument(SECOND_USER, 'general', 1);

    before0442 = {
      counts: await counts(UNSCOPED, null),
      countA: await counts(UNSCOPED, tenantA),
      pick: await pickIds(UNSCOPED, null),
      preview: await previewIds(UNSCOPED, tenantA),
    };

    if (fs.existsSync(path.join(REPO_ROOT, MIGRATION))) {
      try {
        await applyMigrationFiles(db, [MIGRATION]);
      } catch (error) {
        applyError = messageOf(error);
      }
    } else {
      applyError = `${MIGRATION} missing`;
    }
  });

  after(async () => {
    await db?.close();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM public.embedding_backfill_gaps');
    await db.query('DELETE FROM public.embedding_backfill_runs');
    await db.query("DELETE FROM public.chunk_embeddings WHERE profile_id <> 'openai-3-small-1536'");
    await db.query('DELETE FROM public.embedding_profile_bindings');
  });

  test('0442 applies on top of every earlier migration', () => {
    assert.equal(applyError, null);
  });

  test('an unscoped profile counts, picks and previews exactly what the pre-0442 functions returned', async () => {
    assert.deepEqual(await counts(UNSCOPED, null), before0442.counts);
    assert.deepEqual(await counts(UNSCOPED, tenantA), before0442.countA);
    assert.deepEqual(await pickIds(UNSCOPED, null), before0442.pick);
    assert.deepEqual(await previewIds(UNSCOPED, tenantA), before0442.preview);
    const total = before0442.counts.reduce((sum, row) => sum + Number(row.chunks), 0);
    assert.ok(total >= 12, 'the unscoped profile sees every current ready chunk');
  });

  test('count, pick and preview of a scoped profile see only its doc types, chunk doc type first', async () => {
    const lawCounts = await counts(LAW, null);
    assert.deepEqual(
      lawCounts.map((row) => [row.tenant_key, row.chunks, row.chunks_missing]),
      [
        [tenantA, ids.contractA!.length + ids.overrideA!.length, ids.contractA!.length + ids.overrideA!.length],
        [tenantB, ids.contractB!.length, ids.contractB!.length],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    assert.deepEqual(sorted(await pickIds(LAW, null)), sorted([...ids.contractA!, ...ids.overrideA!, ...ids.contractB!]));
    assert.deepEqual(sorted(await previewIds(LAW, tenantA)), sorted([...ids.contractA!, ...ids.overrideA!]));

    const financeCounts = await counts(FINANCE, tenantA);
    assert.deepEqual(financeCounts.map((row) => [row.tenant_key, row.chunks]), [[tenantA, ids.financialA!.length + ids.invoiceA!.length]]);
    assert.deepEqual(sorted(await pickIds(FINANCE, null)), sorted([...ids.financialA!, ...ids.invoiceA!]));
  });

  test('start_run on a scoped profile needs a backfilling binding covering the run, counts only its scope and never moves the profile status', async () => {
    assert.match((await startError(LAW, null)) ?? 'no error', /^reembed_refused: no_backfilling_binding/);
    assert.match((await startError(LAW, tenantA)) ?? 'no error', /^reembed_refused: no_backfilling_binding/);
    await binding('contract_legal', null, LAW, 'available');
    assert.match((await startError(LAW, null)) ?? 'no error', /^reembed_refused: no_backfilling_binding/, 'an available binding is not enough');

    await db.query('DELETE FROM public.embedding_profile_bindings');
    await binding('contract_legal', null, LAW, 'backfilling');
    const run = await startRun(LAW, null);
    assert.equal(Number(run.chunks_total), ids.contractA!.length + ids.overrideA!.length + ids.contractB!.length);
    assert.equal(await profileStatus(LAW), 'available');
    assert.equal((await query('SELECT * FROM public.rag_reembed_get_run($1)', [run.run_id]))[0]?.profile_status, 'available');

    const written = await fill(String(run.run_id));
    assert.deepEqual(sorted(written), sorted([...ids.contractA!, ...ids.overrideA!, ...ids.contractB!]), 'only in-scope chunks were picked');
    assert.deepEqual(await vectorChunks(LAW), sorted(written));
    assert.equal(Number((await query('SELECT * FROM public.rag_reembed_remaining($1)', [run.run_id]))[0]?.chunks_missing), 0);
    assert.equal(await profileStatus(LAW), 'available');
  });

  test('a tenant binding covers only its own tenant; a run for every tenant is refused', async () => {
    await binding('contract_legal', tenantA, LAW, 'backfilling');
    assert.match((await startError(LAW, null)) ?? 'no error', /^reembed_refused: no_backfilling_binding/);
    assert.match((await startError(LAW, tenantB)) ?? 'no error', /^reembed_refused: no_backfilling_binding/);
    const run = await startRun(LAW, tenantA);
    assert.equal(Number(run.chunks_total), ids.contractA!.length + ids.overrideA!.length);
    const written = await fill(String(run.run_id));
    assert.deepEqual(sorted(written), sorted([...ids.contractA!, ...ids.overrideA!]));
    const tenants = await query('SELECT DISTINCT tenant_key FROM public.chunk_embeddings WHERE profile_id = $1', [LAW]);
    assert.deepEqual(tenants.map((row) => row.tenant_key), [tenantA], "a run for A never touches B's chunks");
    assert.equal(await profileStatus(LAW), 'available');
  });

  test('an active binding allows a top-up run; the pick skips chunks that already hold the vector', async () => {
    const first = await binding('contract_legal', null, LAW, 'backfilling');
    const run = await startRun(LAW, null);
    await fill(String(run.run_id));
    await db.query("UPDATE public.embedding_profile_bindings SET status = 'active' WHERE id = $1", [first]);

    const added = await insertDocument(SECOND_USER, 'contract_legal', 2);
    assert.deepEqual(sorted(await pickIds(LAW, null)), sorted(added), 'only chunks without a vector are picked');
    const topUp = await startRun(LAW, null);
    assert.equal(await profileStatus(LAW), 'available');
    const written = await fill(String(topUp.run_id));
    assert.deepEqual(sorted(written), sorted(added));
    const missing = await counts(LAW, null);
    assert.ok(missing.every((row) => Number(row.chunks_missing) === 0), 'every in-scope chunk holds the vector');
  });

  test('rollback deletes the run vectors, keeps the profile available, and is refused while a covering binding is active', async () => {
    const id = await binding('contract_legal', null, LAW, 'backfilling');
    const run = await startRun(LAW, null);
    await fill(String(run.run_id));
    assert.ok((await vectorChunks(LAW)).length > 0);

    await db.query("UPDATE public.embedding_profile_bindings SET status = 'active' WHERE id = $1", [id]);
    assert.match(
      (await errorOf("SELECT * FROM public.rag_reembed_rollback_run($1, 'test')", [run.run_id])) ?? 'no error',
      /^reembed_refused: binding_active/,
    );
    assert.ok((await vectorChunks(LAW)).length > 0, 'a refused rollback deletes nothing');

    await db.query("UPDATE public.embedding_profile_bindings SET status = 'available' WHERE id = $1", [id]);
    const rolled = (await query("SELECT * FROM public.rag_reembed_rollback_run($1, 'test')", [run.run_id]))[0] as Row;
    assert.equal(Number(rolled.rows_deleted), ids.contractA!.length + ids.overrideA!.length + ids.contractB!.length);
    assert.equal(rolled.profile_status, 'available');
    assert.equal(await profileStatus(LAW), 'available');
    assert.deepEqual(await vectorChunks(LAW), []);
  });

  test("rollback of a tenant run is refused by an active binding of that tenant or of the whole deployment, not by another tenant's", async () => {
    await binding('contract_legal', tenantA, LAW, 'backfilling');
    const run = await startRun(LAW, tenantA);
    await fill(String(run.run_id));
    const other = await binding('contract_legal', tenantB, LAW, 'available');
    await db.query("UPDATE public.embedding_profile_bindings SET status = 'active' WHERE id = $1", [other]);
    const rolled = (await query("SELECT * FROM public.rag_reembed_rollback_run($1, 'test')", [run.run_id]))[0] as Row;
    assert.equal(Number(rolled.rows_deleted), ids.contractA!.length + ids.overrideA!.length);

    await db.query('DELETE FROM public.embedding_profile_bindings');
    await binding('contract_legal', tenantA, LAW, 'backfilling');
    const second = await startRun(LAW, tenantA);
    await fill(String(second.run_id));
    const wide = await binding('contract_legal', null, LAW, 'available');
    await db.query("UPDATE public.embedding_profile_bindings SET status = 'active' WHERE id = $1", [wide]);
    assert.match(
      (await errorOf("SELECT * FROM public.rag_reembed_rollback_run($1, 'test')", [second.run_id])) ?? 'no error',
      /^reembed_refused: binding_active/,
    );
  });

  test('resume after a kill continues from the cursor without touching the profile status and finishes with nothing missing', async () => {
    await binding('contract_legal', null, LAW, 'backfilling');
    const run = await startRun(LAW, null);
    const partial = await fill(String(run.run_id), 2, 1);
    assert.equal(partial.length, 2);
    const cursor = (await query('SELECT cursor_chunk_id FROM public.embedding_backfill_runs WHERE id = $1', [run.run_id]))[0]?.cursor_chunk_id;
    assert.equal(cursor, partial[1]);

    const resumed = (await query("SELECT * FROM public.rag_reembed_resume_run($1, 'test')", [run.run_id]))[0] as Row;
    assert.equal(resumed.profile_status, 'available');
    const rest = (await query('SELECT id FROM public.rag_reembed_next_batch($1, $2, 1000)', [run.run_id, cursor])).map((row) => String(row.id));
    assert.ok(rest.every((id) => id > String(cursor)), 'the pass continues after the cursor');
    await fill(String(run.run_id));
    assert.equal(Number((await query('SELECT * FROM public.rag_reembed_remaining($1)', [run.run_id]))[0]?.chunks_missing), 0);
    assert.equal(await profileStatus(LAW), 'available');

    await db.query('DELETE FROM public.embedding_profile_bindings');
    await db.query("UPDATE public.embedding_backfill_runs SET status = 'failed' WHERE id = $1", [run.run_id]);
    assert.match(
      (await errorOf("SELECT * FROM public.rag_reembed_resume_run($1, 'test')", [run.run_id])) ?? 'no error',
      /^reembed_refused: no_backfilling_binding/,
      'a resume needs the binding as well',
    );
  });

  test('derive is refused for a scoped profile', async () => {
    await binding('contract_legal', null, LAW, 'backfilling');
    assert.match((await startError(LAW, null, QWEN_2048)) ?? 'no error', /^reembed_refused: derive_unsupported/);
  });

  test('unscoped start and rollback keep the Phase 3 status changes', async () => {
    const run = await startRun(UNSCOPED, tenantA);
    assert.equal(await profileStatus(UNSCOPED), 'backfilling');
    await db.query("UPDATE public.embedding_backfill_runs SET status = 'failed', updated_at = now() - interval '1 hour' WHERE id = $1", [run.run_id]);
    const rolled = (await query("SELECT * FROM public.rag_reembed_rollback_run($1, 'test')", [run.run_id]))[0] as Row;
    assert.equal(rolled.profile_status, 'available');
    assert.equal(await profileStatus(LEGACY), 'active');
  });

  test('the replaced functions keep the empty search_path, their SECURITY mode and service-role-only execute', async () => {
    const rows = await query(
      `SELECT p.oid::regprocedure::text AS signature, p.prosecdef AS definer, p.proconfig::text AS config,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
         FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rag_reembed_%' ORDER BY 1`,
    );
    assert.ok(rows.length >= 13);
    for (const row of rows) {
      assert.equal(row.definer, true, `${String(row.signature)} stays SECURITY DEFINER`);
      assert.equal(row.config, '{"search_path=\\"\\""}', `${String(row.signature)} keeps the empty search_path`);
      assert.equal(row.anon_exec, false);
      assert.equal(row.auth_exec, false);
      assert.equal(row.service_exec, true);
    }
  });
});
