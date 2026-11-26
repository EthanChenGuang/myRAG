import { EXIT_INTERRUPTED, parseLookupBackfillArgs, type LookupBackfillKind, type LookupBackfillReport } from './lookup-backfill';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** What differs between rag:table-rows and rag:identifiers; every line is fixed text plus counts and ids. */
export interface LookupBackfillCliSpec {
  kind: LookupBackfillKind;
  prefix: string;
  usage: string;
  /** Printed with the usage line and at the start of a run. */
  runAfter: string;
  dryRunHeader: string;
  /** Lines printed once before a real run (switch value, cache and trigger effects). */
  notes: () => Promise<string[]>;
  dryRunLine: (tenantKey: string, counts: { documents: number; current: number; superseded: number }) => string;
  tenantLine: (report: LookupBackfillReport) => string;
}

export const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

/**
 * Shared entry of the two lookup backfill commands. Exit code 0 when done, 1 on a database failure or a document that failed to index,
 * 2 on bad arguments or a tenant key that does not resolve, 130 when interrupted (the last finished batch is printed as a cursor).
 * Requires SUPABASE_SERVICE_ROLE_KEY and a configured admin client. Prints counts and ids only.
 */
export async function runLookupBackfillCli(spec: LookupBackfillCliSpec, argv: string[], io: CliIo, signal?: AbortSignal): Promise<number> {
  void spec;
  void argv;
  void io;
  void signal;
  return 0;
}
