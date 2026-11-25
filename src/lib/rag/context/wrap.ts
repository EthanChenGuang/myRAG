/** Every tag name the wrappers emit; content may never open or close one of them. */
const TAG = /<\s*\/?\s*(?:documents|doc|tool[-_]result)(?![a-z0-9_-])[^<>]*>?/g;

/** ASCII `<`, the look-alikes U+FE64 and U+FF1C, or any Unicode tag character. */
const NEEDS_VIEW = /[<\uFE64\uFF1C]|\uDB40[\uDC00-\uDC7F]/;

const ATTR_MAX = 200;

function isInvisible(code: number): boolean {
  return (
    code === 0x00ad ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0xfeff
  );
}

interface View {
  text: string;
  /** For each UTF-16 unit of `text`, the index of the original code point it came from. */
  origin: number[];
  points: string[];
}

/** Per-code-point NFKC + lower-case view with an index back to the original code points. */
function buildView(text: string): View {
  const points = Array.from(text);
  let view = '';
  const origin: number[] = [];
  points.forEach((point, index) => {
    const code = point.codePointAt(0)!;
    if (isInvisible(code)) return;
    let mapped: string;
    if (code >= 0xe0020 && code <= 0xe007e) mapped = String.fromCharCode(code - 0xe0000);
    else if (code >= 0xe0000 && code <= 0xe007f) return;
    else mapped = point.normalize('NFKC').toLowerCase();
    for (let unit = 0; unit < mapped.length; unit += 1) origin.push(index);
    view += mapped;
  });
  return { text: view, origin, points };
}

/**
 * Escapes the brackets of any opening or closing documents, doc or tool_result tag in `text`,
 * including look-alike brackets, invisible splits and tag-character spellings. Every other
 * character is returned verbatim.
 */
export function escapeTags(text: string): string {
  if (!NEEDS_VIEW.test(text)) return text;
  const view = buildView(text);
  const replace = new Map<number, string>();
  for (const match of view.text.matchAll(TAG)) {
    const start = match.index;
    replace.set(view.origin[start]!, '&lt;');
    const last = start + match[0].length - 1;
    if (match[0].length > 1 && view.text[last] === '>') replace.set(view.origin[last]!, '&gt;');
  }
  if (replace.size === 0) return text;
  return view.points.map((point, index) => replace.get(index) ?? point).join('');
}

/** Escapes an attribute value: control characters to spaces, entities, look-alikes, capped at 200 characters. */
export function escapeAttr(value: string): string {
  const escaped = value
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ')
    .replace(/\uDB40[\uDC00-\uDC7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/["\uFF02]/g, '&quot;')
    .replace(/[\uFF1C\uFE64]/g, '&lt;')
    .replace(/[\uFF1E\uFE65]/g, '&gt;');
  if (escaped.length <= ATTR_MAX) return escaped;
  return escaped
    .slice(0, ATTR_MAX)
    .replace(/&[a-z]*$/, '')
    .replace(/[\uD800-\uDBFF]$/, '');
}

export const REFERENCE_NOTICE = '';
export const REFERENCE_REMINDER = '';
export const TOOL_RESULT_SENTENCE = '';
export const TOOL_RESULT_NOTICE = '';

export interface WrapDoc {
  id: string;
  text: string;
  header?: string;
  source?: string;
  section?: string;
  type?: string;
  kind?: 'links' | 'image' | 'reference';
  flagged?: boolean;
}

export function wrapDocuments(_docs: readonly WrapDoc[], _opts: { toolResults?: boolean } = {}): string | null {
  return null;
}

export function docsFromBlocks(_blocks: readonly unknown[], _opts: Record<string, unknown> = {}): WrapDoc[] {
  return [];
}

export function buildClaudeContextReplacement(_input: { attachedSentence: string; docs: readonly WrapDoc[] }): string {
  return '';
}
