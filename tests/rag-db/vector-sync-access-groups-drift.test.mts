import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

/**
 * Phase 7 IW-2: 0742 adds access_groups to the vector sync reads (0705) and to the compared columns of the 0702 UPDATE triggers. The setup
 * files fold 0701-0707 without it, so re-running 0702, 0705 or a setup file silently drops it and relabels stop reaching external stores.
 * vectorSyncAccessGroupsDrift names every object that lost the 0742 effect; it must read empty after a full apply and after re-running 0742.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = path.join(REPO_ROOT, 'supabase/migrations');
const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const SETUP: Record<DeploymentMode, string> = {
  'single-tenant': path.join(REPO_ROOT, 'supabase/single-tenant-setup.sql'),
  'multi-tenant': path.join(REPO_ROOT, 'supabase/multi-tenant-setup.sql'),
};
const TRIGGER_FUNCTIONS = ['rag_vector_sync_chunks_update', 'rag_vector_sync_documents_update'];
const READ_FUNCTIONS = ['rag_vector_sync_chunk_row', 'rag_vector_sync_document_rows'];

async function vectorSyncAccessGroupsDrift(db: PGlite): Promise<string[]> {
  const rows = await db.query<{ name: string; issue: string }>(
    `WITH expected(name, kind) AS (
       SELECT unnest($1::text[]), 'trigger' UNION ALL SELECT unnest($2::text[]), 'read'
       UNION ALL SELECT 'rag_validate_chunks_for_groups', 'validate'
     )
     SELECT e.name,
            CASE
              WHEN p.oid IS NULL THEN 'missing'
              WHEN e.kind = 'trigger' AND pg_catalog.strpos(p.prosrc, 'o.access_groups') = 0 THEN 'trigger_ignores_access_groups'
              WHEN e.kind = 'read' AND NOT ('access_groups' = ANY (coalesce(p.proargnames, '{}'::text[]))) THEN 'read_omits_access_groups'
            END AS issue
       FROM expected e
       LEFT JOIN pg_catalog.pg_proc p ON p.proname = e.name AND p.pronamespace = 'public'::regnamespace
      ORDER BY e.name`,
    [TRIGGER_FUNCTIONS, READ_FUNCTIONS],
  );
  return rows.rows.filter((row) => row.issue !== null).map((row) => `${row.name}: ${row.issue}`);
}

function migration(prefix: string): string {
  const name = fs.readdirSync(MIGRATIONS).find((file) => file.startsWith(`${prefix}_`) && file.endsWith('.sql') && file.split('.').length === 2);
  assert.ok(name, `migration ${prefix} not found`);
  return fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
}

for (const mode of MODES) {
  describe(`0742 vector sync access_groups drift (${mode})`, () => {
    let db: PGlite;

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode })).db;
    });

    after(async () => {
      await db?.close();
    });

    test('a full apply carries the 0742 effect', async () => {
      assert.deepEqual(await vectorSyncAccessGroupsDrift(db), []);
    });

    test('re-running 0702 is detected on both trigger functions, and re-running 0742 clears it', async () => {
      await db.exec(migration('0702'));
      assert.deepEqual(await vectorSyncAccessGroupsDrift(db), TRIGGER_FUNCTIONS.map((name) => `${name}: trigger_ignores_access_groups`));
      await db.exec(migration('0742'));
      assert.deepEqual(await vectorSyncAccessGroupsDrift(db), []);
    });

    test('re-running 0705 is detected on both read functions, and re-running 0742 clears it', async () => {
      await db.exec(migration('0705'));
      assert.deepEqual(await vectorSyncAccessGroupsDrift(db), READ_FUNCTIONS.map((name) => `${name}: read_omits_access_groups`));
      await db.exec(migration('0742'));
      assert.deepEqual(await vectorSyncAccessGroupsDrift(db), []);
    });

    test('a database built from the setup file alone lacks the 0742 effect', async () => {
      const bare = (await createEmptyFixtureDatabase({ deploymentMode: mode, migrations: false, setupSqlPath: path.relative(REPO_ROOT, SETUP[mode]) })).db;
      try {
        const drift = await vectorSyncAccessGroupsDrift(bare);
        assert.ok(drift.length > 0, 'the setup file folds 0701-0707 without 0742 (once 0742 is folded, this test expects drift [] instead)');
        assert.ok(drift.includes('rag_vector_sync_documents_update: trigger_ignores_access_groups'), drift.join('\n'));
      } finally {
        await bare.close();
      }
    });
  });
}
