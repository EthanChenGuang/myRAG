export type ParsedDupClusterArgs =
  | { ok: true; dryRun: boolean; tenantKey: string; batchSize: number; resumeAfter: string | null }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const USAGE = '';
export const DEFAULT_DUP_CLUSTER_BATCH_SIZE = 0;

export function parseDupClusterArgs(_argv: string[]): ParsedDupClusterArgs {
  return { ok: false, error: 'not implemented' };
}

export async function main(_argv: string[] = process.argv.slice(2), _io?: CliIo, _signal?: AbortSignal): Promise<number> {
  return 1;
}
