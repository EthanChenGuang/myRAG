import rawCalibration from '../../../../eval/config/scope-gate.json';
import { ScopeGateCalibrationSchema, type ScopeGateCalibration } from '@/lib/rag-eval/contracts.generated';
import type { RagMode } from '../types';
import type { ScopeCell } from './score';

const loggedProblems = new Set<string>();

function problem(key: string, message: string): void {
  if (loggedProblems.has(key)) return;
  loggedProblems.add(key);
  console.warn(`[Scope Gate] ${message}`);
}

/** The Pydantic rule JSON Schema cannot express: one cell per (embedding profile, RAG mode) pair. */
function consistent(parsed: ScopeGateCalibration): boolean {
  const list = parsed.cells ?? [];
  const keys = new Set(list.map((cell) => `${cell.embedding_profile_id}|${cell.rag_mode}`));
  if (keys.size !== list.length) return false;
  return list.every((cell) => cell.status !== 'calibrated' || (cell.threshold !== null && cell.margin !== null));
}

/** A calibration file that passes the generated schema and the cross-field rules, or null. */
export function parseScopeGateCalibration(data: unknown): ScopeGateCalibration | null {
  const parsed = ScopeGateCalibrationSchema.safeParse(data);
  return parsed.success && consistent(parsed.data) ? parsed.data : null;
}

let override: { data: unknown } | null = null;
let cached: Map<string, ScopeCell> | null = null;

function cells(): Map<string, ScopeCell> {
  if (cached) return cached;
  const parsed = parseScopeGateCalibration(override ? override.data : rawCalibration);
  const map = new Map<string, ScopeCell>();
  if (!parsed) {
    problem('scope-gate-calibration-invalid', 'Invalid scope-gate.json, the scope gate reports scores only');
  } else {
    for (const cell of parsed.cells ?? []) {
      if (cell.status !== 'calibrated' || cell.threshold === null || cell.margin === null) continue;
      map.set(`${cell.embedding_profile_id}|${cell.rag_mode}`, { threshold: cell.threshold, margin: cell.margin });
    }
  }
  cached = map;
  return map;
}

/**
 * D-27, P-36: the calibrated threshold and margin for an embedding profile and RAG mode, read from the committed
 * eval/config/scope-gate.json (written only by `python -m rag_eval.calibrate scope`). Null for a missing or uncalibrated cell, an
 * invalid file and the bypass mode, so the gate stays score-only.
 */
export function scopeGateCalibrationFor(profileId: string, ragMode: RagMode): ScopeCell | null {
  if (ragMode === 'bypass') return null;
  return cells().get(`${profileId}|${ragMode}`) ?? null;
}

/** Tests only: replaces the committed file's content until reset. */
export function setScopeGateCalibrationForTests(data: unknown): void {
  override = { data };
  cached = null;
  loggedProblems.clear();
}

export function resetScopeGateCalibrationForTests(): void {
  override = null;
  cached = null;
  loggedProblems.clear();
}
