import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fixtureScoreCalibrationFor } from '../eval/harness/fixture-floor.mts';

const calibrated = {
  schema_version: 1,
  source: 'fixture',
  fixture_mode: 'prechunked',
  status: 'calibrated',
  score_calibration: { context_threshold: 0.11 },
};

describe('fixture score calibration for the eval harness', () => {
  test('returns the context threshold for the fixture mode it was fitted on', () => {
    assert.deepEqual(fixtureScoreCalibrationFor(calibrated, 'prechunked'), { context_threshold: 0.11 });
  });

  test('does not apply to another fixture mode', () => {
    assert.equal(fixtureScoreCalibrationFor(calibrated, 'ingest'), null);
  });

  test('rejects anything that is not a calibrated fixture record with a threshold in (0, 1)', () => {
    const bad: unknown[] = [
      null,
      {},
      { ...calibrated, source: 'live' },
      { ...calibrated, status: 'insufficient_data', score_calibration: {} },
      { ...calibrated, score_calibration: { context_threshold: 0 } },
      { ...calibrated, score_calibration: { context_threshold: 1 } },
      { ...calibrated, score_calibration: { context_threshold: '0.1' } },
      { ...calibrated, score_calibration: { context_threshold: 0.1, retrieval_threshold: 0.2 } },
      { ...calibrated, schema_version: 2 },
    ];
    for (const raw of bad) assert.equal(fixtureScoreCalibrationFor(raw, 'prechunked'), null, JSON.stringify(raw));
  });
});
