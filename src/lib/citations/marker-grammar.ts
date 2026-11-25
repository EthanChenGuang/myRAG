/**
 * The one definition of a citation marker, shared by the server parser and the chat UI.
 *
 * A marker is an opener (`[`, `【`, `［`), one or more aliases `S<k>` (k has no leading zero)
 * separated by `,`, `，` or `、` with optional spaces, and a closer (`]`, `】`, `］`).
 * A marker spans at most MAX_MARKER_HOLD_CHARS characters after its opener, closer included,
 * so the streaming parser can decide on any opener after that many characters.
 */

export interface CitationMarker {
  start: number;
  end: number;
  aliases: string[];
}

export const MAX_MARKER_HOLD_CHARS = 16;

const OPEN = '[\\[【［]';
const CLOSE = '[\\]】］]';
const WS = '[ \\t\\u00A0\\u3000]';
const SEP = `${WS}*[,，、]${WS}*`;
const ALIAS = 'S[1-9]\\d*';

const MARKER_RE = new RegExp(`${OPEN}(${ALIAS}(?:${SEP}${ALIAS})*)${CLOSE}`, 'g');
const ALIAS_RE = new RegExp(ALIAS, 'g');
const OPENERS = new Set(['[', '【', '［']);
const VIABLE_PREFIX_RE = new RegExp(
  `^${OPEN}(?:S(?:[1-9]\\d*(?:${SEP}${ALIAS})*(?:${WS}*(?:[,，、]${WS}*S?)?)?)?)?$`,
);
const HORIZONTAL_WS = /[ \t 　]/;

export function findCitationMarkers(text: string): CitationMarker[] {
  const markers: CitationMarker[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (end - start - 1 > MAX_MARKER_HOLD_CHARS) continue;
    markers.push({ start, end, aliases: match[1].match(ALIAS_RE) ?? [] });
  }
  return markers;
}

/** True when `text` starts with an opener and could still grow into a marker. */
export function isOpenMarkerPrefix(text: string): boolean {
  return text.length - 1 < MAX_MARKER_HOLD_CHARS && VIABLE_PREFIX_RE.test(text);
}

export function isMarkerOpener(char: string): boolean {
  return OPENERS.has(char);
}

export function stripCitationMarkers(text: string): string {
  const markers = findCitationMarkers(text);
  if (markers.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const marker of markers) {
    out += text.slice(cursor, marker.start);
    let trimmed = out.length;
    while (trimmed > 0 && HORIZONTAL_WS.test(out[trimmed - 1])) trimmed--;
    out = out.slice(0, trimmed);
    cursor = marker.end;
    const atLineStart = out.length === 0 || out.endsWith('\n');
    if (atLineStart) {
      while (cursor < text.length && HORIZONTAL_WS.test(text[cursor])) cursor++;
    }
  }
  return out + text.slice(cursor);
}

export function neutralizeCitationMarkers(text: string): string {
  const markers = findCitationMarkers(text);
  if (markers.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const marker of markers) {
    out += text.slice(cursor, marker.start);
    out += text.slice(marker.start, marker.end).replace(/S(?=[1-9])/g, 'S​');
    cursor = marker.end;
  }
  return out + text.slice(cursor);
}
