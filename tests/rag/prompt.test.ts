import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnhancedRAGPrompt } from '@/lib/rag/generation/prompt';
import { knowledgeBaseUnavailableMessage } from '@/lib/rag/generation/messages';
import frozenCases from '../fixtures/characterization/prompt-builder.json';

type Mode = 'strict' | 'balanced' | 'flexible' | 'bypass';

// Outputs of the retired pre-pipeline builder, frozen before its module was deleted.
const FROZEN = frozenCases as Array<{ base: string; context: string; mode: string; output: string }>;

function frozenOutput(base: string, context: string, mode: string): string {
  const hit = FROZEN.find((entry) => entry.base === base && entry.context === context && entry.mode === mode);
  expect(hit, `no frozen output for mode ${mode}`).toBeTruthy();
  return (hit as { output: string }).output;
}

const BASE_PROMPTS: Array<[string, string]> = [
  ['with placeholder', 'You are a helpful assistant.\n\nContext:\n{{context}}'],
  ['without placeholder', 'You are a helpful assistant. Answer briefly.'],
  ['pre-context style', 'Company assistant for Acme.\n\nContext:\n{{context}}\n\nAlways answer in a friendly tone.'],
];

const CONTEXTS: Array<[string, string]> = [
  [
    'document context',
    '\n\n=== RELEVANT INFORMATION FROM DOCUMENTS ===\n\n--- Document: a.md (1 relevant chunks) ---\n\nBody text\n\n=== END OF RELEVANT INFORMATION ===\n',
  ],
  ['no-context text', 'No relevant context found.'],
];

const MODES: Mode[] = ['strict', 'balanced', 'flexible'];

describe('createEnhancedRAGPrompt (re-homed)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('has a frozen output for every matrix case', () => {
    expect(FROZEN).toHaveLength(BASE_PROMPTS.length * MODES.length * CONTEXTS.length + 2);
  });

  for (const [baseName, base] of BASE_PROMPTS) {
    for (const mode of MODES) {
      for (const [contextName, context] of CONTEXTS) {
        it(`matches the old output: ${baseName}, ${mode}, ${contextName}`, () => {
          const actual = createEnhancedRAGPrompt(base, context, mode);
          expect(actual).not.toBe('');
          expect(actual).toBe(frozenOutput(base, context, mode));
        });
      }
    }
  }

  it('returns the cleaned base prompt without RAG wrapping in bypass mode', () => {
    const base = 'You are a helpful assistant.\n\nContext:\n{{context}}';
    expect(createEnhancedRAGPrompt(base, 'CTX', 'bypass')).toBe(frozenOutput(base, 'CTX', 'bypass'));
    expect(createEnhancedRAGPrompt(base, 'CTX', 'bypass')).toBe('You are a helpful assistant.');
  });

  it('falls back to strict for an unknown mode', () => {
    const base = 'Base {{context}}';
    expect(createEnhancedRAGPrompt(base, 'CTX', 'nope' as Mode)).toBe(frozenOutput(base, 'CTX', 'nope'));
  });

  it('defaults to strict and leaves no {{context}} placeholder behind', () => {
    const output = createEnhancedRAGPrompt('Base {{context}}', 'CTX-BLOCK');
    expect(output).toContain('CTX-BLOCK');
    expect(output).not.toContain('{{context}}');
  });
});

describe('knowledgeBaseUnavailableMessage', () => {
  it('returns distinct non-empty zh, en, it and es texts', () => {
    const texts = (['zh', 'en', 'it', 'es'] as const).map((language) => knowledgeBaseUnavailableMessage(language));
    for (const text of texts) expect(text.length).toBeGreaterThan(0);
    expect(new Set(texts).size).toBe(4);
  });

  it('falls back to English for an unknown language', () => {
    expect(knowledgeBaseUnavailableMessage('xx')).toBe(knowledgeBaseUnavailableMessage('en'));
    expect(knowledgeBaseUnavailableMessage('xx')).not.toBe('');
  });
});
