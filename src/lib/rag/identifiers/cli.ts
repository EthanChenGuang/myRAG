import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { consoleIo, runLookupBackfillCli, type CliIo, type LookupBackfillCliSpec } from '../ingest/lookup-backfill-cli';

export type { CliIo };

/** UI-SPEC section 12 constant `{identifiers}`; the Config UI prints this exact string. */
export const IDENTIFIERS_COMMAND = 'npm run rag:identifiers -- --tenant <key>';

export const USAGE = 'usage: npm run rag:identifiers -- [--tenant <key>] [--dry-run] [--batch-size 100] [--resume-after <documentId>]';

export const RUN_AFTER =
  'run it after npm run rag:rechunk and after identifier pattern changes; without --tenant it covers every tenant';

/**
 * From plan 04.2-03 (recorded in 04.2-18): the semantic-cache trigger on documents compares only is_current, status, version and
 * tenant_key, so writing documents.identifiers_* deletes no cache entry.
 */
export const CACHE_EFFECT =
  'semantic cache: unaffected; writing document identifiers deletes no cached answer (the cache trigger compares only is_current, status, version and tenant_key)';

const PREFIX = '[RAG Identifiers]';

const SPEC: LookupBackfillCliSpec = {
  kind: 'identifiers',
  prefix: PREFIX,
  usage: USAGE,
  runAfter: RUN_AFTER,
  dryRunHeader: 'dry run, nothing written',
  notes: async () => {
    const [{ loadRagConfig }, { getRagDeps }] = await Promise.all([import('../config'), import('../deps')]);
    const on = loadRagConfig(getRagDeps().ragEnv()).v2.identifierIndex;
    return [
      `RAG_IDENTIFIER_INDEX=${on ? 'true' : 'false'}: the backfill runs either way; ingestion writes identifiers and retrieval reads them only while it is true`,
      CACHE_EFFECT,
    ];
  },
  dryRunLine: (tenantKey, counts) =>
    `${tenantKey}: would index ${counts.documents} documents (${counts.current} current, ${counts.superseded} superseded)`,
  tenantLine: (report) =>
    `${report.tenantKey}: ${report.documents} documents indexed, ${report.failed} failed, ${report.chunksIndexed} chunks read, ${report.chunksWritten} chunks updated, ${report.documentsChanged} document unions changed, in ${report.batches} batches`,
};

/** CLI entry for npm run rag:identifiers (D-28). Exit codes: 0 done, 1 database or indexing failure, 2 bad arguments, 130 interrupted. */
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
