import type { TenantScope } from '../../tenant/scope';
import type { RebuildMechanism } from '../fingerprint';

export class RebuildRefused extends Error {
  constructor(readonly code: 'activation_refused' | 'rollback_refused', readonly reason: string) {
    super(`${code}: ${reason}`);
    this.name = 'RebuildRefused';
  }
}
export class RebuildNotFound extends Error {}
export class RebuildInputError extends Error {}

export interface RebuildRunRow {
  id: string;
  mechanism: string;
  activation: string;
  state: string;
  total: number;
  done: number;
  gaps: number;
}

export interface RebuildDeps {
  saved?: Record<string, string>;
  ingestAsync?: () => boolean;
  scopeFor?: (tenantKey: string, signal: AbortSignal) => Promise<TenantScope | null>;
}

export async function startRebuild(
  _input: { mechanism: RebuildMechanism; dryRun?: boolean; startedBy: string | null },
  _deps: RebuildDeps = {},
): Promise<{ status: string; affected: number; plan: { kind: string }; run?: RebuildRunRow }> {
  return { status: 'nothing', affected: 0, plan: { kind: 'nothing' } };
}

export async function getRebuildRun(_runId: string): Promise<RebuildRunRow | null> {
  return null;
}

export async function recordRebuildEvidence(_runId: string, _report: unknown): Promise<{ passed: boolean }> {
  return { passed: false };
}

export async function activateRebuild(_runId: string, _actor: string | null): Promise<{ published: string[] }> {
  return { published: [] };
}

export async function rollbackRebuild(_runId: string, _actor: string | null): Promise<{ restored: string[] }> {
  return { restored: [] };
}
