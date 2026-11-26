import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const lang = vi.hoisted(() => ({ current: 'en' }));
const panel = vi.hoisted(() => ({ setSources: vi.fn(), open: vi.fn() }));

vi.mock('zustand/react/shallow', () => ({ useShallow: <T,>(selector: T) => selector }));
vi.mock('@/lib/chat-store', () => {
  const state = { currentChatId: '22222222-2222-4222-8222-222222222222' };
  return { useChatStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('@/lib/stores/citation-focus-store', () => {
  const state = { focus: null, chatId: null, focusCitation: () => {}, clear: () => {}, syncChat: () => {} };
  return { useCitationFocusStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('@/components/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light' }) }));
vi.mock('@/components/providers/text-size-provider', () => ({ useTextSize: () => ({ textSize: 'default' }) }));
vi.mock('@/components/providers/font-provider', () => ({ useFont: () => ({ fontFamily: 'inter' }) }));
vi.mock('@/components/providers/artifact-provider', () => ({ useArtifact: () => ({ openArtifact: () => {} }) }));
vi.mock('@/components/providers/model-provider', () => ({ useModel: () => ({ selectedModel: 'test/model' }) }));
vi.mock('@/components/providers/language-provider', () => ({
  useLanguage: () => ({ language: lang.current, setLanguage: () => {}, t: (key: string) => key }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/components/ui/markdown', async () => {
  const { default: ReactMarkdown } = await import('react-markdown');
  return {
    Markdown: ({ children, components }: { children?: string; components?: Record<string, unknown> }) =>
      createElement(ReactMarkdown as never, { components }, children),
  };
});
vi.mock('@/components/providers/sources-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/providers/sources-provider')>();
  return {
    ...actual,
    useSources: () => ({
      sources: [],
      setSources: panel.setSources,
      isSourcesOpen: false,
      trackedSetIsSourcesOpen: panel.open,
      hasAvailableSources: false,
    }),
  };
});

const { ChatMessage } = await import('@/components/ui/chat-message');
const { RefusalFeedback } = await import('@/components/ui/refusal-feedback');
const { CitationChip } = await import('@/components/ui/citation-chip');
const { sourceOpenHandlers } = await import('@/components/ui/sources-sidebar');
const client = await import('@/lib/chat/refusal-feedback-client');
const { useGhostModeStore } = await import('@/lib/ghost-mode-store');
const { answerQualityStrings } = await import('@/translations/answer-quality');
type RefusalFeedbackValue = import('@/lib/chat/answer-metadata').RefusalFeedbackValue;

const TRACE = 'c'.repeat(32);
const AT = '2026-11-26T10:00:00.000Z';
const ghostInitial = useGhostModeStore.getInitialState();

function control(initial: RefusalFeedbackValue | null, traceId = TRACE): string {
  return renderToStaticMarkup(createElement(RefusalFeedback, { traceId, initial }) as ReactNode as never);
}

function message(metadata?: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(ChatMessage, {
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'The information is not available in the documents.',
        parts: [],
        ...(metadata ? { metadata } : {}),
      } as never,
      isLastMessage: true,
    }) as ReactNode as never,
  );
}

function findElement(node: unknown, match: (element: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<Record<string, unknown>>;
  if (match(element)) return element;
  return findElement(element.props.children, match);
}

function fakeEvent(extra: Record<string, unknown> = {}) {
  return { preventDefault: vi.fn(), stopPropagation: vi.fn(), button: 0, ...extra };
}

beforeEach(() => {
  lang.current = 'en';
  client.resetRefusalFeedbackSession();
  Object.assign(ghostInitial, { isGhostMode: false, ghostChatId: null });
  useGhostModeStore.setState({ isGhostMode: false, ghostChatId: null });
  panel.setSources.mockReset();
  panel.open.mockReset();
  vi.unstubAllGlobals();
});

describe('RefusalFeedback', () => {
  test('not voted: two outline choice buttons in a named group, no chips, a polite live region', () => {
    const html = control(null);
    expect(html).toContain('data-refusal-feedback');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Was This Refusal Right?"');
    expect(html).toContain('I Expected an Answer');
    expect(html).toContain('Correct, Not in My Documents');
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).not.toContain('<fieldset');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('focus-visible:ring-2');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<input');
  });

  test('voted expected_answer: that button pressed, legend and three chips, stored chips pressed', () => {
    const html = control({ vote: 'expected_answer', reasons: ['wrong_language'], at: AT });
    expect(html).toMatch(/aria-pressed="true"[^>]*>(<svg[\s\S]*?<\/svg>)?I Expected an Answer/);
    expect(html).toContain('<fieldset');
    expect(html).toContain('What Went Wrong? (Optional)');
    expect(html).toContain('The Answer Is in My Documents');
    expect(html).toContain('Wrong Language');
    expect(html).toContain('Other');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
  });

  test('voted correct_refusal: that button pressed, no chips', () => {
    const html = control({ vote: 'correct_refusal', reasons: [], at: AT });
    expect(html).toMatch(/aria-pressed="true"[^>]*>(<svg[\s\S]*?<\/svg>)?Correct, Not in My Documents/);
    expect(html).not.toContain('<fieldset');
  });

  test.each([
    ['zh', '这次拒答对吗？', '我认为应该有答案', '没错，我的文档里没有'],
    ['it', 'Questo rifiuto era giusto?', 'Mi aspettavo una risposta', 'Corretto, non è nei miei documenti'],
  ])('renders %s strings', (language, group, expected, correct) => {
    lang.current = language;
    const html = control(null);
    expect(html).toContain(group);
    expect(html).toContain(expected);
    expect(html).toContain(correct);
  });

  test('every locale has every refusal string', () => {
    for (const language of ['en', 'zh', 'it']) {
      const strings = answerQualityStrings(language);
      for (const value of [strings.refusalGroupLabel, strings.refusalExpectedAnswer, strings.refusalCorrect, strings.refusalFailed, strings.refusalRetry]) {
        expect(value.length).toBeGreaterThan(0);
      }
      expect(Object.keys(strings.refusalReasons).sort()).toEqual(['answer_exists', 'other', 'wrong_language']);
    }
  });

  test('renders nothing for a malformed trace id or a trace hidden by two 404s', async () => {
    expect(control(null, 'trace-1')).toBe('');
    const fetch = vi.fn(async () => new Response('{}', { status: 404 }));
    await client.postRefusalFeedback(TRACE, { vote: 'correct_refusal', reasons: [] }, { fetch, sleep: async () => {} });
    expect(control(null)).toBe('');
  });

  test('renders nothing in an incognito chat', () => {
    Object.assign(ghostInitial, { isGhostMode: true });
    expect(control(null)).toBe('');
  });
});

describe('ChatMessage refusal control', () => {
  test('a refusal with a trace id shows the control', () => {
    const html = message({ ragTraceId: TRACE, refusal: true });
    expect(html).toContain('data-refusal-feedback');
    expect(html).toContain('I Expected an Answer');
  });

  test('a stored vote is shown again after reload', () => {
    const html = message({ ragTraceId: TRACE, refusal: true, refusalFeedback: { vote: 'correct_refusal', reasons: [], at: AT } });
    expect(html).toMatch(/aria-pressed="true"[^>]*>(<svg[\s\S]*?<\/svg>)?Correct, Not in My Documents/);
  });

  test('messages without refusal metadata render exactly as before', () => {
    expect(message({ ragTraceId: TRACE })).not.toContain('data-refusal-feedback');
    expect(message()).not.toContain('data-refusal-feedback');
    expect(message({ ragTraceId: TRACE, refusal: true })).toContain('data-refusal-feedback');
    expect(message({ ragTraceId: 'not-a-trace', refusal: true })).not.toContain('data-refusal-feedback');
    expect(message({ ragTraceId: TRACE })).toBe(message({ ragTraceId: TRACE, refusal: false }));
  });

  test('an incognito chat never shows the control', () => {
    Object.assign(ghostInitial, { isGhostMode: true });
    expect(message({ ragTraceId: TRACE, refusal: true })).not.toContain('data-refusal-feedback');
  });
});

describe('source-open signal wiring', () => {
  function chip(messageId: string, n = 1) {
    const element = CitationChip({ n, messageId, buildSources: () => [] });
    const button = findElement(element, (e) => e.type === 'button');
    if (!button) throw new Error('no button');
    return button.props as { onClick: (event: unknown) => void; 'data-sources-toggle': string };
  }

  test('a citation chip of a traced message sends one signal per citation and still opens the panel', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    client.registerMessageTrace('m1', TRACE);
    const event = fakeEvent();
    chip('m1').onClick(event);
    chip('m1').onClick(fakeEvent());
    chip('m1', 2).onClick(fakeEvent());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe(`/api/rag/retrieval/${TRACE}/signal`);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(panel.open).toHaveBeenCalledTimes(3);
    expect(chip('m1')['data-sources-toggle']).toBe('true');
  });

  test('a chip of a message without a trace id never sends', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    chip('m-untraced').onClick(fakeEvent());
    expect(fetch).not.toHaveBeenCalled();
    expect(panel.open).toHaveBeenCalledTimes(1);
  });

  test('a failing signal is swallowed and the panel still opens', () => {
    vi.stubGlobal('fetch', vi.fn(() => {
      throw new Error('offline');
    }));
    client.registerMessageTrace('m1', TRACE);
    expect(() => chip('m1').onClick(fakeEvent())).not.toThrow();
    expect(panel.open).toHaveBeenCalledTimes(1);
  });

  test('a panel link sends once per source for the message that owns the panel, without changing navigation', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    client.registerMessageTrace('m1', TRACE);
    client.setSourcesMessage('m1');
    const handlers = sourceOpenHandlers({ title: 'Page', type: 'web', url: 'https://example.org/a', provider: 'Exa' });
    const click = fakeEvent();
    handlers.onClick(click as never);
    handlers.onClick(fakeEvent() as never);
    handlers.onAuxClick(fakeEvent({ button: 1 }) as never);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(click.stopPropagation).not.toHaveBeenCalled();
  });

  test('a right click on a panel link is not an open', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    client.registerMessageTrace('m1', TRACE);
    client.setSourcesMessage('m1');
    sourceOpenHandlers({ title: 'Page', type: 'web', url: 'https://example.org/b', provider: 'Exa' }).onAuxClick(fakeEvent({ button: 2 }) as never);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('nothing is sent in an incognito chat or without an owning message', () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    client.registerMessageTrace('m1', TRACE);
    sourceOpenHandlers({ title: 'Page', type: 'web', url: 'https://example.org/c', provider: 'Exa' }).onClick(fakeEvent() as never);
    client.setSourcesMessage('m1');
    useGhostModeStore.setState({ isGhostMode: true });
    sourceOpenHandlers({ title: 'Page', type: 'web', url: 'https://example.org/c', provider: 'Exa' }).onClick(fakeEvent() as never);
    chip('m1').onClick(fakeEvent());
    expect(fetch).not.toHaveBeenCalled();
  });
});
