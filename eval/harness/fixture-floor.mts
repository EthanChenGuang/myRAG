import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type FixtureMode = 'prechunked' | 'ingest';

export const FIXTURE_SCORE_CALIBRATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../config/fixture-score-calibration.json',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The committed fixture score_calibration for this fixture mode, or null when it does not apply. */
export function fixtureScoreCalibrationFor(raw: unknown, mode: FixtureMode): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  if (raw.schema_version !== 1 || raw.source !== 'fixture' || raw.status !== 'calibrated') return null;
  if (raw.fixture_mode !== mode) return null;
  const calibration = raw.score_calibration;
  if (!isRecord(calibration)) return null;
  const keys = Object.keys(calibration);
  if (keys.length !== 1 || keys[0] !== 'context_threshold') return null;
  const threshold = calibration.context_threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return null;
  return { context_threshold: threshold };
}

/** Reads the committed file; a missing or unreadable file means the legacy floor stays. */
export function loadFixtureScoreCalibration(mode: FixtureMode, file = FIXTURE_SCORE_CALIBRATION_PATH): Record<string, number> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return fixtureScoreCalibrationFor(raw, mode);
}
