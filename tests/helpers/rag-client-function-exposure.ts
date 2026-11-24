import assert from 'node:assert/strict';
import type { PGlite } from '@electric-sql/pglite';
import { allowListEntryFor } from './security-definer-allow-list';

/** rag_* and match_chunks_by_profile callable by anon or authenticated outside the SECURITY DEFINER allow-list. */
export async function unexpectedClientExposedRagFunctions(db: PGlite): Promise<Array<{ signature: string }>> {
  const exposed = await db.query<{ signature: string }>(
    `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'rag\\_%' OR p.proname = 'match_chunks_by_profile')
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
  );
  return exposed.rows.filter((row) => allowListEntryFor(row.signature) === undefined);
}

export async function assertNoUnexpectedClientRagFunctions(db: PGlite, message?: string): Promise<void> {
  const unexpected = await unexpectedClientExposedRagFunctions(db);
  assert.deepEqual(unexpected, [], message ?? 'rag_* and match_chunks_by_profile must not be executable by clients except the allow-list');
}