export type FixtureMode = 'prechunked' | 'ingest';

/** The committed fixture score_calibration for this fixture mode, or null when it does not apply. */
export function fixtureScoreCalibrationFor(_raw: unknown, _mode: FixtureMode): Record<string, number> | null {
  return null;
}
