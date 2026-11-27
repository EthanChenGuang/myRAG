import type { RpcClient } from '../backend/supabase-rpc';
import type { RagConfig } from '../config';

export const LEXICAL_WRITE_TIMEOUT_MS = 5_000;

export interface LexicalWriteDeps {
  db: () => RpcClient | null;
  config?: Pick<RagConfig, 'v2'>;
  timeoutMs?: number;
}

export async function afterLexicalWrite(_deps: LexicalWriteDeps, _tenantKey: string): Promise<void> {}

export function resetLexicalWriteLogForTests(): void {}
