import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processImageDocument } from '@/lib/document-processor';
import { IMAGE_CAPTION_PROMPT } from '@/lib/rag/ingest/captioner';
import { captionPromptFor, resetCaptionLanguageWarningForTests } from '@/lib/rag/ingest/caption-language';
import { captionLegacyImage } from '@/lib/rag/ingest/legacy-image-caption';
import { resetLanguageSettingsForTests } from '@/lib/rag/lang/settings';
import { fakeIngestDb, installIngestDeps, uninstallIngestDeps } from '../../helpers/ingest-fakes';

// Phase 3.2 verification XLG-06: the legacy image upload (processImageDocument, RAG_INGEST_PIPELINE=legacy) honours
// RAG_CAPTION_LANGUAGE. `en` keeps today's call; `document` asks captionImage for the D-23 target. Neutral synthetic captions.

const generateText = vi.hoisted(() => vi.fn());
const storeDocument = vi.hoisted(() => vi.fn());
const embedBatch = vi.hoisted(() => vi.fn());

vi.mock('ai', async (importOriginal) => ({ ...(await importOriginal<typeof import('ai')>()), generateText }));
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/supabase')>()), storeDocument }));
vi.mock('@/lib/rag', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/rag')>()), embedBatch }));

const IMAGE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const CAPTION = 'Una carta bianca con tre linee blu, usata solo per una prova.';
const USER = '00000000-0000-4000-8000-0000000093f1';

function promptSent(call = 0): string {
  const params = generateText.mock.calls[call]![0] as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
  return params.messages[0]!.content.find((part) => part.type === 'text')!.text!;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  generateText.mockReset().mockResolvedValue({ text: CAPTION });
  storeDocument.mockReset().mockResolvedValue('doc-1');
  embedBatch.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2]));
  vi.stubEnv('RAG_SUPPORTED_LANGUAGES', 'en,it');
  vi.stubEnv('RAG_PRIMARY_LANGUAGE', 'it');
  resetLanguageSettingsForTests();
  resetCaptionLanguageWarningForTests();
});

afterEach(() => {
  uninstallIngestDeps();
  vi.unstubAllEnvs();
  resetLanguageSettingsForTests();
  vi.restoreAllMocks();
});

describe('legacy image upload caption language (XLG-06)', () => {
  it('with RAG_CAPTION_LANGUAGE=en sends the pinned English prompt and stores the caption as today', async () => {
    installIngestDeps({ db: fakeIngestDb().db, env: { RAG_CAPTION_LANGUAGE: 'en' } });
    const id = await processImageDocument('pic.png', IMAGE, { user_id: USER, image_url: 'https://example.test/pic.png' });
    expect(id).toBe('doc-1');
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(promptSent()).toBe(IMAGE_CAPTION_PROMPT);
    expect(storeDocument.mock.calls[0]![1]).toBe(CAPTION);
  });

  it('with RAG_CAPTION_LANGUAGE=document asks for the primary language when the tenant has no shares, and stores that caption', async () => {
    installIngestDeps({ db: fakeIngestDb().db, env: { RAG_CAPTION_LANGUAGE: 'document' } });
    await processImageDocument('pic.png', IMAGE, { user_id: USER, image_url: 'https://example.test/pic.png' });
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(promptSent()).toBe(captionPromptFor('it'));
    expect(promptSent()).not.toBe(IMAGE_CAPTION_PROMPT);
    const [filename, content, chunks, metadata] = storeDocument.mock.calls[0]!;
    expect(filename).toBe('pic.png');
    expect(content).toBe(CAPTION);
    expect(chunks).toEqual([{ content: CAPTION, embedding: [0.1, 0.2] }]);
    expect(metadata).toMatchObject({ image_url: 'https://example.test/pic.png', image_type: 'image/png' });
  });

  it('with RAG_CAPTION_LANGUAGE=document takes the language with the largest tenant share', async () => {
    installIngestDeps({ db: fakeIngestDb().db, env: { RAG_CAPTION_LANGUAGE: 'document' } });
    const lookups: string[] = [];
    await captionLegacyImage(new Uint8Array(IMAGE), 'image/png', { userId: USER }, {
      lookupShares: async (tenantKey) => {
        lookups.push(tenantKey);
        return [
          { language: 'it', share: 0.3 },
          { language: 'en', share: 0.7 },
        ];
      },
    });
    expect(lookups).toEqual(['s:default']);
    expect(promptSent()).toBe(captionPromptFor('en'));
  });

  it('returns null with RAG_CAPTION_LANGUAGE=en so the caller keeps its own call', async () => {
    installIngestDeps({ db: fakeIngestDb().db, env: { RAG_CAPTION_LANGUAGE: 'en' } });
    expect(await captionLegacyImage(new Uint8Array(IMAGE), 'image/png', { userId: USER })).toBeNull();
    expect(generateText).not.toHaveBeenCalled();
  });
});
