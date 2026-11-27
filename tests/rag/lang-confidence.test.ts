import { cpSync, mkdtempSync, appendFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { queryLanguageConfidence } from '@/lib/rag/feedback-loop/retrieval-log';
import {
  calibratedQueryLanguageConfidence,
  loadLanguageConfidenceCalibration,
  mappedQueryLanguageConfidence,
  resetLanguageConfidenceCalibrationForTests,
  type LanguageConfidenceCalibration,
} from '@/lib/rag/lang/confidence';
import type { LanguageDetection } from '@/lib/rag/lang/detect';
import { computeCalibration, runCalibrationTool } from '../../eval/harness/calibrate-language-confidence.mts';

const ROOT = process.cwd();
const COMMITTED = path.join(ROOT, 'eval/config/language-confidence-calibration.json');
const COPIED = [
  'eval/fixtures/golden.jsonl',
  'eval/fixtures/domain/golden.jsonl',
  'eval/fixtures/ingest/golden-ingest.jsonl',
  'src/lib/rag/lang/detect.ts',
  'config/rag/language-packs.json',
  'eval/config/language-confidence-calibration.json',
];

const confident: LanguageDetection = { language: 'en', confident: true, confidence: 0.9 };
const tentative: LanguageDetection = { language: 'en', confident: false, confidence: 0.1 };
const none: LanguageDetection = { language: null, confident: false, confidence: 0 };

function calibration(): LanguageConfidenceCalibration {
  const loaded = loadLanguageConfidenceCalibration(COMMITTED);
  expect(loaded).not.toBeNull();
  return loaded!;
}

function withBin(base: LanguageConfidenceCalibration, match: { confident: boolean; length_bucket: string; script_class: string }, bin: Partial<LanguageConfidenceCalibration['bins'][number]>) {
  return {
    ...base,
    bins: base.bins.map((entry) =>
      entry.confident === match.confident && entry.length_bucket === match.length_bucket && entry.script_class === match.script_class ? { ...entry, ...bin } : entry,
    ),
  } as LanguageConfidenceCalibration;
}

let scratch: string | null = null;

afterEach(() => {
  resetLanguageConfidenceCalibrationForTests();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
  vi.restoreAllMocks();
});

function copyInputs(): string {
  scratch = mkdtempSync(path.join(tmpdir(), 'lang-calibration-'));
  for (const relative of COPIED) {
    mkdirSync(path.dirname(path.join(scratch, relative)), { recursive: true });
    cpSync(path.join(ROOT, relative), path.join(scratch, relative));
  }
  return scratch;
}

describe('mapped query-language confidence', () => {
  test('mapped: 1 confident, 0.5 not, null without a language or when it differs from the stored language (FBK-01 rule)', () => {
    expect(mappedQueryLanguageConfidence(confident, 'en')).toBe(1);
    expect(mappedQueryLanguageConfidence(tentative, 'en')).toBe(0.5);
    expect(mappedQueryLanguageConfidence(none, null)).toBeNull();
    expect(mappedQueryLanguageConfidence(confident, 'zh')).toBeNull();
    for (const [detection, stored] of [[confident, 'en'], [tentative, 'en'], [none, null], [confident, 'zh'], [tentative, null]] as const) {
      expect(mappedQueryLanguageConfidence(detection, stored)).toBe(queryLanguageConfidence(detection, stored));
    }
  });
});

describe('calibrated query-language confidence', () => {
  test('returns the bin value for a calibrated bin', () => {
    const table = withBin(calibration(), { confident: true, length_bucket: 'short', script_class: 'single' }, { n: 8, correct: 6, value: 0.7, source: 'calibrated' });
    expect(calibratedQueryLanguageConfidence({ text: 'short question', detection: confident, storedLanguage: 'en' }, table)).toBe(0.7);
  });

  test('falls back to the mapped value for an empty bin', () => {
    const table = withBin(calibration(), { confident: false, length_bucket: 'short', script_class: 'single' }, { n: 0, correct: 0, value: 0.5, source: 'mapped_fallback' });
    expect(calibratedQueryLanguageConfidence({ text: 'short question', detection: tentative, storedLanguage: 'en' }, table)).toBe(0.5);
  });

  test('returns null when no language was found or the mapped rule gives null', () => {
    const table = calibration();
    expect(calibratedQueryLanguageConfidence({ text: '12345', detection: none, storedLanguage: null }, table)).toBeNull();
    expect(calibratedQueryLanguageConfidence({ text: 'short question', detection: confident, storedLanguage: 'zh' }, table)).toBeNull();
  });

  test('bins by length bucket and script class', () => {
    let table = calibration();
    table = withBin(table, { confident: true, length_bucket: 'long', script_class: 'single' }, { n: 3, correct: 1, value: 0.4, source: 'calibrated' });
    table = withBin(table, { confident: true, length_bucket: 'short', script_class: 'mixed' }, { n: 3, correct: 2, value: 0.6, source: 'calibrated' });
    expect(calibratedQueryLanguageConfidence({ text: 'a'.repeat(table.length_buckets.medium_max_chars + 1), detection: confident, storedLanguage: 'en' }, table)).toBe(0.4);
    expect(calibratedQueryLanguageConfidence({ text: 'abc 中文', detection: confident, storedLanguage: 'en' }, table)).toBe(0.6);
  });
});

describe('calibration tool', () => {
  test('the committed file validates and a bin with n 0 is written as mapped_fallback', () => {
    const table = calibration();
    expect(table.bins).toHaveLength(12);
    for (const bin of table.bins) {
      if (bin.n === 0) expect(bin).toMatchObject({ source: 'mapped_fallback', value: bin.confident ? 1 : 0.5 });
      else expect(bin.value).toBeCloseTo((bin.correct + 1) / (bin.n + 2), 4);
    }
  });

  test('two runs on the same inputs write byte-identical files', () => {
    const root = copyInputs();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const target = path.join(root, 'eval/config/language-confidence-calibration.json');
    expect(runCalibrationTool([], root)).toBe(0);
    const first = readFileSync(target, 'utf8');
    expect(runCalibrationTool([], root)).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(first);
    expect(first).toBe(readFileSync(COMMITTED, 'utf8'));
    expect(computeCalibration('2026-01-01T00:00:00Z', root)).toEqual(computeCalibration('2026-01-01T00:00:00Z', root));
  });

  test('--check exits 0 on the committed file and 1 after an input file changes', () => {
    const root = copyInputs();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runCalibrationTool(['--check'], root)).toBe(0);
    appendFileSync(path.join(root, 'eval/fixtures/domain/golden.jsonl'), '\n');
    expect(runCalibrationTool(['--check'], root)).toBe(1);
  });
});
