import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, FIXTURE_USER_ID, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const MIGRATIONS = ['supabase/migrations/0720_source_sync_columns.sql', 'supabase/migrations/0722_source_delta_tokens.sql'];

const EXPECTED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ['nango_connections', 'deletion_mode', 'text'],
  ['nango_connections', 'last_full_reconcile_at', 'timestamp with time zone'],
  ['nango_connections', 'last_reconcile_status', 'text'],
  ['documents', 'source_last_seen_at', 'timestamp with time zone'],
  ['documents', 'source_modified_at', 'timestamp with time zone'],
  ['documents', 'source_etag', 'text'],
];

async function errorCode(db: PGlite, sql: string, params: unknown[] = []): Promise<string | undefined> {
  try {
    await db.query(sql, params);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

async function catalogSnapshot(db: PGlite): Promise<string> {
  const columns = await db.query<Record<string, unknown>>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('nango_connections', 'documents', 'rag_source_delta_tokens')
      ORDER BY table_name, column_name`,
  );
  const constraints = await db.query<Record<string, unknown>>(
    `SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
      WHERE conrelid IN ('public.nango_connections'::regclass, 'public.documents'::regclass, 'public.rag_source_delta_tokens'::regclass)
      ORDER BY 1, 2`,
  );
  const indexes = await db.query<Record<string, unknown>>(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('nango_connections', 'documents', 'rag_source_delta_tokens')
      ORDER BY 1, 2`,
  );
  const acl = await db.query<Record<string, unknown>>(
    `SELECT relname, relacl::text AS acl, relrowsecurity FROM pg_class
      WHERE oid = 'public.rag_source_delta_tokens'::regclass`,
  );
  return JSON.stringify({ columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, acl: acl.rows });
}

async function insertConnection(db: PGlite, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO public.nango_connections (id, user_id, connection_id, provider, status) VALUES ($1, $2, $3, $4, 'connected')",
    [id, userId, `conn-${id}`, `provider-${id.slice(0, 8)}`],
  );
  return id;
}

async function insertDocument(db: PGlite, mode: DeploymentMode): Promise<string> {
  const id = crypto.randomUUID();
  if (mode === 'multi-tenant') {
    await db.query('INSERT INTO public.documents (id, filename, content, metadata, user_id) VALUES ($1, $2, $3, $4::jsonb, $5::uuid)', [
      id,
      `seen-${id}.txt`,
      'neutral fixture text',
      '{}',
      FIXTURE_USER_ID,
    ]);
  } else {
    await db.query('INSERT INTO public.documents (id, filename, content, metadata) VALUES ($1, $2, $3, $4::jsonb)', [id, `seen-${id}.txt`, 'neutral fixture text', '{}']);
  }
  return id;
}

for (const mode of MODES) {
  describe(`source sync schema (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
      if (mode === 'single-tenant') {
        await db.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [FIXTURE_USER_ID, 'fixture-user@example.invalid']);
      }
    });

    after(async () => {
      await db?.close();
    });

    test('the six source columns exist, nullable, with the stated types', async () => {
      for (const [table, column, type] of EXPECTED_COLUMNS) {
        const row = (
          await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
            `SELECT data_type, is_nullable, column_default FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [table, column],
          )
        ).rows[0];
        assert.ok(row, `${table}.${column} is missing`);
        assert.equal(row.data_type, type, `${table}.${column} type`);
        assert.equal(row.is_nullable, 'YES', `${table}.${column} must be nullable`);
        assert.equal(row.column_default, null, `${table}.${column} has no default (no backfill)`);
      }
    });

    test('deletion_mode accepts NULL, soft and purge and rejects anything else; status is a fixed word list', async () => {
      const id = await insertConnection(db, FIXTURE_USER_ID);
      const nulls = (
        await db.query<{ deletion_mode: string | null; last_reconcile_status: string | null; last_full_reconcile_at: string | null }>(
          'SELECT deletion_mode, last_reconcile_status, last_full_reconcile_at FROM public.nango_connections WHERE id = $1',
          [id],
        )
      ).rows[0];
      assert.deepEqual(nulls, { deletion_mode: null, last_reconcile_status: null, last_full_reconcile_at: null });
      for (const mode of ['soft', 'purge', null]) {
        assert.equal(await errorCode(db, 'UPDATE public.nango_connections SET deletion_mode = $2 WHERE id = $1', [id, mode]), undefined);
      }
      assert.equal(await errorCode(db, "UPDATE public.nango_connections SET deletion_mode = 'hard' WHERE id = $1", [id]), '23514');
      for (const status of ['ok', 'incomplete', 'failed', 'paused', 'overdue']) {
        assert.equal(await errorCode(db, 'UPDATE public.nango_connections SET last_reconcile_status = $2 WHERE id = $1', [id, status]), undefined);
      }
      assert.equal(await errorCode(db, "UPDATE public.nango_connections SET last_reconcile_status = 'done' WHERE id = $1", [id]), '23514');
      const named = (
        await db.query<{ conname: string }>(
          "SELECT conname FROM pg_constraint WHERE conrelid = 'public.nango_connections'::regclass AND contype = 'c' AND conname LIKE 'nango_connections_%' ORDER BY 1",
        )
      ).rows.map((row) => row.conname);
      assert.ok(named.includes('nango_connections_deletion_mode_check'), named.join(','));
      assert.ok(named.includes('nango_connections_last_reconcile_status_check'), named.join(','));
    });

    test('documents.source_etag is capped at 512 characters', async () => {
      const id = await insertDocument(db, mode);
      assert.equal(await errorCode(db, 'UPDATE public.documents SET source_etag = $2 WHERE id = $1', [id, 'e'.repeat(512)]), undefined);
      assert.equal(await errorCode(db, 'UPDATE public.documents SET source_etag = $2 WHERE id = $1', [id, 'e'.repeat(513)]), '23514');
    });

    test('rag_source_delta_tokens: RLS on with no policy; anon and authenticated get 42501, service_role reads and writes', async () => {
      const meta = (
        await db.query<{ rls: boolean; policies: number }>(
          `SELECT c.relrowsecurity AS rls, (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
             FROM pg_class c WHERE c.oid = 'public.rag_source_delta_tokens'::regclass`,
        )
      ).rows[0];
      assert.deepEqual(meta, { rls: true, policies: 0 });

      const connection = await insertConnection(db, FIXTURE_USER_ID);
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        try {
          assert.equal(await errorCode(db, 'SELECT * FROM public.rag_source_delta_tokens'), '42501', `${role} select`);
          assert.equal(
            await errorCode(db, "INSERT INTO public.rag_source_delta_tokens (connection_id, feed, feed_key) VALUES ($1, 'graph_delta', 'drive-x')", [connection]),
            '42501',
            `${role} insert`,
          );
        } finally {
          await db.exec('RESET ROLE');
        }
      }

      await db.exec('SET ROLE service_role');
      try {
        await db.query(
          "INSERT INTO public.rag_source_delta_tokens (connection_id, feed, feed_key, delta_link) VALUES ($1, 'graph_delta', 'drive-1', 'https://graph.example.invalid/delta?token=a')",
          [connection],
        );
        await db.query("INSERT INTO public.rag_source_delta_tokens (connection_id, feed, feed_key, next_link) VALUES ($1, 'nango_records', 'files', 'cursor-1')", [
          connection,
        ]);
        await db.query("UPDATE public.rag_source_delta_tokens SET delta_link = 'https://graph.example.invalid/delta?token=b' WHERE connection_id = $1 AND feed = 'graph_delta'", [
          connection,
        ]);
        const rows = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_source_delta_tokens WHERE connection_id = $1', [connection]);
        assert.equal(rows.rows[0]?.n, 2);
      } finally {
        await db.exec('RESET ROLE');
      }

      assert.equal(
        await errorCode(db, "INSERT INTO public.rag_source_delta_tokens (connection_id, feed, feed_key) VALUES ($1, 'webhook', 'x')", [connection]),
        '23514',
        'feed is a fixed word list',
      );
      assert.equal(
        await errorCode(db, "INSERT INTO public.rag_source_delta_tokens (connection_id, feed, feed_key, delta_link) VALUES ($1, 'graph_delta', 'drive-2', $2)", [
          connection,
          'x'.repeat(4097),
        ]),
        '23514',
        'delta_link has a length cap',
      );
      assert.equal(
        await errorCode(db, "INSERT INTO public.rag_source_delta_tokens (connection_id, feed, feed_key) VALUES ($1, 'graph_delta', 'drive-1')", [connection]),
        '23505',
        'one row per (connection, feed, feed_key)',
      );
    });

    test('deleting a connection removes its delta-token rows', async () => {
      const connection = await insertConnection(db, FIXTURE_USER_ID);
      await db.query("INSERT INTO public.rag_source_delta_tokens (connection_id, feed, feed_key) VALUES ($1, 'graph_delta', 'drive-c')", [connection]);
      await db.query('DELETE FROM public.nango_connections WHERE id = $1', [connection]);
      const left = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_source_delta_tokens WHERE connection_id = $1', [connection]);
      assert.equal(left.rows[0]?.n, 0);
    });

    test('updating only source_last_seen_at leaves the semantic cache and the vector sync outbox untouched', async () => {
      const id = await insertDocument(db, mode);
      const tenant = (await db.query<{ k: string }>('SELECT tenant_key AS k FROM public.documents WHERE id = $1', [id])).rows[0]!.k;
      await db.query('UPDATE public.rag_vector_sync_targets SET enabled = true');
      await db.exec('DELETE FROM public.vector_sync_outbox');
      await db.query(
        `INSERT INTO public.rag_semantic_cache (tenant_key, key_hash, embedding_profile_id, embedding, query_text_masked, answer, source_versions, expires_at)
         VALUES ($1, 'seen-key-' || $2, 'openai-3-small-1536', '[0.1,0.2,0.3]'::halfvec, 'neutral query', '{"text":"cached"}'::jsonb, '[]'::jsonb, now() + interval '1 hour')`,
        [tenant, id],
      );
      const cacheBefore = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE tenant_key = $1', [tenant])).rows[0]!.n;
      await db.query('UPDATE public.documents SET source_last_seen_at = now(), source_modified_at = now(), source_etag = $2 WHERE id = $1', [id, 'etag-1']);
      const cacheAfter = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.rag_semantic_cache WHERE tenant_key = $1', [tenant])).rows[0]!.n;
      const outbox = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM public.vector_sync_outbox')).rows[0]!.n;
      await db.query('UPDATE public.rag_vector_sync_targets SET enabled = false');
      assert.equal(cacheBefore, 1);
      assert.equal(cacheAfter, cacheBefore);
      assert.equal(outbox, 0);
    });

    test('applying 0720 and 0722 a second time succeeds and leaves the catalog unchanged', async () => {
      const before = await catalogSnapshot(db);
      for (const file of MIGRATIONS) await db.exec(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
      assert.equal(await catalogSnapshot(db), before);
    });
  });
}
