import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import { extensionOf, mediaTypeOf } from './shared';

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'csv']);
const TEXT_MIME_TYPES = new Set(['text/markdown', 'text/plain', 'text/csv']);

/** The files the plain-text parser takes: txt, md and csv (F-11). Docling parses docx and html. */
export function isTextLike(filename: string, mimeType: string): boolean {
  const extension = extensionOf(filename);
  if (extension !== '') return TEXT_EXTENSIONS.has(extension);
  return TEXT_MIME_TYPES.has(mediaTypeOf(mimeType));
}

function isCsv(filename: string, mimeType: string): boolean {
  const extension = extensionOf(filename);
  return extension !== '' ? extension === 'csv' : mediaTypeOf(mimeType) === 'text/csv';
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function cellText(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|').trim();
}

/** A CSV as a Markdown table: the first row is the header, short rows are padded, so the table-aware chunker repeats the header. */
export function csvToMarkdown(text: string): string {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]): string => `| ${Array.from({ length: width }, (_, index) => cellText(row[index] ?? '')).join(' | ')} |`;
  const [header, ...body] = rows as [string[], ...string[][]];
  return [line(header), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(line)].join('\n');
}

/** UTF-8 decode without a byte order mark. */
export function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parsePlainText(input: { filename: string; mimeType: string; bytes: Uint8Array }): ParseResult {
  const text = decodeUtf8(input.bytes);
  return {
    markdown: isCsv(input.filename, input.mimeType) ? csvToMarkdown(text) : text,
    chunks: [],
    pictures: [],
    page_count: 0,
    language: null,
    parser: 'text',
    parser_version: 'native',
    partial: false,
    text_layer_page_share: null,
    warnings: [],
  };
}
