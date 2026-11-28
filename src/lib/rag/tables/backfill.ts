import {
  dryRunLookupBackfill,
  runLookupBackfill,
  type LookupBackfillDryRunReport,
  type LookupBackfillInput,
  type LookupBackfillReport,
} from '../ingest/lookup-backfill';

export type TableRowsBackfillInput = Omit<LookupBackfillInput, 'loadPatterns'>;

/**
 * D-15 backfill (npm run rag:table-rows): rewrites rag_table_rows of every chunking profile for the tenant's ready, non-provisional
 * documents that are current or superseded, through indexDocumentForLookup. Replacing per document and profile makes a second run
 * leave the same rows.
 */
export function backfillTableRows(input: TableRowsBackfillInput): Promise<LookupBackfillReport> {
  return runLookupBackfill('tables', input);
}

/** Counts the documents backfillTableRows would index; writes nothing. */
export function dryRunTableRows(input: Omit<TableRowsBackfillInput, 'onBatch'>): Promise<LookupBackfillDryRunReport> {
  return dryRunLookupBackfill('tables', input);
}
