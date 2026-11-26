import type { BackfillScopeResult } from '@/lib/rag/tenant/backfill-scope';
import type { RunnerIo } from '../backfill/runners';

export type ParsedRulesArgs = { ok: false; error: string };
export const USAGE = '';
export type RulesCliOverrides = { resolveScope?: (tenantKey: string) => Promise<BackfillScopeResult>; cwd?: string };

export function parseRulesArgs(_argv: string[]): ParsedRulesArgs {
  return { ok: false, error: 'not implemented' };
}

export async function main(_argv: string[], _io: RunnerIo, _signal: AbortSignal, _overrides: RulesCliOverrides = {}): Promise<number> {
  return 99;
}
