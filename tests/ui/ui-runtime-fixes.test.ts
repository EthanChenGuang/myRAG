import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getSession: vi.fn(async () => ({ data: { session: null } })),
  createClient: vi.fn(),
  sharedChat: { title: null as string | null, messages: null as unknown },
}));

vi.mock('@/lib/supabase/client', () => {
  h.createClient.mockImplementation(() => ({ auth: { getSession: h.getSession } }));
  return { createClient: h.createClient };
});

vi.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children?: string }) => createElement('div', null, children),
}));
vi.mock('@/components/ui/stream-processor', () => ({
  StreamProcessor: () => createElement('div', null, 'stream'),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                title: h.sharedChat.title,
                messages: h.sharedChat.messages,
                created_at: '2025-01-01T00:00:00Z',
                updated_at: '2025-01-01T00:00:00Z',
              },
              error: null,
            }),
          }),
        }),
      }),
    }),
  }),
}));
vi.mock('@/app/shared/[shareId]/shared-chat-content', () => ({
  SharedChatContent: () => null,
}));

beforeEach(() => {
  h.getSession.mockClear();
  h.createClient.mockClear();
  h.sharedChat.title = null;
  h.sharedChat.messages = null;
});

describe('streaming-markdown hook imports', () => {
  it('renders without a ReferenceError for useState and useEffect', async () => {
    const { StreamingMarkdown } = await import('@/components/ui/streaming-markdown');
    const { TextSizeProvider } = await import('@/components/providers/text-size-provider');
    const { FontProvider } = await import('@/components/providers/font-provider');

    const render = () =>
      renderToString(
        createElement(
          TextSizeProvider,
          null,
          createElement(FontProvider, null, createElement(StreamingMarkdown, null, 'hello world')),
        ),
      );

    expect(render).not.toThrow();
    expect(render()).toContain('hello world');
  });
});

describe('useShareChat supabase client', () => {
  it('obtains the session from the browser client factory', async () => {
    const { useShareChat } = await import('@/hooks/useShareChat');
    let api: ReturnType<typeof useShareChat> | undefined;
    const Probe = () => {
      api = useShareChat();
      return null;
    };
    renderToString(createElement(Probe));

    await expect(api!.shareChat('chat-1')).rejects.toThrow('You must be logged in to share a chat');
    expect(h.createClient).toHaveBeenCalled();
    expect(h.getSession).toHaveBeenCalledTimes(1);
  });
});

describe('shared chat page title fallback', () => {
  it('passes a string title when the stored title is null', async () => {
    const { default: Page } = await import('@/app/shared/[shareId]/page');
    const element = (await Page({ params: Promise.resolve({ shareId: 'abc' }) })) as {
      props: { chat: { title: unknown; messages: unknown } };
    };
    expect(element.props.chat.title).toBe('Shared Chat');
    expect(element.props.chat.messages).toEqual([]);
  });

  it('keeps a stored title unchanged', async () => {
    h.sharedChat.title = 'My chat';
    const { default: Page } = await import('@/app/shared/[shareId]/page');
    const element = (await Page({ params: Promise.resolve({ shareId: 'abc' }) })) as {
      props: { chat: { title: unknown } };
    };
    expect(element.props.chat.title).toBe('My chat');
  });
});
