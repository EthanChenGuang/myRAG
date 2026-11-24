export const IMAGE_CAPTION_PROMPT = '';

export interface CaptionOptions {
  signal?: AbortSignal;
}

export type CaptionFn = (bytes: Uint8Array, mimeType: string, options: CaptionOptions) => Promise<string>;

export class CaptionError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`[Ingest] caption failed (${reason})`);
    this.name = 'CaptionError';
    this.reason = reason;
  }
}

export function setCaptionerForTests(_fn: CaptionFn): void {}

export function resetCaptionerForTests(): void {}

export async function captionImage(_bytes: Uint8Array, _mimeType: string, _options: CaptionOptions = {}): Promise<string> {
  return '';
}
