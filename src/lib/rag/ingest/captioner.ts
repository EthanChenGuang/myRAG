import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { captionPromptFor } from './caption-language';

/** The prompt processImageDocument sends; a test reads document-processor.ts and compares, so the two cannot drift. */
export const IMAGE_CAPTION_PROMPT =
  'Describe this image in extreme detail to allow for future search retrieval. Include text found in the image, visual elements, colors, and context. If it is a chart or graph, describe the data points and trends.';

const CAPTION_MODEL = 'gpt-4o';

/** Default vision model for ingest job settings when RAG_PARSE_VLM_MODEL is unset (shared with image captioning). */
export function imageCaptionModelId(): string {
  return CAPTION_MODEL;
}
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

export interface CaptionOptions {
  signal?: AbortSignal;
  /** RAG_CAPTION_LANGUAGE=document only: the language the caption is asked for (D-23). Absent: the pinned English prompt. */
  targetLanguage?: string | null;
}

export type CaptionFn = (_bytes: Uint8Array, _mimeType: string, _options: CaptionOptions) => Promise<string>;

/** A caption that could not be produced; the reason is stable and never carries image or model output. */
export class CaptionError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`[Ingest] caption failed (${reason})`);
    this.name = 'CaptionError';
    this.reason = reason;
  }
}

let override: CaptionFn | null = null;

/** Replaces the vision call, for example with a recorded caption. */
export function setCaptionerForTests(fn: CaptionFn): void {
  override = fn;
}

export function resetCaptionerForTests(): void {
  override = null;
}

/**
 * One description of an image for retrieval: the same model, prompt and data-URL message as the legacy
 * image upload, shared so the unified pipeline and the legacy writer caption alike. An aborted signal
 * rejects before the call and while it runs.
 */
export async function captionImage(bytes: Uint8Array, mimeType: string, options: CaptionOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  if (override) return override(bytes, mimeType, options);

  const mediaType = MEDIA_TYPES[mimeType.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (!mediaType) throw new CaptionError('unsupported_image_type');

  const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  const { text } = await generateText({
    model: openai(CAPTION_MODEL),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: captionPromptFor(options.targetLanguage) },
          { type: 'image', image: `data:${mediaType};base64,${base64}` },
        ],
      },
    ],
    ...(options.signal ? { abortSignal: options.signal } : {}),
  });
  if (text.trim() === '') throw new CaptionError('caption_empty');
  return text;
}
