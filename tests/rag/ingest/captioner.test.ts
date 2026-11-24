import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNKERS, chunkDocument } from '@/lib/rag/ingest/chunkers';
import { chunkImageCaption } from '@/lib/rag/ingest/chunkers/image-caption';
import { CaptionError, IMAGE_CAPTION_PROMPT, captionImage, resetCaptionerForTests, setCaptionerForTests } from '@/lib/rag/ingest/captioner';
import { getProcessingProfile, profileFor, type DocType } from '@/lib/rag/ingest/profiles/load';
import recorded from '../../fixtures/ingest/caption-recorded.json';

const generateText = vi.hoisted(() => vi.fn());
const openaiModel = vi.hoisted(() => vi.fn((id: string) => ({ modelId: id })));

vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), generateText }));
vi.mock('@ai-sdk/openai', async (importOriginal) => ({ ...(await importOriginal<typeof import('@ai-sdk/openai')>()), openai: openaiModel }));

const LEGACY_SOURCE = readFileSync(path.join(process.cwd(), 'src/lib/document-processor.ts'), 'utf8');
const ALL_TYPES: DocType[] = ['general', 'financial_report', 'contract_legal', 'invoice_receipt', 'product_technical', 'scanned_image'];
const BYTES = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  generateText.mockReset();
  openaiModel.mockClear();
  generateText.mockResolvedValue({ text: recorded.captions.chart });
});

afterEach(() => {
  resetCaptionerForTests();
});

describe('captionImage', () => {
  it('sends the same prompt text and the same model as processImageDocument sends today', async () => {
    const legacyPrompt = /type: 'text', text: '([^']+)'/.exec(LEGACY_SOURCE)?.[1];
    const legacyModel = /aiOpenai\('([^']+)'\)/.exec(LEGACY_SOURCE)?.[1];
    expect(legacyPrompt).toBeTruthy();
    expect(legacyModel).toBeTruthy();
    expect(IMAGE_CAPTION_PROMPT).toBe(legacyPrompt);

    await captionImage(BYTES, 'image/png', { signal: new AbortController().signal });

    expect(openaiModel).toHaveBeenCalledWith(legacyModel);
    const params = generateText.mock.calls[0]![0] as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]!.role).toBe('user');
    expect(params.messages[0]!.content[0]).toEqual({ type: 'text', text: legacyPrompt });
  });

  it('sends the image as a data URL with its media type, maps image/jpg to image/jpeg, and returns the text', async () => {
    const caption = await captionImage(BYTES, 'image/png', { signal: new AbortController().signal });
    expect(caption).toBe(recorded.captions.chart);
    const first = generateText.mock.calls[0]![0] as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(first.messages[0]!.content[1]).toEqual({ type: 'image', image: 'data:image/png;base64,AQID' });

    await captionImage(BYTES, 'image/jpg', {});
    const second = generateText.mock.calls[1]![0] as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(second.messages[0]!.content[1]).toEqual({ type: 'image', image: 'data:image/jpeg;base64,AQID' });
  });

  it('refuses a media type the vision model does not take, and an empty caption, with stable reasons', async () => {
    await expect(captionImage(BYTES, 'image/tiff', {})).rejects.toMatchObject({ name: 'CaptionError', reason: 'unsupported_image_type' });
    expect(generateText).not.toHaveBeenCalled();

    generateText.mockResolvedValue({ text: '   \n' });
    const error = await captionImage(BYTES, 'image/png', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CaptionError);
    expect((error as CaptionError).reason).toBe('caption_empty');
  });

  it('rejects when the signal is aborted, before the call and while it runs, and passes the signal to the model call', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(captionImage(BYTES, 'image/png', { signal: aborted.signal })).rejects.toBeTruthy();
    expect(generateText).not.toHaveBeenCalled();

    const controller = new AbortController();
    generateText.mockImplementation(
      (params: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          params.abortSignal.addEventListener('abort', () => reject(params.abortSignal.reason));
        }),
    );
    const pending = captionImage(BYTES, 'image/png', { signal: controller.signal });
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
    expect((generateText.mock.calls[0]![0] as { abortSignal: AbortSignal }).abortSignal).toBe(controller.signal);
  });

  it('serves a recorded caption through the test setter and never calls the model', async () => {
    const seen: Array<{ size: number; mime: string }> = [];
    setCaptionerForTests(async (bytes, mimeType) => {
      seen.push({ size: bytes.length, mime: mimeType });
      return recorded.captions.logo;
    });
    expect(await captionImage(BYTES, 'image/webp', {})).toBe(recorded.captions.logo);
    expect(seen).toEqual([{ size: 3, mime: 'image/webp' }]);
    expect(generateText).not.toHaveBeenCalled();

    resetCaptionerForTests();
    expect(await captionImage(BYTES, 'image/webp', {})).toBe(recorded.captions.chart);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

describe('image_caption chunker', () => {
  it('is registered and returns no text chunk, marking the document as caption-only', () => {
    expect(Object.keys(CHUNKERS)).toContain('image_caption');
    expect(chunkImageCaption()).toEqual({ chunks: [], warnings: [], captionOnly: true });
    const config = { ...getProcessingProfile('general').chunker, kind: 'image_caption' as const };
    expect(chunkDocument(config, { markdown: '' })).toEqual({ chunks: [], warnings: [], captionOnly: true });
    expect(chunkDocument(config, { markdown: 'text that is ignored' }).chunks).toEqual([]);
  });
});

describe('profileFor source rule', () => {
  it.each(ALL_TYPES)('image_upload gives the %s profile the image_caption chunker and changes nothing else', (docType) => {
    const base = getProcessingProfile(docType);
    const derived = profileFor('image_upload', docType);
    expect(derived.chunker.kind).toBe('image_caption');
    expect({ ...derived, chunker: { ...derived.chunker, kind: base.chunker.kind } }).toEqual(base);
  });

  it('leaves every other source with the profile of its type', () => {
    for (const source of ['chat_upload', 'config_upload', 'nango', 'scraper', 'ai_to_rag'] as const) {
      for (const docType of ALL_TYPES) expect(profileFor(source, docType)).toBe(getProcessingProfile(docType));
    }
  });
});
