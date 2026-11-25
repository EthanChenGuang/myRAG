import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnhancedRAGPrompt, createCitationSession, type ContextBlock } from '@/lib/rag';
import { attachedDocumentsSentence, citationInstruction } from '@/lib/rag/generation/citations/instructions';

const BASE_PROMPT = 'You are a helpful assistant.\n\nContext:\n{{context}}';

function block(alias: string | null, text: string, overrides: Partial<ContextBlock> = {}): ContextBlock {
  return {
    documentId: `doc-${alias ?? 'img'}`,
    documentName: 'policy.pdf',
    documentVersion: 1,
    chunkIds: [`chunk-${alias ?? 'img'}`],
    page: null,
    sectionPath: null,
    title: 'policy.pdf',
    text,
    isImage: false,
    alias,
    ...overrides,
  };
}

function activeSession(ragMode: 'strict' | 'balanced' | 'flexible' | 'bypass' = 'strict', language = 'en') {
  const session = createCitationSession({
    capabilities: { citations: true },
    ragMode,
    modelId: 'meta-llama/llama-3.3-70b-instruct',
    language,
    config: { citations: true },
  });
  session.attach({ blocks: [block('S1', 'Refunds within 30 days.'), block('S2', 'Annual plans renew yearly.')] });
  return session;
}

describe('citation instructions', () => {
  it('has three different localized instructions that name the [S<number>] markers', () => {
    const texts = ['zh', 'en', 'it'].map(citationInstruction);
    expect(new Set(texts).size).toBe(3);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(20);
      expect(text).toContain('[S<');
    }
  });

  it('falls back to English for other languages and inherited keys', () => {
    expect(citationInstruction('fr')).toBe(citationInstruction('en'));
    expect(citationInstruction('toString')).toBe(citationInstruction('en'));
  });

  it('has three localized attached-documents sentences with an English fallback', () => {
    const texts = ['zh', 'en', 'it'].map(attachedDocumentsSentence);
    expect(new Set(texts).size).toBe(3);
    for (const text of texts) expect(text.length).toBeGreaterThan(10);
    expect(attachedDocumentsSentence('fr')).toBe(attachedDocumentsSentence('en'));
  });
});

describe('createCitationSession', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('appends the localized instruction after the substituted context and leaves the rest unchanged', () => {
    for (const language of ['en', 'zh', 'it']) {
      const session = activeSession('strict', language);
      const base = createEnhancedRAGPrompt(BASE_PROMPT, '[S1] policy.pdf\nRefunds within 30 days.', 'strict');
      const decorated = session.decorateSystemPrompt(base);
      expect(decorated.startsWith(base)).toBe(true);
      expect(decorated.slice(base.length)).toBe(`\n\n${citationInstruction(language)}`);
    }
  });

  it('appends nothing in bypass mode and has no labeler', () => {
    const session = activeSession('bypass');
    expect(session.labeler).toBeUndefined();
    expect(session.strategy).toBeNull();
    expect(session.decorateSystemPrompt('prompt')).toBe('prompt');
    expect(session.finishMetadata()).toEqual({});
  });

  it('is inactive without the switch, without the capability or without aliased blocks', () => {
    const cases = [
      createCitationSession({ capabilities: { citations: true }, ragMode: 'strict', modelId: 'm', language: 'en', config: { citations: false } }),
      createCitationSession({ capabilities: null, ragMode: 'strict', modelId: 'm', language: 'en', config: { citations: true } }),
      createCitationSession({ capabilities: { citations: false }, ragMode: 'strict', modelId: 'm', language: 'en', config: { citations: true } }),
    ];
    for (const session of cases) {
      session.attach({ blocks: [block('S1', 'x')] });
      expect(session.labeler).toBeUndefined();
      expect(session.strategy).toBeNull();
      expect(session.transforms()).toEqual([]);
    }
    const noBlocks = createCitationSession({ capabilities: { citations: true }, ragMode: 'strict', modelId: 'm', language: 'en', config: { citations: true } });
    noBlocks.attach({ blocks: [block(null, 'image caption', { isImage: true })] });
    expect(noBlocks.labeler).toBeDefined();
    expect(noBlocks.strategy).toBeNull();
    expect(noBlocks.decorateSystemPrompt('p')).toBe('p');
  });

  it('labels blocks with the alias header and neutralized text', () => {
    const session = activeSession();
    const label = session.labeler?.(
      { ...block(null, 'Cite [S7] here'), title: 'policy.pdf, p.2' },
      3,
    );
    expect(label?.alias).toBe('S3');
    expect(label?.header).toBe('[S3] policy.pdf, p.2');
    expect(label?.text).not.toContain('[S7]');
  });

  it('strips markers from prior assistant turns only when active', () => {
    const history = [
      { role: 'user' as const, content: 'What about [S1] refunds?' },
      { role: 'assistant' as const, content: 'Refunds take 30 days [S2].' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'See [S1][S3] for details.' }] },
      { role: 'user' as const, content: 'And annual plans [S2]?' },
    ];
    const stripped = activeSession().stripHistory(history);
    expect(stripped[0]).toBe(history[0]);
    expect(stripped[3]).toBe(history[3]);
    expect(stripped[1].content).toBe('Refunds take 30 days.');
    expect(stripped[2].content).toEqual([{ type: 'text', text: 'See for details.' }]);
    expect(history[1].content).toBe('Refunds take 30 days [S2].');

    const inactive = createCitationSession({ capabilities: null, ragMode: 'strict', modelId: 'm', language: 'en', config: { citations: true } });
    expect(inactive.stripHistory(history)).toBe(history);
  });

  it('rejects blocks whose aliases do not run S1..Sn and stays inactive', () => {
    const session = createCitationSession({ capabilities: { citations: true }, ragMode: 'strict', modelId: 'm', language: 'en', config: { citations: true } });
    session.attach({ blocks: [block('S2', 'x')] });
    expect(session.strategy).toBeNull();
  });
});

describe('createCitationSession on a Claude Citations turn', () => {
  const MODELS = JSON.stringify([{ id: 'anthropic/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5', anthropicId: 'claude-sonnet-5-5' }]);
  const facts = { mcp: false, multiStep: false, webSearch: false, reasoning: false };
  const config = { citations: false, claudeCitations: true, anthropicApiKey: 'test-anthropic-key-placeholder' };

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_OPENROUTER_MODELS', MODELS);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function claudeSession() {
    const session = createCitationSession({
      capabilities: { citations: true },
      ragMode: 'strict',
      modelId: 'anthropic/claude-sonnet-5.5',
      language: 'it',
      config,
      facts,
    });
    session.attach({
      blocks: [
        block('S1', 'Refunds within 30 days.'),
        block(null, 'Caption: aisle 7 holds probes.', { isImage: true }),
        block('S2', 'Annual plans renew yearly.'),
      ],
      links: [],
    });
    return session;
  }

  it('labels the blocks with RAG_CITATIONS off and picks claude-citations', () => {
    const session = claudeSession();
    expect(session.labeler).toBeDefined();
    expect(session.strategy).toBe('claude-citations');
    expect(session.transforms()).toEqual([]);
  });

  it('builds the system text from the attached-documents sentence and the image captions, never the block text', () => {
    const system = claudeSession().claudeSystemPrompt(BASE_PROMPT);
    expect(system).toBe(
      createEnhancedRAGPrompt(BASE_PROMPT, `${attachedDocumentsSentence('it')}\n\nCaption: aisle 7 holds probes.`, 'strict'),
    );
    expect(system).not.toContain('Refunds within 30 days.');
  });

  it('decorates the OpenRouter prompt with the alias instruction, because it is the fallback prompt', () => {
    expect(claudeSession().decorateSystemPrompt('P')).toBe(`P\n\n${citationInstruction('it')}`);
  });

  it('falls back once to chunk-alias and records the reason', () => {
    const session = claudeSession();
    expect(session.finishMetadata()).toEqual({ citations: [], citationStrategy: 'claude-citations', invalidCitations: 0 });
    session.fallback('status_429');
    expect(session.strategy).toBe('chunk-alias');
    expect(session.fallbackReason).toBe('status_429');
    expect(session.transforms()).toHaveLength(1);
    session.fallback('timeout');
    expect(session.fallbackReason).toBe('status_429');
  });

  it('refuses to start the direct call on any other strategy', () => {
    const session = claudeSession();
    session.fallback('error');
    expect(() =>
      session.startClaude({
        system: 's',
        history: [],
        question: 'q',
        reasoning: false,
        abortSignal: new AbortController().signal,
        onError: () => {},
      }),
    ).toThrow();
  });

  it('never picks claude-citations without the turn facts', () => {
    const session = createCitationSession({
      capabilities: { citations: true },
      ragMode: 'strict',
      modelId: 'anthropic/claude-sonnet-5.5',
      language: 'en',
      config: { ...config, citations: true },
    });
    session.attach({ blocks: [block('S1', 'x')] });
    expect(session.strategy).toBe('chunk-alias');
  });
});
