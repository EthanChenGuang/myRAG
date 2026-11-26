import {
  dryRunLookupBackfill,
  runLookupBackfill,
  type LookupBackfillDryRunReport,
  type LookupBackfillInput,
  type LookupBackfillReport,
} from '../ingest/lookup-backfill';

export type IdentifiersBackfillInput = LookupBackfillInput;

/**
 * D-28 backfill (npm run rag:identifiers): writes chunk and document identifiers (built-in rule plus the tenant's patterns) for the
 * tenant's ready, non-provisional, current or superseded documents that still have a chunk without identifiers, through
 * indexDocumentForLookup. An indexed chunk holds an array (empty means none), so a second run finds nothing to do.
 */
export function backfillIdentifiers(input: IdentifiersBackfillInput): Promise<LookupBackfillReport> {
  return runLookupBackfill('identifiers', input);
}

/** Counts the documents backfillIdentifiers would index; writes nothing. */
export function dryRunIdentifiers(input: Omit<IdentifiersBackfillInput, 'onBatch' | 'loadPatterns'>): Promise<LookupBackfillDryRunReport> {
  return dryRunLookupBackfill('identifiers', input);
}
