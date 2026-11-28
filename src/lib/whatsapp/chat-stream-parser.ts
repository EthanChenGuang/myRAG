const MAX_WEB_RESULT_URLS = 50;
const MAX_URL_LENGTH = 2048;
const WEB_SEARCH_TOOL = 'webSearch';

export interface ChatStreamFacts {
  /** The streamed answer text: text-delta parts joined by part id, in order of first appearance. */
  text: string;
  /** URLs of the turn's webSearch results (tool outputs and finish metadata), deduplicated. */
  webResultUrls: string[];
  /** answerLanguage from the message metadata, when the route sent one. */
  answerLanguage: string | null;
  /** The route marked the turn's context as flagged (Phase 5.1 injectionFlagged). */
  injectionFlagged: boolean;
  /** The turn's `rag` message metadata (standalone query and query language) as streamed; validated where it is stored. */
  rag: unknown;
}

export interface ChatStreamParser {
  /** Feeds one line of the response body; returns 'done' at the UI-message stream's [DONE] marker. */
  push(line: string): 'done' | 'more';
  result(): ChatStreamFacts;
}

type Part = Record<string, unknown>;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Part {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultItems(payload: unknown): unknown[] {
  const normalized = isObject(payload) && 'value' in payload ? payload.value : payload;
  if (Array.isArray(normalized)) return normalized;
  if (isObject(normalized) && Array.isArray(normalized.results)) return normalized.results;
  if (isObject(normalized) && Array.isArray(normalized.items)) return normalized.items;
  return [];
}

/** Parses the chat route's response: UI-message SSE (`data: {part}` … `data: [DONE]`) and the legacy `0:"text"` lines. */
export function createChatStreamParser(): ChatStreamParser {
  const textById = new Map<string, string>();
  let legacyText = '';
  const urls = new Set<string>();
  const webSearchCalls = new Set<string>();
  let answerLanguage: string | null = null;
  let injectionFlagged = false;
  let rag: unknown;

  const addUrls = (payload: unknown) => {
    for (const item of resultItems(payload)) {
      if (urls.size >= MAX_WEB_RESULT_URLS) return;
      const url = isObject(item) ? item.url : undefined;
      if (typeof url === 'string' && url.length > 0 && url.length <= MAX_URL_LENGTH && /^https?:\/\//i.test(url)) urls.add(url);
    }
  };

  const readMetadata = (metadata: unknown) => {
    if (!isObject(metadata)) return;
    if (typeof metadata.answerLanguage === 'string' && metadata.answerLanguage.length > 0) answerLanguage = metadata.answerLanguage;
    if (metadata.injectionFlagged === true) injectionFlagged = true;
    if (isObject(metadata.rag)) rag = metadata.rag;
    if (isObject(metadata.webSearch)) addUrls(metadata.webSearch.results);
  };

  const readPart = (part: Part) => {
    switch (part.type) {
      case 'text-delta': {
        if (typeof part.delta !== 'string') return;
        const id = typeof part.id === 'string' ? part.id : '';
        textById.set(id, (textById.get(id) ?? '') + part.delta);
        return;
      }
      case 'tool-input-start':
      case 'tool-input-available':
        if (part.toolName === WEB_SEARCH_TOOL && typeof part.toolCallId === 'string') webSearchCalls.add(part.toolCallId);
        return;
      case 'tool-output-available':
        if (typeof part.toolCallId === 'string' && webSearchCalls.has(part.toolCallId)) addUrls(part.output);
        return;
      case 'start':
      case 'finish':
      case 'message-metadata':
        readMetadata(part.messageMetadata);
        return;
      default:
        return;
    }
  };

  const readLegacy = (line: string) => {
    const colonIndex = line.indexOf(':');
    if (colonIndex <= 0) return;
    const contentPart = line.substring(colonIndex + 1);
    if (!contentPart.startsWith('"')) return;
    const content = parseJson(contentPart);
    if (typeof content === 'string') {
      legacyText += content;
    } else if (content === undefined && contentPart.endsWith('"')) {
      legacyText += contentPart.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  };

  return {
    push(rawLine) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.trim()) return 'more';
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return 'done';
        const part = parseJson(payload);
        if (isObject(part)) readPart(part);
        return 'more';
      }
      readLegacy(line);
      return 'more';
    },
    result() {
      return {
        text: [...textById.values()].join('') + legacyText,
        webResultUrls: [...urls],
        answerLanguage,
        injectionFlagged,
        rag,
      };
    },
  };
}
