import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// NF-1: shared links keep working without any anon or authenticated RLS path. The route and the page read one chat
// by share_id with the service-role client and return only the fields the shared view renders.

interface Recorded {
  table: string | null;
  columns: string | null;
  filters: Array<[string, unknown]>;
  terminal: string | null;
}

const h = vi.hoisted(() => ({
  recorded: { table: null, columns: null, filters: [], terminal: null } as Recorded,
  row: null as Record<string, unknown> | null,
  adminAvailable: true,
}));

function builder() {
  const result = async () => (h.row ? { data: h.row, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } });
  const chain = {
    select(columns: string) {
      h.recorded.columns = columns;
      return chain;
    },
    eq(column: string, value: unknown) {
      h.recorded.filters.push([column, value]);
      return chain;
    },
    single() {
      h.recorded.terminal = 'single';
      return result();
    },
    maybeSingle() {
      h.recorded.terminal = 'maybeSingle';
      return h.row ? Promise.resolve({ data: h.row, error: null }) : Promise.resolve({ data: null, error: null });
    },
  };
  return chain;
}

vi.mock('@/lib/supabase', () => ({
  getSupabaseAdmin: () =>
    h.adminAvailable
      ? {
          from(table: string) {
            h.recorded.table = table;
            return builder();
          },
        }
      : null,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    throw new Error('the shared-chat read must not use an anon or user client');
  },
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

vi.mock('@/app/shared/[shareId]/shared-chat-content', () => ({
  SharedChatContent: () => null,
}));

const SHARE_ID = '00000000-0000-4000-8000-000000000001';
const STORED_ROW = {
  title: 'Fixture chat',
  messages: [{ role: 'user', content: 'Synthetic question text.' }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

beforeEach(() => {
  h.recorded = { table: null, columns: null, filters: [], terminal: null };
  h.row = { ...STORED_ROW };
  h.adminAvailable = true;
});

async function callRoute(shareId: string) {
  const { GET } = await import('@/app/api/chats/[shareId]/route');
  return GET(new NextRequest(`http://localhost/api/chats/${shareId}`));
}

describe('GET /api/chats/[shareId]', () => {
  it('reads one shared chat by share_id with the service-role client and returns only the render fields', async () => {
    const response = await callRoute(SHARE_ID);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      chat: {
        title: STORED_ROW.title,
        messages: STORED_ROW.messages,
        createdAt: STORED_ROW.created_at,
        updatedAt: STORED_ROW.updated_at,
      },
    });
    expect(h.recorded.table).toBe('chats');
    expect(h.recorded.columns).toBe('title, messages, created_at, updated_at');
    expect(h.recorded.filters).toEqual([
      ['share_id', SHARE_ID],
      ['shared', true],
    ]);
  });

  it('answers 404 when no shared chat has that share_id', async () => {
    h.row = null;
    const response = await callRoute(SHARE_ID);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Chat not found' });
  });

  it('answers 500 without the service-role client instead of falling back to another client', async () => {
    h.adminAvailable = false;
    const response = await callRoute(SHARE_ID);
    expect(response.status).toBe(500);
  });
});

describe('/shared/[shareId] page', () => {
  it('renders the shared chat read by share_id with the service-role client', async () => {
    const { default: Page } = await import('@/app/shared/[shareId]/page');
    const element = (await Page({ params: Promise.resolve({ shareId: SHARE_ID }) })) as { props: { chat: Record<string, unknown> } };
    expect(element.props.chat).toEqual({ ...STORED_ROW });
    expect(h.recorded.table).toBe('chats');
    expect(h.recorded.columns).toBe('title, messages, created_at, updated_at');
    expect(h.recorded.filters).toEqual([
      ['share_id', SHARE_ID],
      ['shared', true],
    ]);
  });

  it('is not found when no shared chat has that share_id', async () => {
    h.row = null;
    const { default: Page } = await import('@/app/shared/[shareId]/page');
    await expect(Page({ params: Promise.resolve({ shareId: SHARE_ID }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
