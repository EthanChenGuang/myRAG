import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  prepareToolCallForStorage,
  prepareToolResultForStorage,
  readToolCallInput,
  readToolResultIsError,
  readToolResultOutput,
  type LegacyToolCallPart,
  type LegacyToolResultPart,
} from '@/lib/chat-utils';
import { generateChatTitleFromToolCall } from '@/lib/chat-title-utils';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/supabase');
  vi.resetModules();
});

describe('tool call parts', () => {
  test('reads the v6 input field', () => {
    const part = { type: 'tool-call' as const, toolCallId: 'tc-1', toolName: 'search', input: { q: 'cats' } };
    expect(readToolCallInput(part)).toEqual({ q: 'cats' });
    const stored = prepareToolCallForStorage({ toolCall: part, initialExplanation: 'why' });
    expect(stored).toMatchObject({
      type: 'tool_call',
      toolCallId: 'tc-1',
      toolName: 'search',
      args: { q: 'cats' },
      proposalExplanation: 'why',
      isApproved: false,
    });
  });

  test('still reads the legacy args field of stored messages', () => {
    const part: LegacyToolCallPart = { type: 'tool-call', toolCallId: 'tc-2', toolName: 'search', args: { q: 'dogs' } };
    expect(readToolCallInput(part)).toEqual({ q: 'dogs' });
    expect(prepareToolCallForStorage({ toolCall: part }).args).toEqual({ q: 'dogs' });
  });

  test('falls back to an empty args object when neither field is present', () => {
    const part: LegacyToolCallPart = { type: 'tool-call', toolCallId: 'tc-3', toolName: 'search' };
    expect(prepareToolCallForStorage({ toolCall: part }).args).toEqual({});
  });

  test('builds the title from v6 input and from legacy args', () => {
    const v6 = generateChatTitleFromToolCall({
      type: 'tool-call',
      toolCallId: 'tc-4',
      toolName: 'gmail_find_email',
      input: { instructions: 'invoices from last month' },
    });
    const legacy = generateChatTitleFromToolCall({
      type: 'tool-call',
      toolCallId: 'tc-5',
      toolName: 'gmail_find_email',
      args: { instructions: 'invoices from last month' },
    });
    expect(v6).toBe('Email Search: invoices from last month');
    expect(legacy).toBe(v6);
  });
});

describe('tool result parts', () => {
  const call: LegacyToolCallPart = { type: 'tool-call', toolCallId: 'tc-9', toolName: 'search', args: {} };

  test('unwraps a v6 json output', () => {
    const part = {
      type: 'tool-result' as const,
      toolCallId: 'tc-9',
      toolName: 'search',
      output: { type: 'json' as const, value: { hits: 2 } },
    };
    expect(readToolResultOutput(part)).toEqual({ hits: 2 });
    expect(readToolResultIsError(part)).toBe(false);
    const stored = prepareToolResultForStorage({ toolCall: call, toolResult: part });
    expect(stored).toMatchObject({ type: 'tool_result', result: { hits: 2 }, isError: false, isApproved: true });
  });

  test('marks a v6 error output as an error', () => {
    const part = {
      type: 'tool-result' as const,
      toolCallId: 'tc-9',
      toolName: 'search',
      output: { type: 'error-text' as const, value: 'boom' },
    };
    expect(readToolResultIsError(part)).toBe(true);
    expect(prepareToolResultForStorage({ toolCall: call, toolResult: part })).toMatchObject({
      result: 'boom',
      isError: true,
      resultExplanation: 'boom',
    });
  });

  test('still reads the legacy result and isError fields of stored messages', () => {
    const part: LegacyToolResultPart = {
      type: 'tool-result',
      toolCallId: 'tc-9',
      toolName: 'search',
      result: { message: 'done' },
      isError: true,
      isApproved: false,
    };
    expect(readToolResultOutput(part)).toEqual({ message: 'done' });
    expect(prepareToolResultForStorage({ toolCall: call, toolResult: part })).toMatchObject({
      result: { message: 'done' },
      isError: true,
      isApproved: false,
      resultExplanation: 'done',
    });
  });

  test('a legacy part without isError is not an error', () => {
    const part: LegacyToolResultPart = { type: 'tool-result', toolCallId: 'tc-9', toolName: 'search', result: 'ok' };
    expect(readToolResultIsError(part)).toBe(false);
  });
});

describe('chat store folder moves', () => {
  async function loadStore(chats: Array<Record<string, unknown>>) {
    const query = {
      update: () => query,
      eq: () => query,
      then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
    };
    vi.doMock('@/lib/supabase', () => ({
      supabase: {
        auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
        from: () => query,
        rpc: async () => ({ data: null, error: null }),
      },
      supabaseAdmin: {},
    }));
    const { useChatStore } = await import('@/lib/chat-store');
    useChatStore.setState({ chats: chats as never });
    return useChatStore;
  }

  test('moveChatToFolder sets folder_id on the matching chat only', async () => {
    const store = await loadStore([
      { id: 'a', folder_id: null, title: 'A' },
      { id: 'b', folder_id: null, title: 'B' },
    ]);
    await store.getState().moveChatToFolder('a', 'folder-1');
    const chats = store.getState().chats;
    expect(chats.find((c) => c.id === 'a')?.folder_id).toBe('folder-1');
    expect(chats.find((c) => c.id === 'b')?.folder_id).toBeNull();
  });

  test('moveChatsToFolder moves several chats and can clear the folder with null', async () => {
    const store = await loadStore([
      { id: 'a', folder_id: 'folder-1', title: 'A' },
      { id: 'b', folder_id: 'folder-1', title: 'B' },
      { id: 'c', folder_id: 'folder-1', title: 'C' },
    ]);
    await store.getState().moveChatsToFolder(['a', 'b'], null);
    const byId = Object.fromEntries(store.getState().chats.map((c) => [c.id, c.folder_id]));
    expect(byId).toEqual({ a: null, b: null, c: 'folder-1' });
  });
});
