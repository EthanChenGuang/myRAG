import { enrichChunkWithURLs } from '@/lib/url-extractor';
import { detectLanguage } from '../../lang/detect';
import { lexicalText } from '../../lexical/tokenize';
import { scanText, type InjectionScanResult } from '../../security/injection-scan';
import { loadArtifact, originalName, saveArtifact } from '../artifacts';
import { CaptionError, captionImage } from '../captioner';
import { contentHash } from '../hash';
import { imageContextOf, validImageUrl } from '../image-options';
import {
  IngestStageError,
  requireDocument,
  requireIdentity,
  type ChunkDraft,
  type StageContext,
  type StageOutcome,
  type StageSpec,
} from '../types';
import { quarantineDocument } from './scan-injection';

/** Less than this left before the deadline: the run yields instead of starting a vision call. */
const CAPTION_MIN_MS = 8000;
/** Time kept after a vision call for the embed, write and publish stages. */
const CAPTION_RESERVE_MS = 5000;

/** The stored caption of the picture at this position; a whole image is picture 0. */
const captionArtifact = (index: number): string => `caption-${index + 1}.txt`;

async function storedCaption(ctx: StageContext, index: number): Promise<string | null> {
  const stored = await loadArtifact(ctx, captionArtifact(index));
  const text = stored ? new TextDecoder('utf-8').decode(stored.bytes).trim() : '';
  return text === '' ? null : text;
}

async function saveCaption(ctx: StageContext, index: number, caption: string): Promise<void> {
  try {
    await saveArtifact(ctx, captionArtifact(index), new TextEncoder().encode(caption), 'text/plain');
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw new IngestStageError('images', 'store_caption_failed');
  }
}

/** One vision call inside the request budget. Null means the budget ran out and the run should yield. */
async function captionWithinBudget(ctx: StageContext, bytes: Uint8Array, mimeType: string): Promise<string | null | { failure: string }> {
  const remaining = ctx.deadline - ctx.deps.now();
  if (remaining < CAPTION_MIN_MS) return null;
  const budget = AbortSignal.timeout(remaining - CAPTION_RESERVE_MS);
  try {
    return (await captionImage(bytes, mimeType, { signal: AbortSignal.any([ctx.signal, budget]) })).trim();
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    if (budget.aborted) return null;
    const reason = error instanceof CaptionError ? error.reason : 'caption_failed';
    console.error('[Ingest] caption failed', { reason });
    return { failure: reason };
  }
}

/**
 * A picture document (the image_caption chunker): the caption is the only chunk. The caption is made once, stored next to the
 * original and recorded in the images slice, so a resumed run reads it back and never calls the vision model again. It is
 * scanned with the same matcher as document text whenever the scan is on (a caption is text a model read out of an untrusted
 * picture, whatever the profile says), and a match quarantines the document before the chunk is written.
 */
async function runCaptionOnly(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'images');
  const document = requireDocument(ctx, 'images');
  const slot = ctx.state.images;
  const imageUrl = validImageUrl(slot?.imageUrl);
  if (slot === null || imageUrl === null) return { kind: 'fail', reason: 'image_url_invalid' };
  const mimeType = typeof slot.mimeType === 'string' && slot.mimeType !== '' ? slot.mimeType : ctx.input.mimeType;

  let caption = slot.captioned >= 1 ? await storedCaption(ctx, 0) : null;
  if (caption === null) {
    const bytes = identity.bytes ?? (await loadArtifact(ctx, originalName(identity.filename)))?.bytes ?? null;
    if (bytes === null) return { kind: 'fail', reason: 'original_unavailable' };
    const made = await captionWithinBudget(ctx, bytes, mimeType);
    if (made === null) return { kind: 'yield', reason: 'deadline' };
    if (typeof made === 'object') return { kind: 'fail', reason: made.failure };
    if (made === '') return { kind: 'fail', reason: 'caption_empty' };
    caption = made;
    await saveCaption(ctx, 0, caption);
    ctx.state.images = { ...slot, nextIndex: 1, captioned: 1 };
    await ctx.writer.saveState(document.id, 'processing', { ...ctx.state });
  }

  let outcome = 'image_captioned';
  if (ctx.config.injectionScan !== 'off') {
    let result: InjectionScanResult;
    try {
      result = scanText(caption);
    } catch (error) {
      console.error('[Ingest] injection scan unavailable', { reason: error instanceof Error ? error.message : 'unknown' });
      return { kind: 'fail', reason: 'injection_scan_unavailable' };
    }
    if (result.matched) {
      await quarantineDocument(ctx, 'images', result);
      outcome = 'quarantined';
    }
  }

  const imageContext = imageContextOf(slot.imageContext);
  const type = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const draft: ChunkDraft = {
    content: caption,
    section_path: [],
    chunk_kind: 'image',
    page_start: 1,
    page_end: 1,
    metadata: enrichChunkWithURLs(caption, {
      image_url: imageUrl,
      image_type: type === 'image/jpg' ? 'image/jpeg' : type,
      ...(imageContext !== null ? { image_context: imageContext } : {}),
      document_title: identity.filename,
      chunk_index: 0,
      chunk_position: 1,
      total_chunks: 1,
    }) as Record<string, unknown>,
    content_hash: contentHash(caption),
    lexical_text: lexicalText([], caption),
  };
  ctx.work.chunks = [draft];

  const language = detectLanguage(caption);
  if (language !== null) await ctx.writer.setFields(document.id, { language });
  return { kind: 'next', outcome };
}

/**
 * Picture captioning. A picture document is captioned here; the pictures inside a PDF arrive with plan 03-38. With
 * RAG_PDF_IMAGE_CHUNKS off (the default) every other document passes; switched on before that plan lands it says so and still passes.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  if (ctx.work.captionOnly) return runCaptionOnly(ctx);
  if (!ctx.config.pdfImageChunks) return { kind: 'next', disabled: true, outcome: 'images_off' };
  ctx.warnings.push('image_chunks_unavailable');
  return { kind: 'next', disabled: true, fallbackReason: 'image_chunks_unavailable' };
}

export const imagesStage: StageSpec = { name: 'images', minMsNeeded: 0, run };
