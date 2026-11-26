import type { TerminologyMatch } from '@/lib/rag-eval/contracts.generated';
import type { RpcClient } from '../backend/supabase-rpc';
import type { RagConfig } from '../config';
import type { TenantScope } from '../tenant/scope';
import type { Profile } from '../types';

export interface TerminologyGlossary {
  matches: TerminologyMatch[];
  version: string;
}

export interface TerminologyGlossaryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  profile?: Profile;
  config?: RagConfig;
  client?: RpcClient;
  now?: () => number;
}

export async function terminologyGlossary(
  _scope: TenantScope,
  _text: string,
  _options: TerminologyGlossaryOptions = {},
): Promise<TerminologyGlossary | null> {
  return null;
}
