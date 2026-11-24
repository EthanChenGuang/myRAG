import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectLanguage } from '@/lib/rag/lang/detect';

const corpusRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eval/fixtures/corpus');

describe('detectLanguage fixture corpus', () => {
  for (const language of ['zh', 'en', 'it'] as const) {
    it(`detects every ${language} corpus document as ${language}`, () => {
      const dir = path.join(corpusRoot, language);
      const files = readdirSync(dir).filter((name) => name.endsWith('.md'));
      expect(files.length).toBeGreaterThan(0);
      for (const name of files) {
        expect(detectLanguage(readFileSync(path.join(dir, name), 'utf8')), name).toBe(language);
      }
    });
  }
});

describe('detectLanguage mixed and edge inputs', () => {
  it('treats mostly Chinese text with an English product name as zh', () => {
    expect(detectLanguage('请在使用前阅读 Acme Pro Max 的说明书，并联系售后部门办理保修。')).toBe('zh');
  });

  it('treats English text with one Italian word as en', () => {
    expect(detectLanguage('The refund will be issued to the original payment method within the stated period, grazie.')).toBe('en');
  });

  it('detects a short Italian sentence', () => {
    expect(detectLanguage('Il prodotto è disponibile')).toBe('it');
  });

  it('returns null for empty, whitespace-only and digits-only text', () => {
    expect(detectLanguage('')).toBeNull();
    expect(detectLanguage('   \n\t ')).toBeNull();
    expect(detectLanguage('2025-03-15 12345 / 6789')).toBeNull();
  });

  it('returns null when there is no stopword evidence', () => {
    expect(detectLanguage('XR-500B')).toBeNull();
  });

  it('stays fast on a 200 KB input', () => {
    const started = performance.now();
    expect(detectLanguage('the contract is valid '.repeat(10000))).toBe('en');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
