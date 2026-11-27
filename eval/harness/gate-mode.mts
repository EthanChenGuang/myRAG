import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureMode } from './pglite-supabase.mts';

export type GatesMode = 'enforce' | 'report';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The 05.3 measurement record; scripts/ci/check-workflows.py checks the pr-smoke --gates-mode flags against the same file. */
export const MEASUREMENT_PATH = path.join(REPO_ROOT, 'eval/reports/phase-05.3/absolute-gate-measurement.json');
/** The measured tier a local in-process run of each fixture mode belongs to. */
export const FIXTURE_MODE_TIERS: Record<FixtureMode, string> = { prechunked: 'smoke', ingest: 'smoke-ingest' };
const STAGE_ORDER: Record<string, number> = { before: 0, after: 1 };

interface MeasuredTier {
  name?: unknown;
  stage?: unknown;
  mode?: unknown;
  out?: unknown;
}

export interface TierMode {
  name: string;
  mode: GatesMode | null;
  out: string | null;
}

/** The mode of each measured tier's latest stage, keyed by tier name (same rule as latest_tier_modes in check-workflows.py). */
export function measuredTierModes(measurementPath: string = MEASUREMENT_PATH): Map<string, TierMode> {
  let tiers: MeasuredTier[] = [];
  try {
    const data = JSON.parse(fs.readFileSync(measurementPath, 'utf8')) as { tiers?: MeasuredTier[] };
    tiers = Array.isArray(data.tiers) ? data.tiers : [];
  } catch {
    return new Map();
  }
  const latest = new Map<string, { rank: number; entry: MeasuredTier }>();
  for (const entry of tiers) {
    const name = String(entry.name);
    const rank = STAGE_ORDER[String(entry.stage)] ?? -1;
    const seen = latest.get(name);
    if (!seen || rank > seen.rank) latest.set(name, { rank, entry });
  }
  const modes = new Map<string, TierMode>();
  for (const [name, { entry }] of latest) {
    const mode = entry.mode === 'enforce' || entry.mode === 'report' ? entry.mode : null;
    modes.set(name, { name, mode, out: typeof entry.out === 'string' ? entry.out : null });
  }
  return modes;
}

export interface GatesModeResolution {
  /** The mode passed to rag_eval.gate; undefined leaves the gate's own default (enforce). */
  mode: GatesMode | undefined;
  source: 'flag' | 'measured_tier' | 'gate_default';
  tier: string | null;
}

/**
 * O-1 / H-10: an explicit --gates-mode wins. Otherwise an in-process run takes the mode the measurement record holds for its
 * fixture mode's tier, which is the mode pr-smoke runs that tier in. A live run (--base-url), a --gates or --golden override
 * (the record measures eval/config/quality-gates.json on the default golden set), a missing record or an unmeasured tier keeps
 * the gate default, enforce.
 */
export function resolveGatesMode(
  explicit: GatesMode | undefined,
  run: { fixtureMode: FixtureMode; live: boolean; customInputs?: boolean },
  measurementPath: string = MEASUREMENT_PATH,
): GatesModeResolution {
  if (explicit !== undefined) return { mode: explicit, source: 'flag', tier: null };
  if (run.live || run.customInputs) return { mode: undefined, source: 'gate_default', tier: null };
  const tier = FIXTURE_MODE_TIERS[run.fixtureMode];
  const measured = measuredTierModes(measurementPath).get(tier)?.mode ?? null;
  if (measured === null) return { mode: undefined, source: 'gate_default', tier };
  return { mode: measured, source: 'measured_tier', tier };
}
