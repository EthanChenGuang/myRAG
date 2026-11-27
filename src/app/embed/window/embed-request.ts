import type { UIMessage } from 'ai';

/** D-22 wire shape; the embed route re-validates it with the generated RagTurnMetadata schema. */
export interface EmbedRagTurn {
  standaloneQuery: string;
  queryLanguage: string | null;
}

export interface EmbedRequestMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: { rag: EmbedRagTurn };
}

export interface EmbedRequestBody {
  messages: EmbedRequestMessage[];
  model: string;
  language?: string;
}

const STANDALONE_MAX = 1000;

// A light shape check keeps the generated contracts out of the embed bundle; the server is the authority
function ragOf(metadata: unknown): EmbedRagTurn | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const rag = (metadata as { rag?: unknown }).rag;
  if (!rag || typeof rag !== 'object' || Array.isArray(rag)) return undefined;
  const keys = Object.keys(rag).sort();
  if (keys.length !== 2 || keys[0] !== 'queryLanguage' || keys[1] !== 'standaloneQuery') return undefined;
  const { standaloneQuery, queryLanguage } = rag as Record<string, unknown>;
  if (typeof standaloneQuery !== 'string' || standaloneQuery.length === 0 || standaloneQuery.length > STANDALONE_MAX) return undefined;
  if (queryLanguage !== null && (typeof queryLanguage !== 'string' || queryLanguage.length === 0 || queryLanguage.length > 35)) return undefined;
  return { standaloneQuery, queryLanguage };
}

function primaryLanguage(locale: string | undefined): string | undefined {
  const primary = locale?.split(/[-_]/)[0]?.trim().toLowerCase();
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}

export function toEmbedRequestBody(messages: UIMessage[], model: string, locale?: string): EmbedRequestBody {
  const ragByUser = new Map<number, EmbedRagTurn>();
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.role === 'user') lastUser = index;
    else if (message.role === 'assistant' && lastUser >= 0) {
      const rag = ragOf(message.metadata);
      if (rag) ragByUser.set(lastUser, rag);
    }
  });
  const language = primaryLanguage(locale);
  return {
    messages: messages.map((message, index) => {
      const rag = ragByUser.get(index);
      return {
        role: message.role,
        content: message.parts
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join(''),
        ...(rag ? { metadata: { rag } } : {}),
      };
    }),
    model,
    ...(language ? { language } : {}),
  };
}
