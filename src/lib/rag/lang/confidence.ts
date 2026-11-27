import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LanguageConfidenceCalibrationSchema, type LanguageConfidenceCalibration } from '@/lib/rag-eval/contracts.generated';
import { queryLanguageConfidence } from '../feedback-loop/log-languages';
import type { LanguageDetection } from './detect';

export type { LanguageConfidenceCalibration } from '@/lib/rag-eval/contracts.generated';

export type LengthBucket = 'short' | 'medium' | 'long';
export type ScriptClass = 'single' | 'mixed';

export const CALIBRATION_PATH = path.join('eval', 'config', 'language-confidence-calibration.json');

const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;

/** Query length in characters (code points) against the file's bucket limits. */
export function lengthBucketOf(text: string, buckets: LanguageConfidenceCalibration['length_buckets']): LengthBucket {
  const length = [...text.trim()].length;
  if (length <= buckets.short_max_chars) return 'short';
  if (length <= buckets.medium_max_chars) return 'medium';
  return 'long';
}

/** `mixed` when the text holds both Han and Latin letters, else `single`. */
export function scriptClassOf(text: string): ScriptClass {
  return HAN.test(text) && LATIN.test(text) ? 'mixed' : 'single';
}

/** Today's FBK-01 rule (05.1.1 D-03a): 1 confident, 0.5 not, null without a language or when it differs from the stored one. */
export function mappedQueryLanguageConfidence(detection: LanguageDetection, storedLanguage: string | null): number | null {
  return queryLanguageConfidence(detection, storedLanguage);
}

export interface CalibratedConfidenceInput {
  /** The query text, read for its length and script class only. */
  text: string;
  detection: LanguageDetection;
  storedLanguage: string | null;
}

/** The bin's calibrated value; an empty (mapped_fallback) bin gives the mapped value; null exactly where the mapped rule gives null. */
export function calibratedQueryLanguageConfidence(input: CalibratedConfidenceInput, calibration: LanguageConfidenceCalibration): number | null {
  const mapped = mappedQueryLanguageConfidence(input.detection, input.storedLanguage);
  if (mapped === null) return null;
  const bucket = lengthBucketOf(input.text, calibration.length_buckets);
  const script = scriptClassOf(input.text);
  const bin = calibration.bins.find(
    (entry) => entry.confident === input.detection.confident && entry.length_bucket === bucket && entry.script_class === script,
  );
  if (!bin || bin.source !== 'calibrated') return mapped;
  return bin.value;
}

let cached: { file: string; calibration: LanguageConfidenceCalibration | null } | null = null;

/** Reads and validates the committed file once per path; null when it is missing or invalid (the caller keeps the mapped value). */
export function loadLanguageConfidenceCalibration(file: string = path.resolve(process.cwd(), CALIBRATION_PATH)): LanguageConfidenceCalibration | null {
  if (cached && cached.file === file) return cached.calibration;
  let calibration: LanguageConfidenceCalibration | null = null;
  try {
    const parsed = LanguageConfidenceCalibrationSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    calibration = parsed.success ? parsed.data : null;
  } catch {
    calibration = null;
  }
  cached = { file, calibration };
  return calibration;
}

export function resetLanguageConfidenceCalibrationForTests(): void {
  cached = null;
}
