import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectLanguageWithConfidence } from '@/lib/rag/lang/detect';

interface LangVector {
  name: string;
  text: string;
  candidates?: string[];
  language: string | null;
  confident: boolean;
  confidence: number;
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/ingest/lang-vectors.json', import.meta.url), 'utf8'),
) as { detector_version: number; vectors: LangVector[] };

describe('detectLanguage shared vectors (03.1-14, 03.2-10)', () => {
  it('pins at least thirty vectors, each with a confidence', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(30);
    for (const vector of fixture.vectors) expect(typeof vector.confidence, vector.name).toBe('number');
  });

  it.each(fixture.vectors)('$name matches the pinned language, confident flag and confidence', (vector) => {
    const result = detectLanguageWithConfidence(vector.text, vector.candidates);
    expect(result.language, `${vector.name} language`).toBe(vector.language);
    expect(result.confident, `${vector.name} confident`).toBe(vector.confident);
    expect(result.confidence, `${vector.name} confidence`).toBeCloseTo(vector.confidence, 4);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
