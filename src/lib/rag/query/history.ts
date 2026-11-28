import type { HistoryTurn } from '../types';

export interface HistoryWindowLimits {
  turns: number;
  chars: number;
}

const DEFAULT_LIMITS: HistoryWindowLimits = { turns: 6, chars: 1000 };

const TEXT_PART_TYPES = new Set(['text']);

const CITATION_MARKER = /\s*[[【]\s*S\d+(?:\s*[,，、;]\s*S\d+)*\s*[\]】]/gu;
const MARKDOWN_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/gu;
const SOURCES_HEADING =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*(?:sources?|references|citations|来源|來源|资料来源|資料來源|参考资料|參考資料|引用|fonti|riferimenti)[ \t]*(?:\*\*|__)?[ \t]*(?:[:：]|$)/imu;

type MessageLike = { role?: unknown; content?: unknown; parts?: unknown };

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const texts: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (typeof type === 'string' && TEXT_PART_TYPES.has(type) && typeof text === 'string') texts.push(text);
  }
  return texts.join('\n');
}

function serializedParts(content: string): unknown[] | null {
  if (!content.includes('__content_parts__')) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as { __content_parts__?: unknown; parts?: unknown };
      if (record.__content_parts__ && Array.isArray(record.parts)) return record.parts;
    }
  } catch {
    return null;
  }
  return null;
}

function messageText(message: MessageLike): string {
  const { content, parts } = message;
  if (typeof content === 'string') {
    const serialized = serializedParts(content);
    return serialized ? partsText(serialized) : content;
  }
  if (Array.isArray(content)) return partsText(content);
  return partsText(parts);
}

function stripAssistantMarkup(text: string): string {
  let out = text;
  const heading = SOURCES_HEADING.exec(out);
  if (heading) out = out.slice(0, heading.index);
  return out
    .replace(MARKDOWN_IMAGE, '')
    .replace(CITATION_MARKER, '')
    .replace(/[ \t]+([.,;:!?。，；：！？])/gu, '$1');
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function truncate(text: string, chars: number): string {
  const points = Array.from(text);
  return points.length <= chars ? text : points.slice(0, chars).join('');
}

/**
 * D-16: the condense history taken from the request body only. The last `turns` user and assistant turns before the
 * current (last) user message, oldest first; each cut to `chars` code points; assistant source lists, citation markers
 * and image markup removed; system, tool and data messages dropped.
 */
export function buildHistoryWindow(
  messages: readonly MessageLike[] | null | undefined,
  limits: Partial<HistoryWindowLimits> = {},
): HistoryTurn[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const turns = Math.max(0, Math.floor(limits.turns ?? DEFAULT_LIMITS.turns));
  const chars = Math.max(0, Math.floor(limits.chars ?? DEFAULT_LIMITS.chars));
  if (turns === 0) return [];

  let current = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      current = i;
      break;
    }
  }
  if (current <= 0) return [];

  const window: HistoryTurn[] = [];
  for (let i = current - 1; i >= 0 && window.length < turns; i -= 1) {
    const message = messages[i];
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const raw = messageText(message);
    const cleaned = normalizeWhitespace(role === 'assistant' ? stripAssistantMarkup(raw) : raw);
    if (!cleaned) continue;
    window.push({ role, content: truncate(cleaned, chars) });
  }
  return window.reverse();
}
