const IN_FLIGHT_IDS = new Set(['streaming', 'thinking']);

/** True when every part of the content is text and all of it is blank; images, tool results and other parts count as content. */
export function isBlankContent(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === 'string') return content.trim().length === 0;
  if (!Array.isArray(content)) return false;
  return content.every(
    (part) =>
      part &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type === 'text' &&
      (typeof (part as { text?: unknown }).text !== 'string' || ((part as { text: string }).text.trim().length === 0)),
  );
}

/** A finished assistant message with nothing to show; the thinking and streaming placeholders are never blank. */
export function isBlankAssistantMessage(message: { id?: string; role?: string; content?: unknown }): boolean {
  if (message.role !== 'assistant') return false;
  if (message.id && IN_FLIGHT_IDS.has(message.id)) return false;
  return isBlankContent(message.content);
}
