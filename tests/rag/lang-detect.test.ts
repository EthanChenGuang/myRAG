import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { detectLanguage, detectLanguageWithConfidence } from '@/lib/rag/lang/detect';
import { resetLanguageRegistryForTests, setLanguageRegistryForTests } from '@/lib/rag/lang/registry';

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

describe('detectLanguageWithConfidence reads the registry (03.2-10)', () => {
  const registryPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/rag/language-packs.json');
  const shipped = (): { packs: Array<{ code: string; stopwords: { detection: string[] } }> } =>
    JSON.parse(readFileSync(registryPath, 'utf8'));

  afterEach(() => resetLanguageRegistryForTests());

  it('takes its detection stopwords from the registry packs', () => {
    const neutral = 'alpha beta gamma';
    expect(detectLanguage(neutral)).toBeNull();
    const raw = shipped();
    const italian = raw.packs.find((pack) => pack.code === 'it')!;
    italian.stopwords.detection = [...italian.stopwords.detection, 'gamma'];
    setLanguageRegistryForTests(raw);
    expect(detectLanguageWithConfidence(neutral)).toEqual({ language: 'it', confident: true, confidence: 0.5 });
  });

  it('returns only registry languages: a pack removed from the registry is never detected', () => {
    const raw = shipped();
    raw.packs = raw.packs.filter((pack) => pack.code !== 'it');
    setLanguageRegistryForTests(raw);
    expect(detectLanguage('Il prodotto è disponibile')).toBeNull();
  });

  it('returns a single candidate at once with confidence 1, whatever the text', () => {
    expect(detectLanguageWithConfidence('本合同自双方签字盖章之日起生效。', ['en'])).toEqual({
      language: 'en',
      confident: true,
      confidence: 1,
    });
    expect(detectLanguageWithConfidence('', ['it', 'it'])).toEqual({ language: 'it', confident: true, confidence: 1 });
  });

  it('limits the answer to the candidates and ignores unknown codes', () => {
    expect(detectLanguage('Il prodotto è disponibile per il cliente', ['en', 'zh'])).toBeNull();
    expect(detectLanguageWithConfidence('the policy applies', ['xx'])).toEqual({ language: null, confident: false, confidence: 0 });
  });

  it('keeps the en/it tie answer with confidence 0', () => {
    expect(detectLanguageWithConfidence('the il')).toEqual({ language: 'en', confident: false, confidence: 0 });
  });
});
