import type { RpcClient } from '../backend/supabase-rpc';
import type { BackendCapabilities } from '../backend/types';
import type { RagEnvInput } from '../config';

export type AccessStartupStatus = 'not_checked' | 'off' | 'ready' | 'not_ready';

export interface AccessStartupVerdict {
  status: AccessStartupStatus;
  flagValue: boolean | null;
  reasons: readonly string[];
  objects: readonly string[];
  checkedAt: number | null;
}

export interface AccessStartupDeps {
  ragEnv: () => RagEnvInput;
  adminClient: () => RpcClient | null;
  backendCapabilities: () => BackendCapabilities | undefined | Promise<BackendCapabilities | undefined>;
  now: () => number;
  timeoutMs?: number;
}

const NOT_CHECKED: AccessStartupVerdict = { status: 'not_checked', flagValue: null, reasons: [], objects: [], checkedAt: null };

export function getAccessStartupVerdict(): AccessStartupVerdict {
  return NOT_CHECKED;
}

export async function verifyAccessGroupsStartup(_deps?: Partial<AccessStartupDeps>): Promise<AccessStartupVerdict> {
  return NOT_CHECKED;
}

export async function syncAccessEnforcementNow(_deps?: Partial<AccessStartupDeps>): Promise<AccessStartupVerdict> {
  return NOT_CHECKED;
}

export function resetAccessStartupForTests(): void {}
