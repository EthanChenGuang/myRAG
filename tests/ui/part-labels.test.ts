import { readFileSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';
import { partLabelOf } from '@/lib/chat/part-labels';

describe('partLabelOf', () => {
  test('matches the three registry labels exactly in every shipped language', () => {
    for (const [language, texts] of Object.entries(FIXED_TEXTS)) {
      for (const key of ['from_documents', 'from_web', 'general_knowledge'] as const) {
        const label = texts.labels[key];
        if (!label) continue;
        expect(partLabelOf(label), `${language}.${key}`).toEqual({ key, language });
      }
    }
  });

  test('a reworded, partial or other label is not a part label', () => {
    expect(partLabelOf(`${FIXED_TEXTS.en.labels.from_web}:`)).toBeNull();
    expect(partLabelOf('From the internet')).toBeNull();
    expect(partLabelOf(FIXED_TEXTS.en.labels.older_version!)).toBeNull();
    expect(partLabelOf('')).toBeNull();
    expect(partLabelOf(undefined)).toBeNull();
  });
});

describe('Markdown strong renderer', async () => {
  const { Markdown } = await import('@/components/ui/markdown');
  const md = (text: string) => renderToStaticMarkup(createElement(Markdown as never, { children: text } as never) as ReactNode as never);

  test('a bold registry label renders with its icon; a reworded one stays ordinary bold', () => {
    const html = md(`**${FIXED_TEXTS.it.labels.from_web}**\n\nA web part.`);
    expect(html).toMatch(/<strong><span data-part-label="from_web" class="inline-flex items-center gap-1"><svg[^>]*lucide-globe[^>]*aria-hidden="true"/);
    expect(html).toContain(FIXED_TEXTS.it.labels.from_web!);
    const plain = md('**From the internet**');
    expect(plain).toContain('<strong>From the internet</strong>');
    expect(plain).not.toContain('data-part-label');
  });
});

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
vi.mock('@/components/providers/sources-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/providers/sources-provider')>();
  return {
    ...actual,
    useSources: () => ({ sources: [], setSources: () => {}, isSourcesOpen: false, trackedSetIsSourcesOpen: () => {}, hasAvailableSources: false }),
  };
});

describe('ChatMessage part labels', async () => {
  const { ChatMessage } = await import('@/components/ui/chat-message');
  const render = (text: string) =>
    renderToStaticMarkup(
      createElement(ChatMessage as never, {
        message: { id: 'm-p', role: 'assistant', parts: [], content: [{ type: 'text', text }] },
        isLastMessage: false,
        isStreaming: false,
      }) as ReactNode as never,
    );

  test('a paragraph that is exactly a bold label renders a part label element with its icon', () => {
    const html = render(`**${FIXED_TEXTS.en.labels.from_documents}**\n\nA document part.\n\n**${FIXED_TEXTS.zh.labels.general_knowledge}**\n\nA general part.`);
    expect(html).toMatch(/<span data-part-label="from_documents"[^>]*><svg[^>]*lucide-file-text[^>]*aria-hidden="true"/);
    expect(html).toMatch(/<span data-part-label="general_knowledge"[^>]*lang="zh"[^>]*><svg[^>]*lucide-lightbulb/);
    expect(html).toContain(FIXED_TEXTS.en.labels.from_documents!);
  });

  test('a reworded label stays ordinary bold text', () => {
    const html = render('**From the internet**\n\nSome part.');
    expect(html).toContain('<strong>From the internet</strong>');
    expect(html).not.toContain('data-part-label');
  });

  test('the label paragraph does not go through a raw-HTML paragraph path', () => {
    const source = readFileSync('src/components/ui/chat-message.tsx', 'utf8');
    const start = source.indexOf('    p: ({ children }) =>');
    const end = source.indexOf('    a: ({ href, children }) => {');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const p = source.slice(start, end);
    expect(p).not.toContain('data-part-label');
    expect(p).not.toContain('dangerouslySetInnerHTML');
    expect(source).toMatch(/strong: \(\{ children \}\) =>/);
  });

  test('HTML entities in a plain paragraph render as text, never as elements', () => {
    const html = render('Hello &lt;img src=x onerror=alert(1)&gt; and &lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt; there');
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).not.toMatch(/<a\b[^>]*javascript/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  // PR #121 (fix(chat): render slashes in answers verbatim) removed the /mention highlight: the slash and the
  // name stay plain text, and the name is still escaped.
  test('a /mention renders verbatim and its name is escaped', () => {
    const html = render('See /report&lt;b&gt; here');
    expect(html).not.toContain('<b>');
    expect(html).toContain('/report');
    expect(html).not.toContain('text-[#FF6417]');
  });
});
