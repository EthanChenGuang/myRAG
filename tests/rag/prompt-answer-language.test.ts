import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { createCitationSession, type ContextBlock } from '@/lib/rag';
import { createEnhancedRAGPrompt } from '@/lib/rag/generation/prompt';
import { answerLanguageInstruction, answerLanguageOptions, contextLanguages } from '@/lib/rag/generation/answer-language';
import { citationInstruction } from '@/lib/rag/generation/citations/instructions';
import { generateEvalAnswer, setEvalLanguageModelFactory } from '@/lib/rag-eval/answer';

type Mode = 'strict' | 'balanced' | 'flexible' | 'bypass';

const BASE = 'You are a helpful assistant.\n\nContext:\n{{context}}';
const CONTEXT = '\n\n=== RELEVANT INFORMATION FROM DOCUMENTS ===\n\nBody text\n\n=== END OF RELEVANT INFORMATION ===\n';
const MODES: Mode[] = ['strict', 'balanced', 'flexible', 'bypass'];

const ZH_TEXT = '这是一个用于测试的中性句子，没有任何特定的内容。';
const EN_TEXT = 'This is a neutral sentence for the test, and it has no specific content of the kind.';
const IT_TEXT = 'Questa è una frase neutra per il test, e non ha un contenuto della stessa natura.';

function block(alias: string, text: string): ContextBlock {
  return {
    documentId: `doc-${alias}`,
    documentName: 'sample.pdf',
    documentVersion: 1,
    chunkIds: [`chunk-${alias}`],
    page: null,
    sectionPath: null,
    title: 'sample.pdf',
    text,
    isImage: false,
    alias,
  };
}

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

describe('answerLanguageOptions', () => {
  it('is undefined without a query plan, so the routes pass nothing with the layer off', () => {
    expect(answerLanguageOptions({ kept: [{ chunk_id: 'c1', content: ZH_TEXT }], candidates: [] })).toBeUndefined();
    expect(answerLanguageOptions(null)).toBeUndefined();
  });

  it('takes the plan language and the kept chunks languages, the candidate field first', () => {
    const options = answerLanguageOptions({
      queryPlan: { language: 'en' },
      kept: [
        { chunk_id: 'c1', content: EN_TEXT },
        { chunk_id: 'c2', content: IT_TEXT },
      ],
      candidates: [{ chunk_id: 'c1', content: EN_TEXT, language: 'zh' }],
    });
    expect(options).toEqual({ answerLanguage: 'en', contextLanguages: ['zh', 'it'] });
  });
});

describe('answer-language line with the Phase 5 citation instruction', () => {
  function session() {
    const active = createCitationSession({
      capabilities: { citations: true },
      ragMode: 'strict',
      modelId: 'meta-llama/llama-3.3-70b-instruct',
      language: 'en',
      config: { citations: true },
    });
    active.attach({ blocks: [block('S1', EN_TEXT)] });
    return active;
  }

  it('sits before the citation instruction (chunk-alias)', () => {
    const active = session();
    expect(active.strategy).toBe('chunk-alias');
    const line = answerLanguageInstruction({ answerLanguage: 'en', contextLanguages: ['zh'] }) as string;
    const decorated = active.decorateSystemPrompt(
      createEnhancedRAGPrompt(BASE, CONTEXT, 'strict', { answerLanguage: 'en', contextLanguages: ['zh'] }),
    );
    expect(decorated.endsWith(`${line}\n\n${citationInstruction('en')}`)).toBe(true);
  });

  it('is byte-identical to the Phase 5 output when languages match', () => {
    const active = session();
    expect(
      active.decorateSystemPrompt(createEnhancedRAGPrompt(BASE, CONTEXT, 'strict', { answerLanguage: 'en', contextLanguages: ['en'] })),
    ).toBe(active.decorateSystemPrompt(createEnhancedRAGPrompt(BASE, CONTEXT, 'strict')));
  });
});

describe('eval answer generator', () => {
  function capturingModel(prompts: unknown[]) {
    return new MockLanguageModelV3({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        return {
          content: [{ type: 'text' as const, text: 'ANSWER' }],
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
  }

  async function systemFor(answerLanguage?: { answerLanguage: string; contextLanguages: string[] }): Promise<string> {
    const prompts: unknown[] = [];
    setEvalLanguageModelFactory(() => capturingModel(prompts));
    try {
      await generateEvalAnswer({
        query: 'Q',
        context: CONTEXT,
        ragMode: 'strict',
        generatorModel: 'meta-llama/llama-3.3-70b-instruct',
        promptEnv: {},
        decorateSystemPrompt: (prompt) => `${prompt}\n\nCITE`,
        ...(answerLanguage ? { answerLanguage } : {}),
      });
    } finally {
      setEvalLanguageModelFactory(null);
    }
    const messages = prompts[0] as Array<{ role: string; content: unknown }>;
    return messages.find((message) => message.role === 'system')?.content as string;
  }

  it('applies the options before the decoration and is unchanged without them', async () => {
    const line = answerLanguageInstruction({ answerLanguage: 'it', contextLanguages: ['zh'] }) as string;
    const plain = await systemFor();
    const withLine = await systemFor({ answerLanguage: 'it', contextLanguages: ['zh'] });
    expect(withLine).toBe(plain.replace(/\n\nCITE$/, `\n\n${line}\n\nCITE`));
    expect(await systemFor({ answerLanguage: 'it', contextLanguages: ['it'] })).toBe(plain);
  });
});
