import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import {
  FIXTURE_SCORE_CALIBRATION_PATH,
  fixtureScoreCalibrationFor,
  loadFixtureScoreCalibration,
} from '../eval/harness/fixture-floor.mts';
import { LEGACY_TEXT_FLOOR } from '../src/lib/rag/refusal/floor.ts';

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

describe('committed fixture score calibrations, one per fixture mode', () => {
  test('ingest mode reads its own calibrated floor', () => {
    const ingest = loadFixtureScoreCalibration('ingest');
    assert.ok(ingest, 'no calibrated ingest-mode floor is committed');
    const threshold = ingest.context_threshold;
    assert.ok(threshold > 0 && threshold < LEGACY_TEXT_FLOOR, `ingest floor ${threshold} must sit in (0, ${LEGACY_TEXT_FLOOR})`);
  });

  test('prechunked mode keeps the floor it was fitted with', () => {
    const prechunked = loadFixtureScoreCalibration('prechunked');
    assert.ok(prechunked);
    const committed = JSON.parse(fs.readFileSync(FIXTURE_SCORE_CALIBRATION_PATH, 'utf8'));
    assert.equal(committed.fixture_mode, 'prechunked');
    assert.equal(prechunked.context_threshold, committed.score_calibration.context_threshold);
  });

  test('each mode reads a different file', () => {
    const ingest = loadFixtureScoreCalibration('ingest');
    const prechunked = loadFixtureScoreCalibration('prechunked');
    assert.ok(ingest && prechunked);
    assert.notEqual(ingest.context_threshold, prechunked.context_threshold);
  });
});
