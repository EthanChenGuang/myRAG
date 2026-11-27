import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCitationSession, createEnhancedRAGPrompt, type ContextBlock } from '@/lib/rag';
import { createMarkerParser, parseAnswerMarkers } from '@/lib/rag/generation/citations/marker-parser';
import { attachedDocumentsSentence, citationInstruction } from '@/lib/rag/generation/citations/instructions';
import { fixedText } from '@/lib/rag/lang/texts';

const ALIASES: ReadonlySet<string> = new Set(['S1', 'S2']);
const BASE_PROMPT = 'You are a helpful assistant.\n\nContext:\n{{context}}';

describe('createMarkerParser half-marker counter (D-33)', () => {
  it('counts a marker cut in half at finish() and never guesses it', () => {
    const parser = createMarkerParser({ aliases: ALIASES });
    parser.feed('t', 'Value is A [S1]. Value is B [S2');
    parser.feed('t', '');
    const result = parser.finish();
    expect(result.valid).toEqual(['S1']);
    expect(result.invalidCitations).toBe(0);
    expect(result.truncatedMarkers).toBe(1);
  });

  it('counts the bare opener prefix "[S" of a stream that stops there', () => {
    const parser = createMarkerParser({ aliases: ALIASES });
    for (const delta of ['Value is A [S1]. Next [', 'S']) parser.feed('t', delta);
    expect(parser.finish()).toEqual({ valid: ['S1'], invalidCitations: 0, invalidAliases: [], truncatedMarkers: 1 });
  });

  it('counts one held partial marker per text part, also when the part ends before finish()', () => {
    const parser = createMarkerParser({ aliases: ALIASES });
    parser.feed('a', 'First [S1] and [S');
    parser.end('a');
    parser.feed('b', 'Second 【S2');
    expect(parser.finish().truncatedMarkers).toBe(2);
    expect(parseAnswerMarkers('Cut here [S1', ALIASES).truncatedMarkers).toBe(1);
  });

  it('keeps every other result unchanged and adds no counter when nothing was cut', () => {
    expect(parseAnswerMarkers('A [S1]. B [S9]. C [x].', ALIASES)).toEqual({ valid: ['S1'], invalidCitations: 1, invalidAliases: ['S9'] });
    const parser = createMarkerParser({ aliases: ALIASES });
    parser.feed('t', 'Ends with a bracket [');
    parser.feed('t', 'not a marker]');
    expect(parser.finish()).toEqual({ valid: [], invalidCitations: 0, invalidAliases: [] });
  });

  it('returns the same counter on a repeated finish()', () => {
    const parser = createMarkerParser({ aliases: ALIASES });
    parser.feed('t', 'Text [S2');
    expect(parser.finish().truncatedMarkers).toBe(1);
    parser.feed('t', '] more [S');
    expect(parser.finish().truncatedMarkers).toBe(1);
  });
});

function block(alias: string, text: string): ContextBlock {
  return {
    documentId: `doc-${alias}`,
    documentName: 'notes.txt',
    documentVersion: 1,
    chunkIds: [`chunk-${alias}`],
    page: null,
    sectionPath: null,
    title: 'notes.txt',
    text,
    isImage: false,
    alias,
  };
}

describe('per-sentence citation instruction (D-20)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function aliasSession(language: string, perSentence?: boolean) {
    const session = createCitationSession({
      capabilities: { citations: true },
      ragMode: 'strict',
      modelId: 'meta-llama/llama-3.3-70b-instruct',
      language,
      config: { citations: true },
      ...(perSentence === undefined ? {} : { perSentence }),
    });
    session.attach({ blocks: [block('S1', 'Item A holds value one.'), block('S2', 'Item B holds value two.')] });
    return session;
  }

  it('off: the Phase 5 instruction is byte-identical in every language', () => {
    for (const language of ['en', 'zh', 'it']) {
      expect(aliasSession(language).decorateSystemPrompt('P')).toBe(`P\n\n${citationInstruction(language)}`);
      expect(aliasSession(language, false).decorateSystemPrompt('P')).toBe(`P\n\n${citationInstruction(language)}`);
    }
  });

  it('on: the per-sentence registry text takes the same position', () => {
    for (const language of ['en', 'zh', 'it']) {
      const text = fixedText('instructions.citation_per_sentence', language);
      expect(aliasSession(language, true).decorateSystemPrompt('P')).toBe(`P\n\n${text}`);
    }
  });

  it('reads RAG_CITATION_PER_SENTENCE when the input does not set it, off unless citations are on', () => {
    vi.stubEnv('RAG_CITATION_PER_SENTENCE', 'true');
    vi.stubEnv('RAG_CITATIONS', 'true');
    expect(aliasSession('en').decorateSystemPrompt('P')).toBe(`P\n\n${fixedText('instructions.citation_per_sentence', 'en')}`);
    vi.stubEnv('RAG_CITATIONS', 'false');
    vi.stubEnv('RAG_CLAUDE_CITATIONS', 'false');
    expect(aliasSession('en').decorateSystemPrompt('P')).toBe(`P\n\n${citationInstruction('en')}`);
  });

  describe('on the Claude Citations path', () => {
    const MODELS = JSON.stringify([{ id: 'anthropic/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5', anthropicId: 'claude-sonnet-5-5' }]);

    function claudeSession(perSentence: boolean, language = 'it') {
      vi.stubEnv('NEXT_PUBLIC_OPENROUTER_MODELS', MODELS);
      const session = createCitationSession({
        capabilities: { citations: true },
        ragMode: 'strict',
        modelId: 'anthropic/claude-sonnet-5.5',
        language,
        config: { citations: false, claudeCitations: true, anthropicApiKey: 'test-anthropic-key-placeholder' },
        facts: { mcp: false, multiStep: false, webSearch: false, reasoning: false },
        perSentence,
        contextTagging: false,
      });
      session.attach({ blocks: [block('S1', 'Item A holds value one.')], links: [] });
      expect(session.strategy).toBe('claude-citations');
      return session;
    }

    it('off: the Claude system text is unchanged', () => {
      expect(claudeSession(false).claudeSystemPrompt(BASE_PROMPT)).toBe(
        createEnhancedRAGPrompt(BASE_PROMPT, attachedDocumentsSentence('it'), 'strict'),
      );
    });

    it('on: the Claude system text asks to ground every factual sentence in the attached documents', () => {
      for (const language of ['en', 'zh', 'it']) {
        const off = claudeSession(false, language).claudeSystemPrompt(BASE_PROMPT);
        const on = claudeSession(true, language).claudeSystemPrompt(BASE_PROMPT);
        expect(on).toBe(`${off}\n\n${fixedText('instructions.grounding_per_sentence', language)}`);
      }
      expect(claudeSession(true).decorateSystemPrompt('P')).toBe(`P\n\n${fixedText('instructions.citation_per_sentence', 'it')}`);
    });
  });
});
