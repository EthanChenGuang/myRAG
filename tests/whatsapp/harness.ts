/**
 * In-process WhatsApp harness: an in-memory store for the handler's tables, a fake WhatsApp client and session manager, and a fetch
 * that hands the handler's /api/chat request to a chat route POST in the same process. Framework-free, so vitest tests and the
 * node eval entry point share it. Placeholder JIDs and ids only.
 */

export const OWNER_ID = '00000000-0000-4000-8000-0000000000a1';
export const SESSION_A = 'wa-session-a';
export const SESSION_B = 'wa-session-b';
export const SENDER_A = '10000000001@s.whatsapp.net';
export const SENDER_B = '10000000002@s.whatsapp.net';
export const GROUP_JID = '10000000003-1600000000@g.us';

type Row = Record<string, unknown>;

export interface SentMessage {
  sessionId: string;
  to: string;
  text: string;
}

export interface ChatRequestRecord {
  body: Record<string, any>;
  status: number;
}

export type RoutePost = (request: Request) => Promise<Response>;

export interface WhatsAppHarness {
  tables: Record<string, Row[]>;
  sent: SentMessage[];
  chatRequests: ChatRequestRecord[];
  deps: {
    db: { from(table: string): any };
    sessionManager: { getSessionById(id: string): Promise<any>; updateSessionStatus(...args: unknown[]): Promise<void> };
    whatsappClient: any;
    fetch: typeof fetch;
  };
  /** The stored messages of the chat behind one owner and sender. */
  messagesOf(senderJid: string, ownerId?: string): Row[];
  reset(): void;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(6, '0')}`;
}

function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      tables[table] ??= [];
      const filters: Array<[string, unknown]> = [];
      let pending: { kind: 'update'; values: Row } | { kind: 'insert'; rows: Row[] } | null = null;
      const matches = () => tables[table].filter((row) => filters.every(([column, value]) => row[column] === value));
      const apply = (): { data: Row[]; error: null } => {
        if (pending?.kind === 'insert') {
          const inserted = pending.rows.map((row) => ({
            id: row.id ?? uuid(),
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            contact_name: null,
            ...clone(row),
          }));
          tables[table].push(...inserted);
          pending = null;
          return { data: inserted, error: null };
        }
        if (pending?.kind === 'update') {
          const values = clone(pending.values);
          const rows = matches();
          for (const row of rows) Object.assign(row, values);
          pending = null;
          return { data: rows, error: null };
        }
        return { data: matches().map(clone), error: null };
      };
      const builder: Record<string, any> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        update: (values: Row) => {
          pending = { kind: 'update', values };
          return builder;
        },
        insert: (rows: Row | Row[]) => {
          pending = { kind: 'insert', rows: Array.isArray(rows) ? rows : [rows] };
          return builder;
        },
        single: async () => {
          const { data } = apply();
          return data.length > 0 ? { data: clone(data[0]), error: null } : { data: null, error: { message: 'No rows found', code: 'PGRST116' } };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              const { error } = apply();
              return { data: null, error };
            })
            .then(resolve, reject),
      };
      return builder;
    },
  };
}

export function createWhatsAppHarness(options: { post: () => RoutePost | Promise<RoutePost>; sessions?: string[]; ownerId?: string }): WhatsAppHarness {
  const ownerId = options.ownerId ?? OWNER_ID;
  const sessionIds = new Set(options.sessions ?? [SESSION_A, SESSION_B]);
  const tables: Record<string, Row[]> = { chats: [], whatsapp_conversations: [], whatsapp_messages: [] };
  const sent: SentMessage[] = [];
  const chatRequests: ChatRequestRecord[] = [];

  const whatsappClient = {
    async sendTextMessage(sessionId: string, to: string, text: string) {
      sent.push({ sessionId, to, text });
      return { messageId: nextId('outgoing'), status: 'sent' };
    },
    async getSessionStatus() {
      return { isConnected: true };
    },
  };

  const sessionManager = {
    async getSessionById(id: string) {
      return sessionIds.has(id) ? { sessionId: id, userId: ownerId, status: 'connected' } : null;
    },
    async updateSessionStatus() {},
  };

  const injectedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/api/chat')) throw new Error(`[WhatsApp Harness] unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
    const post = await options.post();
    const response = await post(new Request('http://localhost/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    chatRequests.push({ body, status: response.status });
    return response;
  }) as typeof fetch;

  const db = createDb(tables);

  return {
    tables,
    sent,
    chatRequests,
    deps: { db, sessionManager, whatsappClient, fetch: injectedFetch },
    messagesOf(senderJid, owner = ownerId) {
      const conversation = tables.whatsapp_conversations.find((row) => row.whatsapp_jid === senderJid && row.user_id === owner);
      const chat = conversation ? tables.chats.find((row) => row.id === conversation.chat_id) : undefined;
      return (chat?.messages as Row[] | undefined) ?? [];
    },
    reset() {
      for (const name of Object.keys(tables)) tables[name].length = 0;
      sent.length = 0;
      chatRequests.length = 0;
    },
  };
}

/** A Baileys-shaped inbound text message from one sender on one session. */
export function inboundText(text: string, options: { sessionId?: string; from?: string } = {}) {
  return {
    event: 'message' as const,
    sessionId: options.sessionId ?? SESSION_A,
    timestamp: '2026-01-01T00:00:00.000Z',
    data: { from: options.from ?? SENDER_A, messageId: nextId('incoming'), message: { conversation: text } },
  };
}

/** Marks the harness-created chats with a set title, so the handler does not generate one. */
export function settleTitles(harness: WhatsAppHarness): void {
  for (const row of harness.tables.chats) if (row.title === 'New Chat') row.title = 'Synthetic chat';
}
