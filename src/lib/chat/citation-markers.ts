import { findCitationMarkers, isMarkerOpener, isOpenMarkerPrefix } from '@/lib/citations/marker-grammar';

export type CitationRenderPhase = 'streaming' | 'final';

export interface CitationMarkerTarget {
  n: number;
  alias: string;
}

export const CITE_HREF_PREFIX = '#cite-';

const HORIZONTAL_WS = /[ \t 　]/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** True when the message metadata says the server ran a citation session for it. */
export function isCitationAware(metadata: unknown): boolean {
  const source = asRecord(metadata);
  if (!source) return false;
  return (
    Array.isArray(source.citations) ||
    (typeof source.answerId === 'string' && source.answerId.length > 0) ||
    (typeof source.citationStrategy === 'string' && source.citationStrategy.length > 0)
  );
}

interface Segment {
  code: boolean;
  text: string;
}

function lineEnd(text: string, from: number): number {
  const i = text.indexOf('\n', from);
  return i < 0 ? text.length : i + 1;
}

/** Splits text into prose and code (fenced blocks, inline code spans); code is left untouched. */
function splitCode(text: string): Segment[] {
  const segments: Segment[] = [];
  let prose = '';
  let i = 0;
  const flushProse = () => {
    if (prose) segments.push({ code: false, text: prose });
    prose = '';
  };
  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === '\n';
    if (atLineStart) {
      const end = lineEnd(text, i);
      const fence = FENCE_OPEN_RE.exec(text.slice(i, end));
      if (fence) {
        const marker = fence[1];
        let cursor = end;
        let close = text.length;
        while (cursor < text.length) {
          const next = lineEnd(text, cursor);
          const line = text.slice(cursor, next).replace(/\r?\n$/, '');
          const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
          if (closing && closing[1][0] === marker[0] && closing[1].length >= marker.length) {
            close = next;
            break;
          }
          cursor = next;
        }
        flushProse();
        segments.push({ code: true, text: text.slice(i, close) });
        i = close;
        continue;
      }
    }
    if (text[i] === '`') {
      let run = 1;
      while (text[i + run] === '`') run++;
      let search = i + run;
      let closeAt = -1;
      while (search < text.length) {
        const found = text.indexOf('`', search);
        if (found < 0) break;
        let len = 1;
        while (text[found + len] === '`') len++;
        if (len === run) {
          closeAt = found;
          break;
        }
        search = found + len;
      }
      if (closeAt >= 0) {
        flushProse();
        segments.push({ code: true, text: text.slice(i, closeAt + run) });
        i = closeAt + run;
        continue;
      }
      prose += text.slice(i, i + run);
      i += run;
      continue;
    }
    prose += text[i];
    i++;
  }
  flushProse();
  return segments;
}

function trimTrailingHorizontal(text: string): string {
  let end = text.length;
  while (end > 0 && HORIZONTAL_WS.test(text[end - 1])) end--;
  return text.slice(0, end);
}

function rewriteProse(text: string, chipsFor: (aliases: string[]) => string, startsLine: boolean): string {
  const markers = findCitationMarkers(text);
  if (markers.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const marker of markers) {
    out = trimTrailingHorizontal(out + text.slice(cursor, marker.start));
    cursor = marker.end;
    const chips = chipsFor(marker.aliases);
    if (chips) {
      out += chips;
    } else if ((out.length === 0 && startsLine) || out.endsWith('\n')) {
      while (cursor < text.length && HORIZONTAL_WS.test(text[cursor])) cursor++;
    }
  }
  return out + text.slice(cursor);
}

function hideTrailingPartialMarker(text: string): string {
  const from = Math.max(0, text.length - 17);
  for (let i = text.length - 1; i >= from; i--) {
    if (isMarkerOpener(text[i])) {
      return isOpenMarkerPrefix(text.slice(i)) ? trimTrailingHorizontal(text.slice(0, i)) : text;
    }
  }
  return text;
}

/**
 * Markdown for a message's text: validated markers become `[n](#cite-S<k>)` links, every other marker disappears.
 * While a citation-aware message streams, all markers are hidden. `citations: undefined` means the message is not
 * citation-aware and the text comes back unchanged. Code spans and fenced blocks are never touched.
 */
export function renderCitationMarkers(
  text: string,
  options: { citations?: readonly CitationMarkerTarget[]; phase: CitationRenderPhase },
): string {
  const { citations, phase } = options;
  if (!citations || typeof text !== 'string' || text.length === 0) return text;
  const numbers = new Map<string, number>();
  if (phase === 'final') {
    for (const citation of citations) {
      if (!numbers.has(citation.alias)) numbers.set(citation.alias, citation.n);
    }
  }
  const chipsFor = (aliases: string[]): string => {
    const seen = new Set<string>();
    let chips = '';
    for (const alias of aliases) {
      const n = numbers.get(alias);
      if (n === undefined || seen.has(alias)) continue;
      seen.add(alias);
      chips += `[${n}](${CITE_HREF_PREFIX}${alias})`;
    }
    return chips;
  };
  const segments = splitCode(text);
  const rendered = segments.map((segment, index) => {
    if (segment.code) return segment.text;
    const startsLine = index === 0 || segments[index - 1].text.endsWith('\n');
    return rewriteProse(segment.text, chipsFor, startsLine);
  });
  if (phase === 'streaming') {
    const last = segments.length - 1;
    if (last >= 0 && !segments[last].code) rendered[last] = hideTrailingPartialMarker(rendered[last]);
  }
  return rendered.join('');
}

/** The alias of a `#cite-S<k>` href, or null for any other href. */
export function citeAliasFromHref(href: unknown): string | null {
  if (typeof href !== 'string' || !href.startsWith(CITE_HREF_PREFIX)) return null;
  const alias = href.slice(CITE_HREF_PREFIX.length);
  return /^S[1-9]\d*$/.test(alias) ? alias : null;
}
