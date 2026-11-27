import { describe, expect, it } from 'vitest';
import {
  buildDecomposedAnswerBlock,
  uncoveredSubQuestions,
  type DecomposedAnswerBlockRef,
  type DecomposedAnswerInput,
} from '@/lib/rag/generation/decomposed-answer';
import { createEnhancedRAGPrompt } from '@/lib/rag/generation/prompt';
import { getLanguagePack } from '@/lib/rag/lang/registry';
import { fixedText } from '@/lib/rag/lang/texts';
import config from '../../config/rag/language-packs.json';
import sidecarConfig from '../../rag-sidecar/config/rag/language-packs.json';

const LANGUAGES = ['zh', 'en', 'it'] as const;
const KEYS = [
  'decomposed_answer_block_label',
  'decomposed_answer_intro',
  'decomposed_answer_parts',
  'decomposed_answer_cite_own',
  'decomposed_answer_compare_order',
] as const;

function text(language: string, key: (typeof KEYS)[number]): string {
  const value = getLanguagePack(language)?.texts.query_layer?.[key];
  expect(typeof value, `${language} ${key}`).toBe('string');
  return value as string;
}

const BLOCKS: DecomposedAnswerBlockRef[] = [
  { alias: 'S1', isImage: false, subQuestionIndexes: [0] },
  { alias: 'S2', isImage: false, subQuestionIndexes: [1] },
  { alias: null, isImage: true, subQuestionIndexes: [1] },
  { alias: 'S3', isImage: false, subQuestionIndexes: [0, 1] },
];

function input(over: Partial<DecomposedAnswerInput> = {}): DecomposedAnswerInput {
  return {
    subQuestions: ['What does the first part state?', 'What does the second part state?'],
    comparison: false,
    uncoveredIndexes: [],
    blocks: BLOCKS,
    language: 'en',
    citationsActive: true,
    ...over,
  };
}

describe('decomposed-answer texts (06.2 D-11)', () => {
  it('has every block text for zh, en and it, byte-equal in both pack copies', () => {
    for (const language of LANGUAGES) for (const key of KEYS) expect(text(language, key).length).toBeGreaterThan(0);
    expect(JSON.stringify(config)).toBe(JSON.stringify(sidecarConfig));
  });

  it('declares no placeholder in the block texts', () => {
    for (const language of LANGUAGES) for (const key of KEYS) expect(text(language, key)).not.toMatch(/\{[A-Za-z_]/);
  });
});

describe('buildDecomposedAnswerBlock (06.2 D-11, D-12)', () => {
  it('lists both sub-questions with the aliases of their blocks and the cite-own rule, in the request language', () => {
    for (const language of LANGUAGES) {
      const block = buildDecomposedAnswerBlock(input({ language }));
      expect(block, language).not.toBeNull();
      const sep = getLanguagePack(language)!.list_separator;
      const lines = block!.split('\n');
      expect(lines[0]).toBe(text(language, 'decomposed_answer_block_label'));
      expect(lines).toContain(text(language, 'decomposed_answer_intro'));
      expect(lines).toContain(`1. What does the first part state? [S1${sep}S3]`);
      expect(lines).toContain(`2. What does the second part state? [S2${sep}S3]`);
      expect(lines).toContain(text(language, 'decomposed_answer_parts'));
      expect(lines).toContain(text(language, 'decomposed_answer_cite_own'));
      expect(block).not.toContain(text(language, 'decomposed_answer_compare_order'));
    }
  });

  it('adds the comparison order only when R3 fired', () => {
    expect(buildDecomposedAnswerBlock(input({ comparison: true }))).toContain(text('en', 'decomposed_answer_compare_order'));
    expect(buildDecomposedAnswerBlock(input({ comparison: false }))).not.toContain(text('en', 'decomposed_answer_compare_order'));
  });

  it('names an uncovered sub-question with the GEN-08 text of the answer language', () => {
    for (const language of LANGUAGES) {
      const block = buildDecomposedAnswerBlock(input({ language, uncoveredIndexes: [1], blocks: BLOCKS.slice(0, 1) }))!;
      expect(block.split('\n')).toContain(`2. What does the second part state? “${fixedText('labels.not_covered', language)}”`);
      expect(block.split('\n')).toContain('1. What does the first part state? [S1]');
    }
  });

  it('lists sub-questions and uncovered ones without aliases or the cite-own rule when no labeller ran', () => {
    const unlabelled = BLOCKS.map((block) => ({ ...block, alias: null }));
    const block = buildDecomposedAnswerBlock(input({ citationsActive: false, blocks: unlabelled, uncoveredIndexes: [1] }))!;
    const lines = block.split('\n');
    expect(lines).toContain('1. What does the first part state?');
    expect(lines).toContain(`2. What does the second part state? “${fixedText('labels.not_covered', 'en')}”`);
    expect(block).not.toContain(text('en', 'decomposed_answer_cite_own'));
    expect(block).not.toMatch(/\[S\d/);
  });

  it('renders sub-question text as one data line each', () => {
    const block = buildDecomposedAnswerBlock(input({ subQuestions: ['first\n\nline  two', 'second'] }))!;
    expect(block.split('\n')).toContain('1. first line two [S1, S3]');
  });

  it('returns null for fewer than two sub-questions', () => {
    expect(buildDecomposedAnswerBlock(input({ subQuestions: ['only one'] }))).toBeNull();
    expect(buildDecomposedAnswerBlock(input({ subQuestions: [] }))).toBeNull();
  });

  it('finds sub-questions without a non-image block', () => {
    expect(uncoveredSubQuestions(3, BLOCKS)).toEqual([2]);
    expect(uncoveredSubQuestions(2, [{ alias: null, isImage: true, subQuestionIndexes: [1] }, BLOCKS[0]!])).toEqual([1]);
  });
});

describe('createEnhancedRAGPrompt with decomposedAnswer', () => {
  const base = 'You are a helpful assistant.\n\nContext:\n{{context}}';

  it('appends the block after the mode wrapper and the answer-language line', () => {
    const options = { answerLanguage: 'en', contextLanguages: ['it'] };
    const plain = createEnhancedRAGPrompt(base, 'CTX', 'strict', options);
    const block = buildDecomposedAnswerBlock(input())!;
    expect(createEnhancedRAGPrompt(base, 'CTX', 'strict', { ...options, decomposedAnswer: input() })).toBe(`${plain}\n\n${block}`);
    expect(createEnhancedRAGPrompt(base, 'CTX', 'balanced', { decomposedAnswer: input() })).toBe(
      `${createEnhancedRAGPrompt(base, 'CTX', 'balanced')}\n\n${block}`,
    );
  });

  it('is byte-identical when the question was not decomposed or the input is absent', () => {
    for (const mode of ['strict', 'balanced', 'flexible', 'bypass'] as const) {
      const plain = createEnhancedRAGPrompt(base, 'CTX $& $1', mode);
      expect(createEnhancedRAGPrompt(base, 'CTX $& $1', mode, {})).toBe(plain);
      expect(createEnhancedRAGPrompt(base, 'CTX $& $1', mode, { decomposedAnswer: input({ subQuestions: ['one'] }) })).toBe(plain);
    }
  });
});
