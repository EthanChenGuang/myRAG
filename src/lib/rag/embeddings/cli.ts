export type ParsedEmbeddingArgs =
  | { ok: true; command: 'status' }
  | { ok: true; command: 'activate'; profileId: string }
  | { ok: true; command: 'rollback' }
  | { ok: true; command: 'set-status'; profileId: string; status: 'available' | 'backfilling' | 'retired' }
  | { ok: false; error: string };

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const USAGE = '';

export function parseEmbeddingArgs(_argv: string[]): ParsedEmbeddingArgs {
  return { ok: false, error: 'not implemented' };
}

export async function main(_argv: string[] = [], _io?: CliIo, _signal?: AbortSignal): Promise<number> {
  return 1;
}
