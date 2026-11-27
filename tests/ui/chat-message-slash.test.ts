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


const PROD_TEXT = '在此之前，他主要使用C++（诺基亚时期）和PL/SQL（Oracle和电信计费系统时期）进行开发。';
const VARIANTS = [
  PROD_TEXT,
  'We use TCP/IP here.',
  'Pick one and/or both.',
  'Top speed 120 km/h.',
  'Run A/B testing weekly.',
  'Read https://example.com/docs/a/b for details',
  'Path /usr/local/bin is used.',
];

const CITATION = {
  n: 1,
  alias: 'S1',
  chunkIds: ['c1'],
  documentId: 'doc-1',
  documentName: 'Doc 1',
  documentVersion: 1,
  page: null,
  quote: 'Quote 1',
  quoteHash: 'b'.repeat(64),
  sectionPath: null,
  strategy: 'chunk-alias',
};

const STRATEGIES: Array<[string, Record<string, unknown> | undefined]> = [
  ['citation strategy on, no citations', { citationStrategy: 'chunk-alias', citations: [], invalidCitations: 0 }],
  ['citation strategy off', undefined],
];

function render(text: string, metadata?: Record<string, unknown>, role = 'assistant'): string {
  return renderToStaticMarkup(
    createElement(ChatMessage as never, {
      message: { id: 'm-slash', role, parts: [], content: [{ type: 'text', text }], ...(metadata ? { metadata } : {}) },
      isLastMessage: false,
    }) as ReactNode as never,
  );
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

describe('ChatMessage renders ordinary slashes verbatim', () => {
  for (const [label, metadata] of STRATEGIES) {
    for (const text of VARIANTS) {
      test(`${label}: ${text}`, () => {
        const html = render(text, metadata);
        expect(visibleText(html)).toContain(text.includes('https://') ? 'example.com/docs/a/b' : text);
        expect(html).not.toContain('#FF6417');
      });
    }
  }

  test('assistant text is never injected as raw HTML', () => {
    const html = render('a/b &lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('user messages keep slashes and are not coloured', () => {
    const html = render('What about PL/SQL @team?', undefined, 'user');
    expect(visibleText(html)).toContain('What about PL/SQL @team?');
    expect(html).not.toContain('#FF6417');
  });

  test('real markers still become chips and invalid markers stay hidden next to slashes', () => {
    const html = render('PL/SQL is used [S1] and TCP/IP [S7].', {
      answerId: '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f',
      citationStrategy: 'chunk-alias',
      citations: [CITATION],
    });
    expect(html).toContain('data-citation-chip="1"');
    expect(html).not.toContain('S7');
    expect(visibleText(html)).toContain('PL/SQL is used');
    expect(visibleText(html)).toContain('TCP/IP.');
  });
});
