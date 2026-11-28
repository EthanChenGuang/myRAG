import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { consoleIo, runLookupBackfillCli, type CliIo, type LookupBackfillCliSpec } from '../ingest/lookup-backfill-cli';

export type { CliIo };

/** UI-SPEC section 12 constant `{tableRows}`; the Config UI prints this exact string. */
export const TABLE_ROWS_COMMAND = 'npm run rag:table-rows -- --tenant <key>';

export const USAGE = 'usage: npm run rag:table-rows -- [--tenant <key>] [--dry-run] [--batch-size 100] [--resume-after <documentId>]';

export const RUN_AFTER =
  'run it after npm run rag:rechunk and after identifier pattern changes; without --tenant it covers every tenant';

const PREFIX = '[RAG Tables]';

const SPEC: LookupBackfillCliSpec = {
  kind: 'tables',
  prefix: PREFIX,
  usage: USAGE,
  runAfter: RUN_AFTER,
  dryRunHeader: 'dry run, nothing written',
  notes: async () => {
    const [{ loadRagConfig }, { getRagDeps }] = await Promise.all([import('../config'), import('../deps')]);
    const on = loadRagConfig(getRagDeps().ragEnv()).v2.tableLookup;
    return [
      `RAG_TABLE_LOOKUP=${on ? 'true' : 'false'}: the backfill runs either way; ingestion writes table rows and retrieval reads them only while it is true`,
      'note: each document and chunking profile has its rows replaced; documents and chunks are not written, so the semantic cache is not flushed',
    ];
  },
  dryRunLine: (tenantKey, counts) =>
    `${tenantKey}: would index ${counts.documents} documents (${counts.current} current, ${counts.superseded} superseded)`,
  tenantLine: (report) =>
    `${report.tenantKey}: ${report.documents} documents indexed, ${report.failed} failed, ${report.rowsWritten} rows written, ${report.rowsDeleted} rows replaced, in ${report.batches} batches`,
};

/** CLI entry for npm run rag:table-rows (D-15). Exit codes: 0 done, 1 database or indexing failure, 2 bad arguments, 130 interrupted. */
export function main(argv: string[] = process.argv.slice(2), io: CliIo = consoleIo, signal?: AbortSignal): Promise<number> {
  return runLookupBackfillCli(SPEC, argv, io, signal);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotenv({ path: '.env.local', quiet: true });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('interrupted')));
  main(process.argv.slice(2), consoleIo, controller.signal).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`${PREFIX} failed`, error instanceof Error ? { error: error.name, message: error.message.slice(0, 200) } : { error: 'unknown' });
      process.exit(1);
    },
  );
}
