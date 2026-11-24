import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectLanguageWithConfidence } from '@/lib/rag/lang/detect';

interface LangVector {
  name: string;
  text: string;
  language: 'zh' | 'en' | 'it' | null;
  confident: boolean;
}

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/ingest/lang-vectors.json', import.meta.url), 'utf8'),
) as { detector_version: number; vectors: LangVector[] };

describe('detectLanguage shared vectors (03.1-14)', () => {
  it('pins at least thirty vectors', () => {
    expect(fixture.vectors.length).toBeGreaterThanOrEqual(30);
  });

  it.each(fixture.vectors)('$name matches the pinned language and confidence', (vector) => {
    const result = detectLanguageWithConfidence(vector.text);
    expect(result.language, `${vector.name} language`).toBe(vector.language);
    expect(result.confident, `${vector.name} confident`).toBe(vector.confident);
  });
});