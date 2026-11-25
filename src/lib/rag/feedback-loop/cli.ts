import type { SupabaseClient } from '@supabase/supabase-js';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliDeps {
  env?: Record<string, string | undefined>;
  createClient?: (url: string, key: string) => SupabaseClient;
}

export async function main(_argv: string[], _io: CliIo, _deps: CliDeps = {}): Promise<number> {
  return 0;
}
