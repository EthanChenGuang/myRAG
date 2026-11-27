import type { ScopeGateCalibration } from '@/lib/rag-eval/contracts.generated';
import type { RagMode } from '../types';
import type { ScopeCell } from './score';

export function parseScopeGateCalibration(_data: unknown): ScopeGateCalibration | null {
  return null;
}

export function scopeGateCalibrationFor(_profileId: string, _ragMode: RagMode): ScopeCell | null {
  return { threshold: 0, margin: 0 };
}

export function setScopeGateCalibrationForTests(_data: unknown): void {}

export function resetScopeGateCalibrationForTests(): void {}
