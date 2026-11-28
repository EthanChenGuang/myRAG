import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createEmptyFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';
import { applyMigrationFiles } from '../../eval/harness/migrations.mts';

// Phase 4.3 plan 53 task 1 (G8 of 04.3-VERIFICATION.md, corrected by quick-43): the access-group block, in the operator's apply order,
// applies on top of trunk twice in a row without an error in both modes, and leaves rag_access_readiness() ready, one overload per
// retrieval function and no client EXECUTE on any of them. 0410 is re-run last.

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];
const DIR = 'supabase/migrations';

interface Step {
  stem: string;
  // Set for a file that is not on this branch yet: the step is skipped while the file is absent and applies once the branch is merged.
  pendingFrom?: string;
}

const APPLY_ORDER: Step[] = [
  { stem: '0920_access_groups_tables' },
  { stem: '0921_access_groups_columns' },
  { stem: '0922_access_resolution' },
  { stem: '0923_access_labels_and_resolution' },
  { stem: '0924_access_admin' },
  { stem: '0925_access_connectors' },
  { stem: '0926_access_rls' },
  { stem: '0930_access_retrieval_functions' },
  { stem: '0931_access_derived_stores' },
  { stem: '0932_access_bm25_search' },
  { stem: '0933_access_seam_legs' },
  { stem: '0934_access_derived_stores_sets' },
  { stem: '0984_review_items_access_sets' },
  { stem: '1010_attribute_resolver_access' },
  // From origin/ci/merge-train-40 (quick-doc-types-access).
  { stem: '0986_tenant_doc_types_access', pendingFrom: 'origin/ci/merge-train-40' },
  // From origin/exec/quick-scope-access.
  { stem: '0987_scope_centroids_access', pendingFrom: 'origin/exec/quick-scope-access' },
  // From origin/ci/merge-train-40 (quick-review-writers-access, renamed from 0986).
  { stem: '0988_review_items_writers_access_sets', pendingFrom: 'origin/ci/merge-train-40' },
  // From origin/fix/nf1-shared-chats-rls (NF-1, with mode files).
  { stem: '0989_chats_shared_rls', pendingFrom: 'origin/fix/nf1-shared-chats-rls' },
  // From origin/exec/quick-review-items-hardening.
  { stem: '0990_review_items_hardening', pendingFrom: 'origin/exec/quick-review-items-hardening' },
];
const RERUN_LAST = '0410_security_definer_rpc_grants';

function filesOf(stem: string, mode: DeploymentMode): string[] {
  return [`${stem}.sql`, `${stem}.${mode}.sql`].filter((name) => fs.existsSync(path.join(process.cwd(), DIR, name))).map((name) => `${DIR}/${name}`);
}

function blockFiles(mode: DeploymentMode): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  for (const step of APPLY_ORDER) {
    const found = filesOf(step.stem, mode);
    if (found.length === 0) {
      if (step.pendingFrom === undefined) throw new Error(`[Access Apply] required migration missing: ${step.stem}`);
      skipped.push(`${step.stem} (${step.pendingFrom})`);
      continue;
    }
    files.push(...found);
  }
  return { files, skipped };
}

const REQUIRED = ['hybrid_search_chunks', 'rag_fetch_parents', 'rag_exact_id_documents', 'match_chunks_by_profile', 'rag_find_invoices'];
const OPTIONAL = [
  'hybrid_search_translations',
  'rag_cache_check',
  'rag_table_lookup',
  'rag_identifier_resolve',
  'rag_identifier_candidates',
  'rag_dup_cluster_sources',
  'rag_bm25_search_chunks',
  'rag_attribute_filter_values',
  'rag_attribute_documents',
];

for (const mode of MODES) {
  describe(`access migrations apply in order (${mode})`, () => {
    let db: PGlite;
    const { files, skipped } = blockFiles(mode);
    const legacy = mode === 'multi-tenant' ? 'match_documents_by_workspace' : 'match_document_chunks';

    before(async () => {
      db = (await createEmptyFixtureDatabase({ deploymentMode: mode, supabaseGrants: true, supabaseFunctionDefaults: true })).db;
      if (skipped.length > 0) console.log(`[Access Apply] ${mode}: skipped until merged: ${skipped.join(', ')}`);
    });

    after(async () => {
      await db?.close();
    });

    test('every required file of the block is present and each mode file follows its common file', () => {
      assert.ok(files.some((f) => f.endsWith(`0920_access_groups_tables.${mode}.sql`)));
      assert.ok(files.some((f) => f.endsWith(`0926_access_rls.${mode}.sql`)));
      assert.ok(files.some((f) => f.endsWith(`0930_access_retrieval_functions.${mode}.sql`)));
      for (const stem of ['0920_access_groups_tables', '0926_access_rls', '0930_access_retrieval_functions']) {
        assert.ok(files.indexOf(`${DIR}/${stem}.sql`) < files.indexOf(`${DIR}/${stem}.${mode}.sql`), stem);
      }
      assert.ok(files.some((f) => f.includes('0931_access_derived_stores.sql')));
      assert.equal(filesOf(RERUN_LAST, mode).length, 1);
    });

    test('the block applies twice in a row without an error, then 0410 re-runs', async () => {
      await applyMigrationFiles(db, files);
      await applyMigrationFiles(db, files);
      await applyMigrationFiles(db, filesOf(RERUN_LAST, mode));
    });

    test('rag_access_readiness() reports ready', async () => {
      await db.exec('SET ROLE service_role');
      try {
        const answer = (await db.query<{ ready: boolean; reasons: string[]; objects: string[] }>('SELECT ready, reasons, objects FROM public.rag_access_readiness()')).rows[0]!;
        assert.deepEqual(answer, { ready: true, reasons: [], objects: [] });
      } finally {
        await db.exec('RESET ROLE');
      }
    });

    test('each retrieval function has exactly one overload and no client EXECUTE', async () => {
      const names = [...REQUIRED, legacy, ...OPTIONAL];
      const result = await db.query<{ name: string; overloads: number; anon: boolean; authenticated: boolean; service: boolean }>(
        `SELECT p.proname AS name, count(*) OVER (PARTITION BY p.proname)::int AS overloads,
                has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
                has_function_privilege('service_role', p.oid, 'EXECUTE') AS service
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY ($1::text[])`,
        [names],
      );
      const present = new Set(result.rows.map((row) => row.name));
      for (const name of [...REQUIRED, legacy]) assert.ok(present.has(name), `missing ${name}`);
      for (const row of result.rows) {
        assert.equal(row.overloads, 1, `${row.name} overloads`);
        assert.equal(row.anon, false, `${row.name} anon`);
        assert.equal(row.authenticated, false, `${row.name} authenticated`);
        assert.equal(row.service, true, `${row.name} service_role`);
      }
    });
  });
}
