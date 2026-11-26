/** D-29 judge calibration status (not implemented yet). */
export function judgeCalibrationStatus(_calibration: unknown, _gates: unknown, _today: Date): { floors: unknown; running: unknown; cells: Array<Record<string, unknown>>; warnings: Array<{ code: string }> } {
  return { floors: null, running: null, cells: [], warnings: [] };
}
