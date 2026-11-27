import { describe, expect, it } from 'vitest';
import { mayOfferCalc, shouldOfferCalcTool } from '@/lib/rag/calc/signal';
import { modelBlocksTools, turnCanUseTools } from '@/lib/rag/generation/tool-capability';
import { scanProtected, scanQuantities } from '@/lib/rag/query/protected';

describe('scanQuantities (D-70)', () => {
  it.each([
    ['The fee is $5 for the first row.', '$5'],
    ['The crate weighs 12 kg in total.', '12 kg'],
    ['A share of 30% applies.', '30%'],
    ['Effective from 2024-01-15 onward.', '2024-01-15'],
    ['Effective from 2024.01.15 onward.', '2024.01.15'],
    ['Take 42 of them.', '42'],
    ['Take 3.5 of them.', '3.5'],
    ['数量是１２个', '１２'],
    ['A is 12.', '12'],
  ])('finds a quantity in %j', (text, token) => {
    expect(scanQuantities(text)).toContain(token);
  });

  it.each([
    'What changed in v2.1?',
    'What changed in release 1.2.3?',
    'Where is the setting ABC12 described?',
    'Open the entry ID-42 please.',
    'Section Q3 of the synthetic form.',
    'No figures appear here.',
  ])('finds no quantity in %j', (text) => {
    expect(scanQuantities(text)).toEqual([]);
  });

  it('returns tokens in text order without duplicates', () => {
    expect(scanQuantities('Add 7 and 9, then 7 again.')).toEqual(['7', '9']);
  });

  it('leaves scanProtected unchanged', () => {
    expect(scanProtected('Take 42 of them in v2.1.')).toEqual({ tokens: ['v2.1'], hasExactCode: false, hasLiteral: true });
  });
});

describe('shouldOfferCalcTool (D-70)', () => {
  it('offers when the question carries a number', () => {
    expect(shouldOfferCalcTool({ question: 'What is A plus B if A is 12?', blockTexts: [], language: 'en' })).toEqual({
      offer: true,
      reason: 'question_quantity',
    });
  });

  it('offers when the question carries a date', () => {
    expect(shouldOfferCalcTool({ question: 'What applies after 2024-03-01?', blockTexts: [], language: 'en' }).offer).toBe(true);
  });

  it('counts full-width digits as a number', () => {
    expect(shouldOfferCalcTool({ question: '若Ａ为１２，结果是什么', blockTexts: [], language: 'zh' })).toEqual({
      offer: true,
      reason: 'question_quantity',
    });
  });

  it.each(['What changed in v2.1?', 'Where is the setting ABC12 described?'])('a version or code alone does not offer: %j', (question) => {
    expect(shouldOfferCalcTool({ question, blockTexts: ['The synthetic page lists 40 units.'], language: 'en' })).toEqual({
      offer: false,
      reason: null,
    });
  });

  it('an intent term without a number offers only when a block carries a quantity', () => {
    const question = 'What is the total for the listed items?';
    expect(shouldOfferCalcTool({ question, blockTexts: ['Each item is listed at 40 units.'], language: 'en' })).toEqual({
      offer: true,
      reason: 'intent_with_context_quantity',
    });
    expect(shouldOfferCalcTool({ question, blockTexts: ['The items are listed without figures.'], language: 'en' }).offer).toBe(false);
    expect(shouldOfferCalcTool({ question, blockTexts: ['Release v3.2 lists the items.'], language: 'en' }).offer).toBe(false);
    expect(shouldOfferCalcTool({ question, blockTexts: [], language: 'en' }).offer).toBe(false);
  });

  it('a question without number or intent term never offers, whatever the blocks hold', () => {
    expect(shouldOfferCalcTool({ question: 'Describe the listed items.', blockTexts: ['It lists 40 units.'], language: 'en' }).offer).toBe(false);
  });

  it('matches intent terms as whole words in space-separated scripts and case-folded', () => {
    expect(mayOfferCalc('Describe the summit performance report', 'en')).toBe(false);
    expect(mayOfferCalc('How do I reach the archive?', 'en')).toBe(false);
    expect(mayOfferCalc('What is the TOTAL of the items?', 'en')).toBe(true);
    expect(mayOfferCalc('How many items remain?', 'en')).toBe(true);
    expect(mayOfferCalc('Qual è la somma delle voci?', 'it')).toBe(true);
    expect(mayOfferCalc('Qual è il sommario delle voci?', 'it')).toBe(false);
  });

  it('matches CJK intent terms as substrings', () => {
    expect(mayOfferCalc('这些项目一共有几项', 'zh')).toBe(true);
    expect(mayOfferCalc('请介绍这些项目', 'zh')).toBe(false);
  });

  it('falls back to the registry fallback languages for an unknown or missing language', () => {
    expect(mayOfferCalc('What is the total?', null)).toBe(true);
    expect(mayOfferCalc('What is the total?', 'xx')).toBe(true);
  });

  const QUESTIONS = [
    'What is A plus B if A is 12?',
    'What is the total for the listed items?',
    'Describe the listed items.',
    'What changed in v2.1?',
    '这些项目一共有几项',
    'Qual è la somma delle voci?',
    '若Ａ为１２，结果是什么',
    'Where is the setting ABC12 described?',
  ];
  const BLOCK_SETS = [[], ['It lists 40 units.'], ['No figures.'], ['Release v3.2.']];
  const LANGUAGES = ['en', 'zh', 'it', null];

  it('mayOfferCalc is a superset of shouldOfferCalcTool', () => {
    for (const question of QUESTIONS) {
      for (const language of LANGUAGES) {
        for (const blockTexts of BLOCK_SETS) {
          if (shouldOfferCalcTool({ question, blockTexts, language }).offer) expect(mayOfferCalc(question, language)).toBe(true);
        }
      }
    }
    expect(QUESTIONS.some((question) => mayOfferCalc(question, 'en'))).toBe(true);
  });
});

describe('turnCanUseTools (D-70, D-72)', () => {
  it.each([
    [{ provider: 'openrouter', modelId: 'openai/gpt-4.1' }, true],
    [{ provider: 'openai', modelId: 'gpt-4.1-mini' }, true],
    [{ provider: 'groq', modelId: 'llama-3.3-70b-versatile' }, true],
    [{ provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' }, false],
    [{ provider: 'openrouter', modelId: 'anthropic/claude-sonnet-4' }, false],
    [{ provider: 'openrouter', modelId: 'claude-4-sonnet' }, false],
    [{ provider: 'anthropic', modelId: 'openai/gpt-4.1' }, false],
    [{ provider: undefined, modelId: 'openai/gpt-4.1' }, false],
  ])('%j → %s', (input, expected) => {
    expect(turnCanUseTools(input)).toBe(expected);
  });

  it('modelBlocksTools mirrors the route rule for the three claude-sonnet-4 id forms', () => {
    expect(modelBlocksTools('anthropic/claude-sonnet-4')).toBe(true);
    expect(modelBlocksTools('claude-sonnet-4-20250514')).toBe(true);
    expect(modelBlocksTools('claude-4-sonnet')).toBe(true);
    expect(modelBlocksTools('anthropic/claude-opus-4')).toBe(false);
  });
});
