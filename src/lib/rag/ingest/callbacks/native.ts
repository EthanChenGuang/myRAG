import { ParseResultSchema, type ParseExternalRequest, type ParseExternalResponse, type ParseResult } from '@/lib/rag-eval/contracts.generated';
import { extensionOf, mediaTypeOf } from '../parsers/shared';
import { captionTargetForRun } from '../caption-language';
import { captionImage } from '../captioner';
import { isTextLike, parsePlainText } from '../parsers/plain-text';
import { PARSE_RESULT_OBJECT, lookupParseCache, putParseResult, type ParseCacheRow } from '../parse-cache';
import { getObjectStore } from '../object-store';
import { stripBom } from '../stages/parse';
import type { StageContext } from '../types';
import type { CallbackResult } from './common';

export const NATIVE_CACHE_PARSER = 'plain_text';
export const NATIVE_CACHE_VERSION = 'native';

const OFFICE_EXTENSIONS = new Set(['docx', 'doc', 'html', 'htm']);
const OFFICE_MIMES = new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/html']);

function isUnsupportedNative(filename: string, mimeType: string): boolean {
  const extension = extensionOf(filename);
  if (extension !== '' && OFFICE_EXTENSIONS.has(extension)) return true;
  const normalized = mediaTypeOf(mimeType);
  return OFFICE_MIMES.has(normalized) || normalized === 'application/msword';
}

function imageMime(filename: string, mimeType: string): boolean {
  const normalized = mediaTypeOf(mimeType);
  return normalized.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(filename);
}

async function nativeParseResult(ctx: StageContext): Promise<ParseResult> {
  const { identity, input } = ctx;
  if (!identity?.bytes) throw new Error('original_unavailable');
  const { filename, bytes } = identity;
  const mimeType = input.mimeType;
  // A text upload is its text whatever the filename says (an image caption keeps the image's name), as in the Phase 3 chain.
  if (input.text !== undefined) {
    return textInputResult(stripBom(input.text));
  }
  if (isUnsupportedNative(filename, mimeType)) throw new UnsupportedNativeMode('unsupported_mode');
  if (imageMime(filename, mimeType)) {
    const target = await captionTargetForRun(ctx, null);
    const caption = await captionImage(bytes, mimeType, target === null ? { signal: ctx.signal } : { signal: ctx.signal, targetLanguage: target });
    return {
      markdown: caption,
      chunks: [],
      pictures: [],
      page_count: 1,
      language: null,
      parser: 'text',
      parser_version: 'image',
      partial: false,
      text_layer_page_share: null,
      warnings: [],
    };
  }
  if (!isTextLike(filename, mimeType)) throw new UnsupportedNativeMode('unsupported_mode');
  const parsed = parsePlainText({ filename, mimeType, bytes });
  return { ...parsed, page_count: 1 };
}

function textInputResult(markdown: string): ParseResult {
  return {
    markdown,
    chunks: [],
    pictures: [],
    page_count: 1,
    language: null,
    parser: 'text',
    parser_version: 'native',
    partial: false,
    text_layer_page_share: null,
    warnings: [],
  };
}

export class UnsupportedNativeMode extends Error {
  readonly code = 'unsupported_mode';

  constructor(code: string) {
    super(`[parse-external] native unsupported (${code})`);
    this.name = 'UnsupportedNativeMode';
  }
}

function pageText(result: ParseResult): ParseExternalResponse['pages'] {
  const text = result.markdown.trim();
  return [{ page: 1, text, has_table: false }];
}

async function readCachedResult(entry: ParseCacheRow, signal: AbortSignal): Promise<ParseResult> {
  const stored = await getObjectStore().get(`${entry.objectPrefix}${PARSE_RESULT_OBJECT}`, { signal });
  if (!stored) throw new Error('cache_result_missing');
  const parsed = ParseResultSchema.safeParse(JSON.parse(new TextDecoder().decode(stored.bytes)));
  if (!parsed.success) throw new Error('cache_result_invalid');
  return parsed.data;
}

/**
 * Native mode: txt/md/csv via plain-text parser, images via captioner; html and docx are unsupported_mode (D-06, D-12).
 */
export async function handleNativeMode(
  jobId: string,
  body: ParseExternalRequest,
  ctx: StageContext,
  optionsHash: string,
  signal: AbortSignal,
): Promise<CallbackResult<ParseExternalResponse>> {
  const hit = await lookupParseCache(jobId, NATIVE_CACHE_PARSER, NATIVE_CACHE_VERSION, optionsHash, signal);
  if (hit) {
    const cached = await readCachedResult(hit, signal);
    return { status: 200, body: { worker_id: body.worker_id, status: 'done', cache_id: hit.id, pages: pageText(cached) } as ParseExternalResponse };
  }
  try {
    const result = await nativeParseResult(ctx);
    const entry = await putParseResult(jobId, NATIVE_CACHE_PARSER, NATIVE_CACHE_VERSION, optionsHash, result, [], signal);
    return { status: 200, body: { worker_id: body.worker_id, status: 'done', cache_id: entry.id, pages: pageText(result) } as ParseExternalResponse };
  } catch (error) {
    if (error instanceof UnsupportedNativeMode) {
      return { status: 200, body: { worker_id: body.worker_id, status: 'failed', error_class: error.code } as ParseExternalResponse };
    }
    throw error;
  }
}