import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BGE_M3_SIDECAR_REVISION } from '@/lib/rag/embeddings/bge-m3';

const DIR = path.join(process.cwd(), 'eval', 'fixtures', 'embeddings');
const TEXTS = path.join(DIR, 'bge-m3-texts.json');
const HOSTED = path.join(DIR, 'bge-m3-hosted.json');
const SIDECAR = path.join(DIR, 'bge-m3-sidecar.json');

const MIN_COSINE = 0.9999;
const MAX_COMPONENT_DIFF = 1e-3;
const DIMS = 1024;

interface Recording {
  model: string;
  revision: string;
  mode: string;
  dims: number;
  texts_sha256: string;
  vectors: Record<string, number[]>;
}

function loadRecording(file: string): Recording {
  return JSON.parse(readFileSync(file, 'utf8')) as Recording;
}

function fixtureIds(): string[] {
  const data = JSON.parse(readFileSync(TEXTS, 'utf8')) as { texts: { id: string }[] };
  return data.texts.map((entry) => entry.id).sort();
}

function l2(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error('zero or non-finite vector');
  return vector.map((x) => x / norm);
}

function compareVectors(a: number[], b: number[]): { cosine: number; maxDiff: number } {
  if (a.length !== b.length) throw new Error('vectors of different length');
  const ua = l2(a);
  const ub = l2(b);
  let cosine = 0;
  let maxDiff = 0;
  for (let i = 0; i < ua.length; i += 1) {
    cosine += ua[i] * ub[i];
    maxDiff = Math.max(maxDiff, Math.abs(ua[i] - ub[i]));
  }
  return { cosine, maxDiff };
}

function withinTolerance(cosine: number, maxDiff: number): boolean {
  return cosine >= MIN_COSINE && maxDiff <= MAX_COMPONENT_DIFF;
}

function syntheticUnitVector(seed: number): number[] {
  const out: number[] = [];
  let state = seed;
  for (let i = 0; i < DIMS; i += 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out.push(state / 2147483648 - 0.5);
  }
  return l2(out);
}

describe('BGE-M3 hosted and sidecar recordings are identical within the D-26 tolerance', () => {
  const hosted = loadRecording(HOSTED);
  const sidecar = loadRecording(SIDECAR);
  const ids = fixtureIds();

  it('records the pinned model, revision, modes and fixture text file', () => {
    for (const [recording, mode] of [
      [hosted, 'hosted'],
      [sidecar, 'sidecar'],
    ] as const) {
      expect(recording.model).toBe('BAAI/bge-m3');
      expect(recording.revision).toBe(BGE_M3_SIDECAR_REVISION);
      expect(recording.mode).toBe(mode);
      expect(recording.dims).toBe(DIMS);
      expect(recording.texts_sha256).toBe(createHash('sha256').update(readFileSync(TEXTS)).digest('hex'));
    }
  });

  it('covers every fixture text in both recordings', () => {
    expect(ids.length).toBeGreaterThan(0);
    expect(Object.keys(hosted.vectors).sort()).toEqual(ids);
    expect(Object.keys(sidecar.vectors).sort()).toEqual(ids);
  });

  it.each(fixtureIds())('%s: cosine >= 0.9999 and every component within 1e-3', (id) => {
    const a = hosted.vectors[id];
    const b = sidecar.vectors[id];
    expect(a).toHaveLength(DIMS);
    expect(b).toHaveLength(DIMS);
    const { cosine, maxDiff } = compareVectors(a, b);
    expect(cosine).toBeGreaterThanOrEqual(MIN_COSINE);
    expect(maxDiff).toBeLessThanOrEqual(MAX_COMPONENT_DIFF);
  });
});

describe('the D-26 comparison operators', () => {
  it('passes a pair exactly at the tolerance', () => {
    expect(withinTolerance(MIN_COSINE, MAX_COMPONENT_DIFF)).toBe(true);
  });

  it('fails a pair just beyond the tolerance', () => {
    expect(withinTolerance(0.99989999, MAX_COMPONENT_DIFF)).toBe(false);
    expect(withinTolerance(MIN_COSINE, 1.0000001e-3)).toBe(false);
  });

  it('accepts a synthetic pair with a small uniform drift', () => {
    const a = syntheticUnitVector(7);
    const b = a.map((x, i) => x + (i % 2 === 0 ? 1e-5 : -1e-5));
    const { cosine, maxDiff } = compareVectors(a, b);
    expect(withinTolerance(cosine, maxDiff)).toBe(true);
  });

  it('fails a synthetic pair with one component beyond 1e-3 even though the cosine is high', () => {
    const a = syntheticUnitVector(11);
    const b = [...a];
    b[3] += 2e-3;
    const { cosine, maxDiff } = compareVectors(a, b);
    expect(cosine).toBeGreaterThanOrEqual(MIN_COSINE);
    expect(maxDiff).toBeGreaterThan(MAX_COMPONENT_DIFF);
    expect(withinTolerance(cosine, maxDiff)).toBe(false);
  });
});
