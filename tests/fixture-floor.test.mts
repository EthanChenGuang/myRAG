import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  FIXTURE_SCORE_CALIBRATION_PATH,
  fixtureScoreCalibrationFor,
  loadFixtureScoreCalibration,
} from '../eval/harness/fixture-floor.mts';
import { LEGACY_TEXT_FLOOR } from '../src/lib/rag/refusal/floor.ts';

const MISMATCH = (error: unknown): boolean => error instanceof Error && error.name === 'FixtureFloorMismatchError';

const RUN_GOLDEN = 'b'.repeat(64);
const OTHER_GOLDEN = 'c'.repeat(64);

const calibrated = {
  schema_version: 1,
  source: 'fixture',
  fixture_mode: 'prechunked',
  status: 'calibrated',
  score_calibration: { context_threshold: 0.11 },
  golden_sha256: RUN_GOLDEN,
};

const entry = (threshold: number, golden: string | null = RUN_GOLDEN) => ({
  status: 'calibrated',
  score_calibration: { context_threshold: threshold },
  target_false_refusal: 0.05,
  dev: null,
  ...(golden === null ? {} : { golden_sha256: golden }),
});

const byMode = { schema_version: 2, source: 'fixture', modes: { prechunked: entry(0.11), ingest: entry(0.22) } };

describe('fixture score calibration for the eval harness', () => {
  test('returns the context threshold of the run fixture mode from the modes map', () => {
    assert.deepEqual(fixtureScoreCalibrationFor(byMode, 'prechunked', RUN_GOLDEN), { context_threshold: 0.11 });
    assert.deepEqual(fixtureScoreCalibrationFor(byMode, 'ingest', RUN_GOLDEN), { context_threshold: 0.22 });
  });

  test('still reads a file in the single-entry shape for the mode it names', () => {
    assert.deepEqual(fixtureScoreCalibrationFor(calibrated, 'prechunked', RUN_GOLDEN), { context_threshold: 0.11 });
    assert.equal(fixtureScoreCalibrationFor(calibrated, 'ingest', RUN_GOLDEN), null);
  });

  test('a mode without an entry keeps the 0.65 floor', () => {
    const only = { ...byMode, modes: { prechunked: entry(0.11) } };
    assert.equal(fixtureScoreCalibrationFor(only, 'ingest', RUN_GOLDEN), null);
  });

  test('an entry fitted on another golden file stops the run with a named error', () => {
    const stale = { ...byMode, modes: { prechunked: entry(0.11, OTHER_GOLDEN) } };
    assert.throws(
      () => fixtureScoreCalibrationFor(stale, 'prechunked', RUN_GOLDEN, 'eval/config/fixture-score-calibration.json'),
      (error: unknown) =>
        MISMATCH(error) &&
        error instanceof Error &&
        error.message.includes('eval/config/fixture-score-calibration.json') &&
        error.message.includes('prechunked') &&
        error.message.includes(OTHER_GOLDEN) &&
        error.message.includes(RUN_GOLDEN),
    );
    assert.throws(() => fixtureScoreCalibrationFor({ ...calibrated, golden_sha256: OTHER_GOLDEN }, 'prechunked', RUN_GOLDEN), MISMATCH);
  });

  test('an entry without a golden hash is a mismatch', () => {
    const blank = { ...byMode, modes: { ingest: entry(0.22, null) } };
    assert.throws(() => fixtureScoreCalibrationFor(blank, 'ingest', RUN_GOLDEN), MISMATCH);
    assert.throws(() => fixtureScoreCalibrationFor({ ...byMode, modes: { ingest: entry(0.22, '') } }, 'ingest', RUN_GOLDEN), MISMATCH);
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
      { ...calibrated, schema_version: 3 },
      { ...byMode, source: 'live' },
      { ...byMode, modes: { prechunked: { ...entry(0.11), status: 'uncalibrated', score_calibration: {} } } },
    ];
    for (const raw of bad) assert.equal(fixtureScoreCalibrationFor(raw, 'prechunked', RUN_GOLDEN), null, JSON.stringify(raw));
  });

  test('the loader checks the hash of the file it reads and a missing file keeps the 0.65 floor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-floor-'));
    const file = path.join(dir, 'fixture-score-calibration.json');
    assert.equal(loadFixtureScoreCalibration('prechunked', { goldenSha256: RUN_GOLDEN, file }), null);
    fs.writeFileSync(file, JSON.stringify(byMode));
    assert.deepEqual(loadFixtureScoreCalibration('ingest', { goldenSha256: RUN_GOLDEN, file }), { context_threshold: 0.22 });
    assert.throws(() => loadFixtureScoreCalibration('ingest', { goldenSha256: OTHER_GOLDEN, file }), MISMATCH);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('golden set in force (04.1-18 rule: a subset run checks the floor against the set in force for its mode)', () => {
  const sha = (bytes: Buffer | string): string => crypto.createHash('sha256').update(bytes).digest('hex');

  test('prechunked hashes golden.jsonl as it is; ingest hashes the merged ingest golden files', async () => {
    const ingestMode: Record<string, unknown> = await import('../eval/harness/ingest-mode.mts');
    assert.equal(typeof ingestMode.goldenInForceSha256, 'function');
    const inForce = ingestMode.goldenInForceSha256 as (mode: 'prechunked' | 'ingest', root?: string) => string;
    const root = path.resolve(import.meta.dirname, '..');
    assert.equal(inForce('prechunked', root), sha(fs.readFileSync(path.join(root, 'eval/fixtures/golden.jsonl'))));
    const merged = ['eval/fixtures/golden.jsonl', 'eval/fixtures/ingest/golden-ingest.jsonl']
      .flatMap((file) => fs.readFileSync(path.join(root, file), 'utf8').split('\n').filter((line) => line.trim() !== ''));
    assert.equal(inForce('ingest', root), sha(`${merged.join('\n')}\n`));
  });

  test('the committed floor of each mode was fitted on its set in force, and another hash still stops the run', async () => {
    const { goldenInForceSha256 } = (await import('../eval/harness/ingest-mode.mts')) as unknown as { goldenInForceSha256?: (mode: 'prechunked' | 'ingest') => string };
    assert.equal(typeof goldenInForceSha256, 'function');
    for (const mode of ['prechunked', 'ingest'] as const) {
      assert.ok(loadFixtureScoreCalibration(mode, { goldenSha256: goldenInForceSha256!(mode) }));
      assert.throws(() => loadFixtureScoreCalibration(mode, { goldenSha256: 'd'.repeat(64) }), MISMATCH);
    }
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
    assert.equal(committed.schema_version, 2);
    assert.deepEqual(Object.keys(committed.modes), ['prechunked']);
    assert.equal(prechunked.context_threshold, committed.modes.prechunked.score_calibration.context_threshold);
  });

  test('each mode reads a different file', () => {
    const ingest = loadFixtureScoreCalibration('ingest');
    const prechunked = loadFixtureScoreCalibration('prechunked');
    assert.ok(ingest && prechunked);
    assert.notEqual(ingest.context_threshold, prechunked.context_threshold);
  });
});
