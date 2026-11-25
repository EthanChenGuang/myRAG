import type { InjectionDetectorConfig } from '@/lib/rag-eval/contracts.generated';
import type { TenantScope } from '@/lib/rag/tenant/scope';

export type DetectorId = 'prompt_guard' | 'lakera';
export type DetectorProfile = 'chat' | 'embed' | 'eval';

export interface DetectorVerdict {
  flagged: boolean;
  score?: number;
  level?: string | null;
  at: number;
}

export interface DetectorClassifyOptions {
  signal: AbortSignal;
  profile: DetectorProfile;
  traceId: string | null;
  scope: TenantScope;
}

export type DetectorOutcome =
  | { kind: 'verdict'; verdict: DetectorVerdict }
  | { kind: 'unavailable'; reason: string };

export interface Detector {
  readonly id: DetectorId;
  readonly version: string;
  classify(items: readonly string[], opts: DetectorClassifyOptions): Promise<DetectorOutcome[]>;
}

export function loadInjectionDetectorConfig(_options: { path?: string } = {}): InjectionDetectorConfig {
  throw new Error('not implemented');
}

export function detectorsConfigVersion(): string {
  return '';
}

export function resetInjectionDetectorConfigForTests(): void {}
