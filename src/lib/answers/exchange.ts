export interface AnswerExchange {
  query: string;
  answer: string;
}

const MAX_TEXT_CHARS = 20_000;

function objectOr(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The text of a stored chat message: its string content, or its text parts joined. */
export function messageText(message: unknown): string {
  const value = objectOr(message);
  if (!value) return '';
  if (typeof value.content === 'string' && value.content.length > 0) return value.content.slice(0, MAX_TEXT_CHARS);
  if (!Array.isArray(value.parts)) return '';
  const texts: string[] = [];
  for (const part of value.parts) {
    const item = objectOr(part);
    if (item?.type === 'text' && typeof item.text === 'string') texts.push(item.text);
  }
  return texts.join('\n').slice(0, MAX_TEXT_CHARS);
}

/**
 * The assistant message whose metadata carries this answerId and the nearest user message before it, read from a
 * stored chats.messages array. Returns null when the answer is not in the array.
 */
export function exchangeForAnswer(messages: unknown, answerId: string): AnswerExchange | null {
  if (!Array.isArray(messages)) return null;
  const wanted = answerId.toLowerCase();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectOr(messages[index]);
    if (!message || message.role !== 'assistant') continue;
    const id = objectOr(message.metadata)?.answerId;
    if (typeof id !== 'string' || id.toLowerCase() !== wanted) continue;
    let query = '';
    for (let back = index - 1; back >= 0; back -= 1) {
      const previous = objectOr(messages[back]);
      if (previous?.role === 'user') {
        query = messageText(previous);
        break;
      }
    }
    return { query, answer: messageText(message) };
  }
  return null;
}

/** The tenant key of an answer record: s:default in single-tenant mode, o:<organization> or u:<user> in multi-tenant mode. */
export function recordTenantKey(row: { user_id: string; organization_id: string | null }, multiTenant: boolean): string {
  if (!multiTenant) return 's:default';
  return row.organization_id ? `o:${row.organization_id.toLowerCase()}` : `u:${row.user_id.toLowerCase()}`;
}

/** The snapshot quotes of the stored citations, in order. */
export function citedQuotesOf(citations: unknown): string[] {
  if (!Array.isArray(citations)) return [];
  const quotes: string[] = [];
  for (const citation of citations) {
    const quote = objectOr(citation)?.quote;
    if (typeof quote === 'string' && quote.length > 0) quotes.push(quote);
  }
  return quotes;
}
