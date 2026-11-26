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
  const { prefix } = spec;
  const parsed = parseLookupBackfillArgs(argv);
  if (!parsed.ok) {
    io.err(`${prefix} ${parsed.error}`);
    io.err(spec.usage);
    io.err(spec.runAfter);
    return 2;
  }
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    io.err(`${prefix} refused: set SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }

  const backfill = await import('./lookup-backfill');
  const { backfillScope } = await import('../tenant/backfill-scope');
  const { getIngestDeps } = await import('./deps');
  const { getRagDeps } = await import('../deps');
  const { isMultiTenant } = await import('@/lib/deployment-mode');
  const db = getIngestDeps().db();
  if (!db) {
    io.err(`${prefix} admin client unavailable: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY`);
    return 1;
  }
  const runSignal = signal ?? new AbortController().signal;
  let current: { tenantKey: string; cursor: string | null } | null = null;

  try {
    const tenantKeys =
      parsed.tenantKey !== null
        ? [parsed.tenantKey]
        : await backfill.listBackfillTenants({
            multiTenant: isMultiTenant(),
            admin: getRagDeps().adminClient() as unknown as import('./lookup-backfill').TenantListingAdmin | null,
            signal: runSignal,
          });

    if (parsed.dryRun) io.out(`${prefix} ${spec.dryRunHeader}`);
    else {
      io.out(
        `${prefix} started: ${parsed.tenantKey ? `tenant ${parsed.tenantKey}` : `${tenantKeys.length} tenants`}, batch size ${parsed.batchSize}${parsed.resumeAfter ? `, resume after ${parsed.resumeAfter}` : ''}`,
      );
      for (const line of await spec.notes()) io.out(`${prefix} ${line}`);
      io.out(`${prefix} ${spec.runAfter}`);
    }

    let failed = 0;
    let total = 0;
    for (const tenantKey of tenantKeys) {
      const resolved = await backfillScope(tenantKey, { signal: runSignal });
      if (!resolved.ok) {
        io.err(`${prefix} ${tenantKey}: tenant refused (${resolved.reason})`);
        if (parsed.tenantKey !== null) return resolved.reason === 'unavailable' ? 1 : 2;
        failed += 1;
        continue;
      }
      const input = {
        db,
        scope: resolved.scope,
        batchSize: parsed.batchSize,
        resumeAfter: parsed.tenantKey !== null ? parsed.resumeAfter : null,
        signal: runSignal,
      };
      if (parsed.dryRun) {
        const counts = await backfill.dryRunLookupBackfill(spec.kind, input);
        io.out(`${prefix} ${spec.dryRunLine(tenantKey, counts)}`);
        total += counts.documents;
        continue;
      }
      current = { tenantKey, cursor: input.resumeAfter };
      const report = await backfill.runLookupBackfill(spec.kind, {
        ...input,
        onBatch: (info) => {
          if (current) current.cursor = info.cursor;
          io.out(`${prefix} ${info.tenantKey} batch ${info.batch}: indexed ${info.documents}, failed ${info.failed}, cursor ${info.cursor}`);
        },
      });
      current = null;
      io.out(`${prefix} ${spec.tenantLine(report)}`);
      total += report.documents;
      failed += report.failed;
    }
    if (parsed.dryRun) {
      io.out(`${prefix} total: would index ${total} documents`);
      return failed > 0 ? 1 : 0;
    }
    io.out(`${prefix} done: ${total} documents indexed${failed > 0 ? `, ${failed} failed; run it again to retry them` : ''}`);
    return failed > 0 ? 1 : 0;
  } catch (error) {
    if (runSignal.aborted) {
      const resume = current?.cursor ? `; continue with --tenant ${current.tenantKey} --resume-after ${current.cursor}` : '; nothing finished for this tenant, run it again';
      io.err(`${prefix} interrupted between batches${current ? ` (tenant ${current.tenantKey})` : ''}${resume}`);
      return EXIT_INTERRUPTED;
    }
    if (error instanceof backfill.LookupBackfillError) {
      io.err(`${prefix} ${error.code}${error.rpcCode ? ` (${error.rpcCode})` : ''}`);
      return error.code.startsWith('invalid_') ? 2 : 1;
    }
    throw error;
  }
}
