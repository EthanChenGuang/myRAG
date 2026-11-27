import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanguageConfidenceCalibrationSchema, type LanguageConfidenceCalibration } from '../../src/lib/rag-eval/contracts.generated.ts';
import { lengthBucketOf, scriptClassOf, type LengthBucket, type ScriptClass } from '../../src/lib/rag/lang/confidence.ts';
import { detectLanguageWithConfidence } from '../../src/lib/rag/lang/detect.ts';

/**
 * OBS-03 (plan 07-41): calibrates query-language confidence from every fixture item with a known language. Writes
 * eval/config/language-confidence-calibration.json; `--check` recomputes and exits 1 on any difference.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = 'eval/config/language-confidence-calibration.json';
const DETECTOR = 'heuristic';
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const LENGTH_BUCKETS = { short_max_chars: 20, medium_max_chars: 60 } as const;
const BUCKETS: readonly LengthBucket[] = ['short', 'medium', 'long'];
const SCRIPTS: readonly ScriptClass[] = ['single', 'mixed'];
const MAPPED = { true: 1, false: 0.5 } as const;

/** Golden question files (the Phase 3.2 language slices) and, when present, the Phase 6.2 detection cases. */
const GOLDEN_INPUTS = ['eval/fixtures/golden.jsonl', 'eval/fixtures/domain/golden.jsonl', 'eval/fixtures/ingest/golden-ingest.jsonl'];
const OPTIONAL_INPUTS = ['eval/fixtures/lang-detect/cases.jsonl'];
/** The detector and its registry decide every result, so a change to either also invalidates the file. */
const DETECTOR_INPUTS = ['src/lib/rag/lang/detect.ts', 'config/rag/language-packs.json'];

interface Sample {
  text: string;
  language: string;
}

function readJsonl(root: string, relative: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(path.join(root, relative), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`[Language Calibration] ${relative} line ${index + 1} is not valid JSON`);
      }
    });
}

function samplesOf(root: string, relative: string): Sample[] {
  const samples: Sample[] = [];
  for (const row of readJsonl(root, relative)) {
    const text = typeof row.question === 'string' ? row.question : typeof row.text === 'string' ? row.text : null;
    const language = typeof row.language === 'string' ? row.language : typeof row.expected_language === 'string' ? row.expected_language : null;
    if (text === null || text.trim().length === 0 || language === null || !LANGUAGE_CODE.test(language)) continue;
    samples.push({ text, language });
  }
  return samples;
}

function sha256(root: string, relative: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function computeCalibration(generatedAt: string, root: string = ROOT): LanguageConfidenceCalibration {
  const sampleInputs = [...GOLDEN_INPUTS, ...OPTIONAL_INPUTS.filter((relative) => fs.existsSync(path.join(root, relative)))];
  const counts = new Map<string, { n: number; correct: number }>();
  const key = (confident: boolean, bucket: LengthBucket, script: ScriptClass) => `${confident}|${bucket}|${script}`;
  for (const relative of sampleInputs) {
    for (const sample of samplesOf(root, relative)) {
      const detection = detectLanguageWithConfidence(sample.text);
      // Without a detected language the mapped and calibrated values are both null, so there is nothing to calibrate.
      if (detection.language === null) continue;
      const cell = key(detection.confident, lengthBucketOf(sample.text, LENGTH_BUCKETS), scriptClassOf(sample.text));
      const entry = counts.get(cell) ?? { n: 0, correct: 0 };
      entry.n += 1;
      if (detection.language === sample.language) entry.correct += 1;
      counts.set(cell, entry);
    }
  }

  const bins: LanguageConfidenceCalibration['bins'] = [];
  for (const confident of [true, false]) {
    for (const bucket of BUCKETS) {
      for (const script of SCRIPTS) {
        const entry = counts.get(key(confident, bucket, script)) ?? { n: 0, correct: 0 };
        bins.push(
          entry.n === 0
            ? { confident, length_bucket: bucket, script_class: script, n: 0, correct: 0, value: MAPPED[`${confident}`], source: 'mapped_fallback' }
            : {
                confident,
                length_bucket: bucket,
                script_class: script,
                n: entry.n,
                correct: entry.correct,
                value: round4((entry.correct + 1) / (entry.n + 2)),
                source: 'calibrated',
              },
        );
      }
    }
  }

  return LanguageConfidenceCalibrationSchema.parse({
    schema_version: 1,
    detector: DETECTOR,
    generated_at: generatedAt,
    smoothing: 'laplace',
    length_buckets: { ...LENGTH_BUCKETS },
    inputs: [...sampleInputs, ...DETECTOR_INPUTS].map((relative) => ({ path: relative, sha256: sha256(root, relative) })),
    bins,
  });
}

export function serializeCalibration(calibration: LanguageConfidenceCalibration): string {
  return `${JSON.stringify(calibration, null, 2)}\n`;
}

function existingGeneratedAt(root: string): string | null {
  try {
    const value = (JSON.parse(fs.readFileSync(path.join(root, OUTPUT), 'utf8')) as { generated_at?: unknown }).generated_at;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Exit code 0 on write or an up-to-date check, 1 when `--check` finds a difference. */
export function runCalibrationTool(argv: readonly string[], root: string = ROOT): number {
  const check = argv.includes('--check');
  const previous = existingGeneratedAt(root);
  const current = fs.existsSync(path.join(root, OUTPUT)) ? fs.readFileSync(path.join(root, OUTPUT), 'utf8') : null;
  // generated_at is kept while nothing else changes, so a second run writes a byte-identical file.
  const keep = previous !== null ? serializeCalibration(computeCalibration(previous, root)) : null;
  if (check) {
    if (keep !== null && keep === current) {
      console.log(`[Language Calibration] ${OUTPUT} is up to date`);
      return 0;
    }
    console.error(`[Language Calibration] ${OUTPUT} differs from the tool output; run the tool without --check`);
    return 1;
  }
  const output = keep !== null && keep === current ? keep : serializeCalibration(computeCalibration(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), root));
  fs.mkdirSync(path.dirname(path.join(root, OUTPUT)), { recursive: true });
  fs.writeFileSync(path.join(root, OUTPUT), output);
  const calibration = JSON.parse(output) as LanguageConfidenceCalibration;
  const filled = calibration.bins.filter((bin) => bin.source === 'calibrated').length;
  console.log(`[Language Calibration] wrote ${OUTPUT}: ${filled} calibrated bins, ${calibration.bins.length - filled} mapped_fallback`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCalibrationTool(process.argv.slice(2));
}
