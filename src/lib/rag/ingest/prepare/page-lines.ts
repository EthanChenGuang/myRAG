/**
 * Page structure of a stored parse result as comparison keys (D-14). Reading order only: no position, label or raw text leaves this module.
 * Accepts the docling.json shape and the per-page text shape `{ pages: [{ page, text }] }`; any other value gives null, never an error.
 */

export const PAGE_LINES_MAX_PAGES = 10000;
export const PAGE_LINES_MAX_KEYS_PER_PAGE = 5000;

export interface PageLines {
  pageCount: number;
  pages: Array<{ page: number; keys: string[] }>;
}

const LINE_BREAK = /\r\n|\r|\n/;

/** The one comparison key of reader and cleaner: NFKC, whitespace runs collapsed, trimmed, every digit run replaced by `0`. */
export function lineKey(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim().replace(/\p{Nd}+/gu, '0');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPageNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= PAGE_LINES_MAX_PAGES;

function addKeys(target: Map<number, string[]>, page: number, text: string): void {
  let keys = target.get(page);
  if (!keys) {
    keys = [];
    target.set(page, keys);
  }
  for (const line of text.split(LINE_BREAK)) {
    if (keys.length >= PAGE_LINES_MAX_KEYS_PER_PAGE) return;
    const key = lineKey(line);
    if (key !== '') keys.push(key);
  }
}

function toResult(byPage: Map<number, string[]>, pageCount: number): PageLines {
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, keys]) => ({ page, keys }));
  return { pageCount: Math.min(pageCount, PAGE_LINES_MAX_PAGES), pages };
}

function readDocling(texts: unknown[], pagesField: unknown): PageLines | null {
  const byPage = new Map<number, string[]>();
  let highest = 0;
  for (const item of texts) {
    if (!isRecord(item)) continue;
    const layer = item.content_layer;
    if (layer !== undefined && layer !== 'body') continue;
    if (typeof item.text !== 'string') continue;
    const prov = item.prov;
    if (!Array.isArray(prov) || prov.length === 0) continue;
    const first: unknown = prov[0];
    if (!isRecord(first) || !isPageNumber(first.page_no)) continue;
    const page = first.page_no;
    addKeys(byPage, page, item.text);
    if (page > highest) highest = page;
  }
  if (byPage.size === 0) return null;
  let pageCount = highest;
  if (Array.isArray(pagesField)) pageCount = pagesField.length;
  else if (isRecord(pagesField)) pageCount = Object.keys(pagesField).length;
  return toResult(byPage, Math.max(pageCount, byPage.size));
}

function readPageTexts(pages: unknown[]): PageLines | null {
  const byPage = new Map<number, string[]>();
  for (const entry of pages) {
    if (!isRecord(entry) || !isPageNumber(entry.page) || typeof entry.text !== 'string') continue;
    addKeys(byPage, entry.page, entry.text);
  }
  if (byPage.size === 0) return null;
  return toResult(byPage, byPage.size);
}

export function readPageLines(raw: unknown): PageLines | null {
  try {
    if (!isRecord(raw)) return null;
    if (Array.isArray(raw.texts)) return readDocling(raw.texts, raw.pages);
    if (Array.isArray(raw.pages)) return readPageTexts(raw.pages);
    return null;
  } catch {
    return null;
  }
}
