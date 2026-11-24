export type ParsedReembedArgs =
  | { ok: true; mode: 'run'; profileId: string; tenantKey: string | null; batchSize: number; deriveFrom: string | null; dryRun: boolean }
  | { ok: true; mode: 'resume'; runId: string; profileId: string | null; tenantKey: string | null; batchSize: number }
  | { ok: true; mode: 'rollback'; runId: string }
  | { ok: false; error: string };

export const DEFAULT_REEMBED_BATCH_SIZE = 128;

export function parseReembedArgs(_argv: string[]): ParsedReembedArgs {
  return { ok: false, error: 'not implemented' };
}

export async function main(_argv: string[] = process.argv.slice(2)): Promise<number> {
  return 1;
}
