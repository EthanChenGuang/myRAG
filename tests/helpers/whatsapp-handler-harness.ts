import { createUIMessageStreamResponse, streamText } from 'ai';
import { streamModelFromPieces } from './stream-model';

export const SESSION_ID = 'session-1';
export const USER_ID = 'user-1';
export const JID = '10000000000@s.whatsapp.net';
export const CHAT_ID = '00000000-0000-4000-8000-000000000001';

/** The response the chat route returns today: the real streamText UI message stream as an SSE body. */
export async function chatRouteSseBody(pieces: string[]): Promise<string> {
  const result = streamText({ model: streamModelFromPieces(pieces), prompt: 'synthetic question' });
  const response = createUIMessageStreamResponse({ stream: result.toUIMessageStream() });
  return response.text();
}

export interface AdminCall {
  table: string;
  op: string;
  args: unknown[];
}

/** A chainable stand-in for supabaseAdmin: one existing conversation, a chat with no messages and a set title. */
export function fakeSupabaseAdmin(calls: AdminCall[]) {
  const conversationRow = {
    id: 'conversation-1',
    chat_id: CHAT_ID,
    whatsapp_jid: JID,
    phone_number: '10000000000',
    contact_name: null,
    user_id: USER_ID,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  return {
    from(table: string) {
      const node: Record<string, unknown> = {};
      for (const op of ['select', 'update', 'insert', 'eq']) {
        node[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return node;
        };
      }
      const data = table === 'whatsapp_conversations' ? conversationRow : table === 'chats' ? { messages: [], title: 'Existing title' } : null;
      node.single = async () => ({ data, error: null });
      node.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null });
      return node;
    },
  };
}

export function messageWebhook(text: string) {
  return {
    event: 'message',
    sessionId: SESSION_ID,
    timestamp: '2026-01-01T00:00:00.000Z',
    data: { from: JID, messageId: 'incoming-1', message: { conversation: text } },
  };
}
