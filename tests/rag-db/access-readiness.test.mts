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

    // Optional functions present on trunk that do not filter yet: rag_cache_check (plan 04.3-12, 0931) and 1008's attribute resolver
    // (rag_attribute_filter_values, rag_attribute_documents; 1008 runs after 0933, so a later file must redefine them). Until each takes
    // the access parameters it is an expected finding, and the complete-catalog case removes it (an absent optional function is not checked).
    const PENDING = ['rag_attribute_documents', 'rag_attribute_filter_values', 'rag_cache_check'];

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

    test('the migrated catalog names only the pending functions that do not filter yet', async () => {
      const answer = await readiness();
      const pending = await unfilteredPending();
      assert.deepEqual(pending.filter((name) => !PENDING.includes(name)), []);
      assert.equal(answer.ready, pending.length === 0);
      assert.deepEqual(
        pairs(answer).sort(),
        pending.flatMap((name) => [`function_missing_access_parameters:${name}`, `function_missing_guard:${name}`]).sort(),
      );
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
