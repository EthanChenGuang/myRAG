import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnhancedRAGPrompt } from '@/lib/rag/generation/prompt';
import { answerLanguageInstruction, contextLanguages } from '@/lib/rag/generation/answer-language';

type Mode = 'strict' | 'balanced' | 'flexible' | 'bypass';

const BASE = 'You are a helpful assistant.\n\nContext:\n{{context}}';
const CONTEXT = '\n\n=== RELEVANT INFORMATION FROM DOCUMENTS ===\n\nBody text\n\n=== END OF RELEVANT INFORMATION ===\n';
const MODES: Mode[] = ['strict', 'balanced', 'flexible', 'bypass'];

const ZH_TEXT = '这是一个用于测试的中性句子，没有任何特定的内容。';
const EN_TEXT = 'This is a neutral sentence for the test, and it has no specific content of the kind.';
const IT_TEXT = 'Questa è una frase neutra per il test, e non ha un contenuto della stessa natura.';

describe('createEnhancedRAGPrompt answer-language line (D-25)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('an en asker with zh-only context gets the en line at the end', () => {
    const base = createEnhancedRAGPrompt(BASE, CONTEXT, 'strict');
    const output = createEnhancedRAGPrompt(BASE, CONTEXT, 'strict', { answerLanguage: 'en', contextLanguages: ['zh'] });
    const line = answerLanguageInstruction({ answerLanguage: 'en', contextLanguages: ['zh'] });
    expect(line).toMatch(/English/);
    expect(output).toBe(`${base}\n\n${line}`);
  });

  it('an it asker with zh context gets the it line', () => {
    const output = createEnhancedRAGPrompt(BASE, CONTEXT, 'balanced', { answerLanguage: 'it', contextLanguages: ['zh'] });
    const line = answerLanguageInstruction({ answerLanguage: 'it', contextLanguages: ['zh'] });
    expect(line).toMatch(/italiano/);
    expect(output.endsWith(`\n\n${line}`)).toBe(true);
  });

  it('a zh asker with en context gets the zh line', () => {
    const output = createEnhancedRAGPrompt(BASE, CONTEXT, 'flexible', { answerLanguage: 'zh', contextLanguages: ['en'] });
    const line = answerLanguageInstruction({ answerLanguage: 'zh', contextLanguages: ['en'] });
    expect(line).toMatch(/中文/);
    expect(output.endsWith(`\n\n${line}`)).toBe(true);
  });

  it('a mixed context with one other language still adds the line', () => {
    expect(answerLanguageInstruction({ answerLanguage: 'en', contextLanguages: ['en', 'zh'] })).not.toBeNull();
  });

  it('is byte-identical when languages match, options are absent or the context has no language, in every mode', () => {
    for (const mode of MODES) {
      const today = createEnhancedRAGPrompt(BASE, CONTEXT, mode);
      expect(createEnhancedRAGPrompt(BASE, CONTEXT, mode, { answerLanguage: 'en', contextLanguages: ['en'] })).toBe(today);
      expect(createEnhancedRAGPrompt(BASE, CONTEXT, mode, undefined)).toBe(today);
      expect(createEnhancedRAGPrompt(BASE, CONTEXT, mode, { answerLanguage: 'en', contextLanguages: [] })).toBe(today);
      expect(createEnhancedRAGPrompt(BASE, CONTEXT, mode, { answerLanguage: null, contextLanguages: ['zh'] })).toBe(today);
    }
  });

  it('keeps the {{context}} substitution identical before the appended line', () => {
    for (const mode of ['strict', 'balanced', 'flexible'] as const) {
      const today = createEnhancedRAGPrompt(BASE, CONTEXT, mode);
      const output = createEnhancedRAGPrompt(BASE, CONTEXT, mode, { answerLanguage: 'en', contextLanguages: ['zh'] });
      expect(output.startsWith(today)).toBe(true);
      expect(output).toContain(CONTEXT);
      expect(output).not.toContain('{{context}}');
    }
  });

  it('treats region subtags as their primary language', () => {
    expect(answerLanguageInstruction({ answerLanguage: 'zh', contextLanguages: ['zh-Hans'] })).toBeNull();
    expect(answerLanguageInstruction({ answerLanguage: 'en', contextLanguages: ['zh-Hans'] })).not.toBeNull();
  });
});

describe('contextLanguages', () => {
  it('prefers the chunk language field over detection', () => {
    expect(contextLanguages([{ content: EN_TEXT, language: 'zh' }])).toEqual(['zh']);
  });

  it('takes the language of the same chunk among the candidates', () => {
    expect(contextLanguages([{ chunk_id: 'c1', content: EN_TEXT }], [{ chunk_id: 'c1', content: EN_TEXT, language: 'it' }])).toEqual(['it']);
  });

  it('falls back to the detector on the content, distinct and in order', () => {
    expect(contextLanguages([{ content: ZH_TEXT }, { content: EN_TEXT, language: null }, { content: IT_TEXT }, { content: ZH_TEXT }])).toEqual([
      'zh',
      'en',
      'it',
    ]);
  });

  it('skips chunks without language evidence', () => {
    expect(contextLanguages([{ content: '12345 ---' }])).toEqual([]);
  });
});
