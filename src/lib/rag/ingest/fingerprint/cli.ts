import type { RpcClient } from '../../backend/supabase-rpc';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function main(_argv: string[], _io: CliIo, _signal?: AbortSignal, _deps?: { db?: RpcClient | null }): Promise<number> {
  return 1;
}
