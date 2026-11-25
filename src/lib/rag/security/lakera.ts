import type { InjectionDetectorConfig } from '@/lib/rag-eval/contracts.generated';
import type { InjectionCheckMode } from './config';
import type { Detector } from './detectors';

export type LakeraGateRefusal = 'check_off' | 'lakera_off' | 'not_configured' | 'multi_tenant_ack_missing';
export type LakeraUnavailableReason = string;

export interface LakeraGateInput {
  injectionCheck: InjectionCheckMode;
  lakera: boolean;
  multiTenant: boolean;
  ack: boolean;
  apiKeyPresent: boolean;
}

export interface LakeraSettings {
  injectionCheck: InjectionCheckMode;
  lakera: boolean;
  multiTenant: boolean;
  ack: boolean;
  apiKey: string | null;
  baseUrl: string;
}

export interface LakeraDetectorDeps {
  config: InjectionDetectorConfig['lakera'];
  fetch: typeof fetch;
  gate: () => LakeraSettings;
  timeoutMs?: number;
}

export function lakeraAllowed(_input: LakeraGateInput): { allowed: boolean; reason: LakeraGateRefusal | null } {
  return { allowed: true, reason: null };
}

export function lakeraVerdict(_body: unknown, _detectorTypes: readonly string[], _minLevel: string | null): unknown {
  return { kind: 'verdict', flagged: false, level: null };
}

export function createLakeraDetector(deps: LakeraDetectorDeps): Detector {
  return {
    id: 'lakera',
    version: 'stub',
    async classify(items) {
      await deps.fetch('stub');
      return items.map(() => ({ kind: 'verdict' as const, verdict: { flagged: false, at: 0 } }));
    },
  };
}
