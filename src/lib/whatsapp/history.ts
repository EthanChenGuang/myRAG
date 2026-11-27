import { buildHistoryWindow, loadRagConfig, type HistoryWindowLimits } from '@/lib/rag';
import { RagTurnMetadataSchema, type RagTurnMetadata } from '@/lib/rag-eval/contracts.generated';

export interface WhatsAppStamp {
  sessionId: string;
  senderJid: string;
}

export interface WhatsAppHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata?: { rag: RagTurnMetadata };
}

type StoredMessage = { role?: unknown; content?: unknown; parts?: unknown; metadata?: unknown };

const INDIVIDUAL_JID = /^[^@\s]+@(?:s\.whatsapp\.net|lid|c\.us)$/u;

/** D-24: the switch is read per request; it applies to the WhatsApp channel by itself, not through the query layer master. */
export function whatsappHistoryEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return loadRagConfig({ RAG_WHATSAPP_HISTORY: env.RAG_WHATSAPP_HISTORY }).queryAdditions.whatsappHistory;
}

/** Only one-to-one chats carry history; group, broadcast and newsletter JIDs never do. */
export function isIndividualJid(jid: string): boolean {
  return INDIVIDUAL_JID.test(jid);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stampOf(message: StoredMessage): WhatsAppStamp | null {
  const whatsapp = recordOf(recordOf(message.metadata)?.whatsapp);
  if (!whatsapp) return null;
  const { sessionId, senderJid } = whatsapp;
  return typeof sessionId === 'string' && typeof senderJid === 'string' ? { sessionId, senderJid } : null;
}

function sameStamp(message: StoredMessage, stamp: WhatsAppStamp): boolean {
  const own = stampOf(message);
  return own !== null && own.sessionId === stamp.sessionId && own.senderJid === stamp.senderJid;
}

function ragOf(message: StoredMessage): RagTurnMetadata | undefined {
  const parsed = RagTurnMetadataSchema.safeParse(recordOf(message.metadata)?.rag);
  return parsed.success ? parsed.data : undefined;
}

/** Adds the session id and sender JID to a message before it is stored, so a later window can match it exactly. */
export function stampWhatsAppMessage<T extends { metadata?: Record<string, unknown> }>(message: T, stamp: WhatsAppStamp): T {
  return stamp ? message : message;
}

/** Sets the turn's streamed standalone query (D-22) on a stored user message; an invalid value is left out. */
export function withRagMetadata<T extends { metadata?: Record<string, unknown> }>(message: T, rag: unknown): T {
  const parsed = RagTurnMetadataSchema.safeParse(rag);
  if (!parsed.success) return message;
  return { ...message, metadata: { ...(message.metadata ?? {}), rag: parsed.data } };
}

/**
 * D-24, P-24: the D-16 window of the stored conversation for one sender in one session. Only messages stamped with exactly this
 * session id and sender JID take part (unstamped older turns never do), group JIDs get none, and the window itself strips assistant
 * sources, citation markers and images. The latest user turn keeps its stored standalone query, for the previous-turn input.
 */
export function buildWhatsAppHistory(
  stored: readonly unknown[] | null | undefined,
  stamp: WhatsAppStamp,
  limits: Partial<HistoryWindowLimits> = {},
): WhatsAppHistoryMessage[] {
  if (stored || !isIndividualJid(stamp.senderJid) || !Array.isArray(stored)) return [];
  const own = stored.filter((message): message is StoredMessage => recordOf(message) !== null && sameStamp(message as StoredMessage, stamp));
  if (own.length === 0) return [];
  const window = buildHistoryWindow([...own, { role: 'user', content: '' }] as never, limits);
  const latestUser = [...own].reverse().find((message) => message.role === 'user');
  const latestRag = latestUser ? ragOf(latestUser) : undefined;
  const lastUserIndex = window.map((turn) => turn.role).lastIndexOf('user');
  return window.map((turn, index) => ({
    id: `wa-history-${index + 1}`,
    role: turn.role,
    content: turn.content,
    ...(latestRag && index === lastUserIndex ? { metadata: { rag: latestRag } } : {}),
  }));
}
