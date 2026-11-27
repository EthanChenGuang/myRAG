import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { createFixtureDatabase, type DeploymentMode } from '../../eval/harness/pglite-supabase.mts';

// Phase 4.3 plan 11 (SEC-12; D-10, A-03, A-11): rag_access_readiness() (0933) answers from the catalog whether every retrieval function can
// filter by access group. Each change below runs in a transaction that is rolled back, so the cases do not see each other.

const MODES: DeploymentMode[] = ['single-tenant', 'multi-tenant'];

interface Readiness {
  ready: boolean;
  reasons: string[];
  objects: string[];
}

function pairs(answer: Readiness): string[] {
  return answer.reasons.map((reason, i) => `${reason}:${answer.objects[i]}`);
}

for (const mode of MODES) {
  describe(`rag_access_readiness (${mode})`, () => {
    let db: PGlite;
    let corpusDir: string;

    async function readiness(): Promise<Readiness> {
      await db.exec('SET ROLE service_role');
      try {
        return (await db.query<Readiness>('SELECT ready, reasons, objects FROM public.rag_access_readiness()')).rows[0]!;
      } finally {
        await db.exec('RESET ROLE');
      }
    }

    async function inRollback<T>(change: string, run: () => Promise<T>): Promise<T> {
      await db.exec('BEGIN');
      try {
        await db.exec(change);
        return await run();
      } finally {
        await db.exec('ROLLBACK');
      }
    }

    // Optional functions that once did not filter: rag_cache_check (0931 now filters) and 1008's attribute resolver (1010 redefines it with
    // the access parameters). None is expected any more; a name that reappears here without the access parameters fails the first case.
    const PENDING = ['rag_attribute_documents', 'rag_attribute_filter_values', 'rag_cache_check', 'rag_tenant_doc_types'];

    async function unfilteredPending(): Promise<string[]> {
      const result = await db.query<{ name: string }>(
        `SELECT DISTINCT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = ANY ($1::text[]) AND NOT ('p_access_keys' = ANY (COALESCE(p.proargnames, '{}'::text[])))
         ORDER BY 1`,
        [PENDING],
      );
      return result.rows.map((row) => row.name);
    }

    const completeCatalog = async (): Promise<string> => {
      const names = await unfilteredPending();
      return names.length === 0 ? 'SELECT 1' : names.map((name) => `DROP FUNCTION public.${name}`).join('; ');
    };

    before(async () => {
      corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-readiness-corpus-'));
      db = (await createFixtureDatabase({ deploymentMode: mode, corpusDir, supabaseGrants: true })).db;
    });

    after(async () => {
      await db?.close();
      if (corpusDir) fs.rmSync(corpusDir, { recursive: true, force: true });
    });

    test('the migrated catalog is ready: every optional function, the 1008 attribute resolver included, filters', async () => {
      assert.deepEqual(await unfilteredPending(), []);
      assert.deepEqual(await readiness(), { ready: true, reasons: [], objects: [] });
    });

    test('the 1008 signatures without the access parameters are named by readiness (re-run of 1008 without 1010)', async () => {
      const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/1008_attribute_resolver.sql'), 'utf8');
      const answer = await inRollback(migration.replace(/^\s*(BEGIN|COMMIT);\s*$/gm, ''), readiness);
      assert.equal(answer.ready, false);
      assert.deepEqual(pairs(answer).sort(), [
        'function_missing_access_parameters:rag_attribute_documents',
        'function_missing_access_parameters:rag_attribute_filter_values',
        'function_missing_guard:rag_attribute_documents',
        'function_missing_guard:rag_attribute_filter_values',
        'function_overloaded:rag_attribute_documents',
        'function_overloaded:rag_attribute_filter_values',
      ]);
    });

    test('the 0981 doc-type signature without the access parameters is named by readiness (re-run of 0981 without 0986)', async () => {
      const migration = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/0981_tenant_doc_types.sql'), 'utf8');
      const answer = await inRollback(migration.replace(/^\s*(BEGIN|COMMIT);\s*$/gm, ''), readiness);
      assert.equal(answer.ready, false);
      assert.deepEqual(pairs(answer).sort(), [
        'function_missing_access_parameters:rag_tenant_doc_types',
        'function_missing_guard:rag_tenant_doc_types',
        'function_overloaded:rag_tenant_doc_types',
      ]);
    });

    test('a complete catalog is ready with no reasons', async () => {
      const answer = await inRollback(await completeCatalog(), readiness);
      assert.deepEqual(answer, { ready: true, reasons: [], objects: [] });
    });

    test('an extra rag_fetch_parents overload without the access parameters is function_overloaded', async () => {
      const answer = await inRollback(
        `${await completeCatalog()};
         CREATE FUNCTION public.rag_fetch_parents(p_tenant_key text, p_parent_ids uuid[])
         RETURNS SETOF public.document_parents LANGUAGE sql STABLE SET search_path = ''
         AS 'SELECT * FROM public.document_parents p WHERE p.tenant_key = p_tenant_key AND p.id = ANY (p_parent_ids)'`,
        readiness,
      );
      assert.equal(answer.ready, false);
      assert.deepEqual(pairs(answer).sort(), [
        'function_missing_access_parameters:rag_fetch_parents',
        'function_missing_guard:rag_fetch_parents',
        'function_overloaded:rag_fetch_parents',
      ]);
    });

    test('a derived table without access_groups is table_missing_column', async () => {
      const answer = await inRollback(`${await completeCatalog()}; ALTER TABLE public.rag_table_rows DROP COLUMN access_groups CASCADE`, readiness);
      assert.equal(answer.ready, false);
      assert.deepEqual(pairs(answer), ['table_missing_column:rag_table_rows']);
    });

    test('an absent required function is function_missing; an absent optional one is not checked', async () => {
      const answer = await inRollback(
        `${await completeCatalog()}; DROP FUNCTION public.rag_find_invoices; DROP FUNCTION public.rag_dup_cluster_sources`,
        readiness,
      );
      assert.deepEqual(pairs(answer), ['function_missing:rag_find_invoices']);
    });

    test(`the legacy search RPC of the mode is required (${mode === 'multi-tenant' ? 'match_documents_by_workspace' : 'match_document_chunks'})`, async () => {
      const legacy = mode === 'multi-tenant' ? 'match_documents_by_workspace' : 'match_document_chunks';
      const answer = await inRollback(`${await completeCatalog()}; DROP FUNCTION public.${legacy}`, readiness);
      assert.deepEqual(pairs(answer), [`function_missing:${legacy}`]);
    });

    test('a redefinition that keeps the parameters but loses the guard is function_missing_guard', async () => {
      const answer = await inRollback(
        `${await completeCatalog()};
         CREATE OR REPLACE FUNCTION public.rag_identifier_resolve(p_tenant_key text, p_norm text[], p_access_keys text[] DEFAULT NULL, p_access_all boolean DEFAULT false)
         RETURNS TABLE (norm text, raw text) LANGUAGE sql STABLE SET search_path = '' AS 'SELECT NULL::text, NULL::text WHERE false'`,
        readiness,
      );
      assert.deepEqual(pairs(answer), ['function_missing_guard:rag_identifier_resolve']);
    });

    test('readiness is service_role only', async () => {
      for (const role of ['anon', 'authenticated']) {
        const allowed = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('${role}', 'public.rag_access_readiness()', 'EXECUTE') AS ok`);
        assert.equal(allowed.rows[0]!.ok, false, role);
      }
      const service = await db.query<{ ok: boolean }>(`SELECT has_function_privilege('service_role', 'public.rag_access_readiness()', 'EXECUTE') AS ok`);
      assert.equal(service.rows[0]!.ok, true);
    });
  });
}
