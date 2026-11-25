import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@/components/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light' }) }));
vi.mock('@/components/providers/text-size-provider', () => ({ useTextSize: () => ({ textSize: 'default' }) }));
vi.mock('@/components/providers/font-provider', () => ({ useFont: () => ({ fontFamily: 'inter' }) }));
vi.mock('@/components/providers/artifact-provider', () => ({ useArtifact: () => ({ openArtifact: () => {} }) }));
vi.mock('@/components/providers/model-provider', () => ({ useModel: () => ({ selectedModel: 'test/model' }) }));
vi.mock('@/components/providers/language-provider', () => ({
  useLanguage: () => ({ language: 'en', setLanguage: () => {}, t: (key: string) => key }),
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
      setSources: () => {},
      isSourcesOpen: false,
      trackedSetIsSourcesOpen: () => {},
      hasAvailableSources: false,
    }),
  };
});

const { ChatMessage } = await import('@/components/ui/chat-message');

const BODY = 'The answer text.\n\n**Source:** Doc-A.pdf';
const TEXT = `${BODY}\n\n---\n↳ First question?\n↳ Second question?`;

function render(text: string, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ChatMessage as never, {
      message: { id: 'm-1', role: 'assistant', parts: [], content: [{ type: 'text', text }] },
      isLastMessage: true,
      onFollowupSelect: () => {},
      ...extra,
    }) as ReactNode as never,
  );
}

describe('ChatMessage related questions', () => {
  test('a completed answer renders its body and one button row per follow-up', () => {
    const html = render(TEXT);
    expect(html).toContain('data-related-questions');
    expect(html.match(/data-related-question=""/g)).toHaveLength(2);
    expect(html).toContain('First question?');
    expect(html).toContain('Second question?');
    expect(html).toContain('The answer text.');
    expect(html).not.toContain('↳');
    expect(html).not.toContain('<hr');
  });

  test('while streaming the text is not split', () => {
    const html = render(TEXT, { isStreaming: true });
    expect(html).not.toContain('data-related-questions');
    expect(html).toContain('↳ First question?');
  });

  test('the last message keeps the text unsplit while a response is in flight', () => {
    expect(render(TEXT, { followupsDisabled: true })).not.toContain('data-related-questions');
  });

  test('earlier answers show disabled rows while a response is in flight', () => {
    const html = render(TEXT, { isLastMessage: false, followupsDisabled: true });
    expect(html.match(/<button[^>]*disabled=""[^>]*data-related-question=""/g)).toHaveLength(2);
  });

  test('an answer without a tail renders no related list', () => {
    expect(render(BODY)).not.toContain('data-related-questions');
  });
});
