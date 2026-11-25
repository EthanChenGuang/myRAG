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

const HASH = 'b'.repeat(64);
const citation = (n: number, alias: string) => ({
  n,
  alias,
  chunkIds: [`c${n}`],
  documentId: `doc-${n}`,
  documentName: `Doc ${n}`,
  documentVersion: 1,
  page: null,
  quote: `Quote ${n}`,
  quoteHash: HASH,
  sectionPath: null,
  strategy: 'chunk-alias',
});

const TEXT = 'Paris [S1] is big [S2][S9]. See [docs](https://example.com/x).';

function render(message: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(ChatMessage as never, {
      message: { id: 'm-1', role: 'assistant', parts: [], content: [{ type: 'text', text: TEXT }], ...message },
      isLastMessage: false,
      ...extra,
    }) as ReactNode as never,
  );
}

describe('ChatMessage citation chips', () => {
  test('validated markers render as superscript chips, others are hidden, other links stay links', () => {
    const html = render({
      metadata: {
        answerId: '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f',
        citationStrategy: 'chunk-alias',
        citations: [citation(1, 'S1'), citation(2, 'S2')],
      },
    });
    expect(html).toContain('data-citation-chip="1"');
    expect(html).toContain('data-citation-chip="2"');
    expect(html).toContain('aria-label="Show source 1"');
    expect(html).toMatch(/<sup[^>]*><button/);
    expect(html).not.toContain('[S1]');
    expect(html).not.toContain('S9');
    expect(html).not.toContain('#cite-');
    expect(html).toContain('href="https://example.com/x"');
  });

  test('a citation-aware message that is still streaming shows no markers and no chips', () => {
    const html = render({ id: 'streaming', metadata: { answerId: '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f' } });
    expect(html).not.toContain('[S1]');
    expect(html).not.toContain('data-citation-chip');
    expect(html).toContain('Paris is big.');
  });

  test('a message without citation metadata renders its text as before', () => {
    const html = render({ metadata: { ragTraceId: 'trace-1' } });
    expect(html).toContain('[S1]');
    expect(html).toContain('[S2][S9]');
    expect(html).not.toContain('data-citation-chip');
  });

  test('a forged #cite- link for an alias that was not validated is not a chip', () => {
    const html = renderToStaticMarkup(
      createElement(ChatMessage as never, {
        message: {
          id: 'm-2',
          role: 'assistant',
          parts: [],
          content: [{ type: 'text', text: 'Claim [7](#cite-S7).' }],
          metadata: { citations: [citation(1, 'S1')] },
        },
      }) as never,
    );
    expect(html).not.toContain('data-citation-chip');
    expect(html).not.toContain('#cite-S7');
    expect(html).toContain('Claim');
  });
});
