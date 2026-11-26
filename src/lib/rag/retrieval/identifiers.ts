import type { RpcClient } from '../backend/supabase-rpc';
import type { TenantScope } from '../tenant/scope';

export const MAX_QUERY_IDENTIFIERS = 16;
export const MAX_IDENTIFIER_SUGGESTIONS = 3;

export interface AskedIdentifier {
  raw: string;
  norm: string;
}

export interface QueryIdentifiers {
  asked: AskedIdentifier[];
  found: string[];
  missing: string[];
}

export interface IdentifierCallOptions {
  client: RpcClient;
  signal: AbortSignal;
}

export async function resolveQueryIdentifiers(
  _scope: TenantScope,
  _query: string,
  _patterns: readonly RegExp[],
  _options: IdentifierCallOptions,
): Promise<QueryIdentifiers> {
  return { asked: [], found: [], missing: [] };
}

export function guardNearMisses<T>(
  items: readonly T[],
  _askedNorms: readonly string[],
  _options: { contentOf: (item: T) => string; patterns?: readonly RegExp[] },
): { kept: T[]; dropped: number } {
  return { kept: [...items], dropped: 0 };
}

export async function identifierSuggestions(_scope: TenantScope, _missing: readonly string[], _options: IdentifierCallOptions): Promise<string[]> {
  return [];
}
