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

/** The floor entry was fitted on another golden file than the run's: the run stops before its first item (never a silent 0.65). */
export class FixtureFloorMismatchError extends Error {
  constructor(file: string, mode: FixtureMode, entryGolden: string, runGolden: string) {
    super(
      `[Eval Harness] fixture floor ${file} (mode ${mode}) was fitted on golden_sha256 ${entryGolden || '(none)'}, ` +
        `the run's golden file is ${runGolden}; refit it with python -m rag_eval.calibrate refusal --fixture-mode ${mode} --write-floor`,
    );
    this.name = 'FixtureFloorMismatchError';
  }
}

/** The entry of one fixture mode: the modes map (schema 2), or a single-entry file (schema 1) for the mode it names. */
function entryFor(raw: Record<string, unknown>, mode: FixtureMode): Record<string, unknown> | null {
  if (raw.source !== 'fixture') return null;
  if (raw.schema_version === 2) {
    const modes = raw.modes;
    if (!isRecord(modes)) return null;
    const entry = modes[mode];
    return isRecord(entry) ? entry : null;
  }
  if (raw.schema_version === 1) return raw.fixture_mode === mode ? raw : null;
  return null;
}

/**
 * The committed fixture score_calibration for this fixture mode, or null when it does not apply (no entry, not calibrated). With a run
 * golden hash, an entry fitted on another golden file, or carrying none, throws FixtureFloorMismatchError.
 */
export function fixtureScoreCalibrationFor(
  raw: unknown,
  mode: FixtureMode,
  goldenSha256?: string | null,
  file = FIXTURE_SCORE_CALIBRATION_PATH,
): Record<string, number> | null {
  if (!isRecord(raw)) return null;
  const entry = entryFor(raw, mode);
  if (entry === null) return null;
  if (goldenSha256 !== undefined && goldenSha256 !== null) {
    const fitted = typeof entry.golden_sha256 === 'string' ? entry.golden_sha256 : '';
    if (fitted !== goldenSha256) throw new FixtureFloorMismatchError(file, mode, fitted, goldenSha256);
  }
  if (entry.status !== 'calibrated') return null;
  const calibration = entry.score_calibration;
  if (!isRecord(calibration)) return null;
  const keys = Object.keys(calibration);
  if (keys.length !== 1 || keys[0] !== 'context_threshold') return null;
  const threshold = calibration.context_threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return null;
  return { context_threshold: threshold };
}

/**
 * Reads the committed file; a missing or unreadable file means the legacy floor stays. The harness passes the sha256 of the run's golden
 * file, so a floor fitted on another golden set stops the run; callers without a run golden file read the entry unchecked.
 */
export function loadFixtureScoreCalibration(
  mode: FixtureMode,
  options: { goldenSha256?: string | null; file?: string } = {},
): Record<string, number> | null {
  const file = options.file ?? FIXTURE_SCORE_CALIBRATION_PATH;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return fixtureScoreCalibrationFor(raw, mode, options.goldenSha256, path.relative(process.cwd(), file) || file);
}
