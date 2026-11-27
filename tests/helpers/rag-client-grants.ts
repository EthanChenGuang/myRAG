import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { allowListEntryFor } from './security-definer-allow-list';

/**
 * rag_* / match_chunks_by_profile and every function taking p_access_keys (0930: the legacy search RPCs match_document_chunks and
 * match_documents_by_workspace among them) callable by anon or authenticated, excluding the authenticated allow-list.
 */
export async function assertNoClientCallableRagFunctions(db: PGlite, message?: string): Promise<void> {
  const exposed = await db.query<{ signature: string; proname: string }>(
    `SELECT p.oid::regprocedure::text AS signature, p.proname
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'rag\\_%' OR p.proname = 'match_chunks_by_profile' OR 'p_access_keys' = ANY(COALESCE(p.proargnames, ARRAY[]::text[])))
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
  );
  const violations = exposed.rows.filter((row) => allowListEntryFor(row.signature) === undefined);
  assert.deepEqual(
    violations.map((row) => ({ proname: row.proname })),
    [],
    message ?? 'rag_*, match_chunks_by_profile and the access-filtered search RPCs must not be executable by anon or authenticated',
  );
}