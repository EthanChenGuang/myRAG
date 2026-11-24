import type { ParseResult } from '@/lib/rag-eval/contracts.generated';

export function isTextLike(_filename: string, _mimeType: string): boolean {
  return false;
}

export function parsePlainText(_input: { filename: string; mimeType: string; bytes: Uint8Array }): ParseResult {
  return { markdown: '', chunks: [], pictures: [], page_count: 0, language: null, parser: 'text', parser_version: 'native', partial: false, warnings: [] } as ParseResult;
}
