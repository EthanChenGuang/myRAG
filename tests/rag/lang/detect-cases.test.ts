import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLanguageRegistry } from '@/lib/rag/lang/registry';
import { resolveQueryLanguage } from '@/lib/rag/lang/resolve-query-language';

interface DetectCase {
  id: string;
  kind: 'short' | 'accent_free' | 'mixed_script' | 'hint';
  text: string;
  enabled: string[];
  primary: string;
  previous_language: string | null;
  ui_language: string | null;
  expected_language: string;
  expected_source: string;
}

const CASES: DetectCase[] = readFileSync(join(process.cwd(), 'eval/fixtures/lang-detect/cases.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as DetectCase);

const PARAMS = JSON.parse(readFileSync(join(process.cwd(), 'eval/config/query-params.json'), 'utf8')) as {
  language_confidence_threshold: number;
  langid_timeout_ms: number;
};

describe('LANG-08 detection cases (D-18, P-31)', () => {
  it('cover short, accent-free and mixed-script cases, at least three each, in every fixture language', () => {
    const ids = new Set(CASES.map((item) => item.id));
    expect(ids.size).toBe(CASES.length);
    for (const pack of getLanguageRegistry().packs) {
      for (const kind of ['short', 'accent_free', 'mixed_script'] as const) {
        const count = CASES.filter((item) => item.kind === kind && item.expected_language === pack.code).length;
        expect(count, `${pack.code} ${kind}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it.each(CASES.map((item) => [item.id, item] as const))('%s resolves to its expected language and source', async (_id, item) => {
    const detection = await resolveQueryLanguage({
      text: item.text,
      enabled: item.enabled,
      primary: item.primary,
      previousTurnLanguage: item.previous_language,
      uiLanguage: item.ui_language,
      profile: 'chat',
      params: PARAMS,
    });
    expect({ language: detection.language, source: detection.source }).toEqual({
      language: item.expected_language,
      source: item.expected_source,
    });
    expect(detection.confidence).toBeGreaterThanOrEqual(0);
    expect(detection.confidence).toBeLessThanOrEqual(1);
  });
});
