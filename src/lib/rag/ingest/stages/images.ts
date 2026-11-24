import { enrichChunkWithURLs } from '@/lib/url-extractor';
import { detectLanguage } from '../../lang/detect';
import { lexicalText } from '../../lexical/tokenize';
import { scanText, type InjectionScanResult } from '../../security/injection-scan';
import { isArtifactName, loadArtifact, originalName, saveArtifact } from '../artifacts';
import { CaptionError, captionImage } from '../captioner';
import { contentHash } from '../hash';
import { imageContextOf, validImageUrl } from '../image-options';
import { PUBLIC_IMAGE_MAX_BYTES, getPublicImageStore, publicImageExtension, publicImageKey } from '../images/public-store';
import { selectPictures, type ParsedPicture } from '../images/select';
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

const MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
/** Less than this left before the deadline: the run yields instead of starting a public upload. */
const UPLOAD_MIN_MS = 2000;
const UPLOAD_MAX_MS = 15000;

function warn(ctx: StageContext, code: string): void {
  if (!ctx.warnings.includes(code)) ctx.warnings.push(code);
}

/** The media type of a stored picture: its stored type when it is an image the chat can show, else the one its name says; null otherwise. */
function pictureMediaType(contentType: string | null, imageRef: string): string | null {
  const stored = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (publicImageExtension(stored) !== null) return stored === 'image/jpg' ? 'image/jpeg' : stored;
  const dot = imageRef.lastIndexOf('.');
  return MEDIA_BY_EXTENSION[dot < 0 ? '' : imageRef.slice(dot + 1).toLowerCase()] ?? null;
}

type LoadedPicture = { bytes: Uint8Array; mimeType: string } | { skip: string };

/** The bytes of one parsed picture from the private store (the parser's artifact); a reason when they cannot be used. */
async function loadPicture(ctx: StageContext, picture: ParsedPicture): Promise<LoadedPicture> {
  if (!isArtifactName(picture.image_ref)) return { skip: 'unavailable' };
  let stored;
  try {
    stored = await loadArtifact(ctx, picture.image_ref);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { skip: 'unavailable' };
  }
  if (!stored) return { skip: 'unavailable' };
  if (stored.bytes.byteLength > PUBLIC_IMAGE_MAX_BYTES) return { skip: 'too_large' };
  const mimeType = pictureMediaType(stored.contentType, picture.image_ref);
  return mimeType === null ? { skip: 'unsupported_type' } : { bytes: stored.bytes, mimeType };
}

/** The section path of the last text chunk that starts on or before the page; the parse result carries no heading for a picture. */
function sectionPathAt(chunks: readonly ChunkDraft[], page: number): string[] {
  let path: string[] = [];
  for (const chunk of chunks) {
    if (chunk.page_start !== null && chunk.page_start <= page) path = chunk.section_path;
  }
  return path.slice();
}

/**
 * The pictures inside a document (D-29), behind RAG_PDF_IMAGE_CHUNKS. Pictures are selected (area floor, cap), then, in page order:
 *  1. each is captioned once with the shared captioner, inside the request budget; the caption is stored as caption-<n>.txt and the
 *     progress in the images slice, so a resumed run continues with the next picture and never captions one twice;
 *  2. each caption is scanned like document text; a match quarantines the document and nothing is stored publicly or written as an image chunk;
 *  3. only then are the pictures stored in the public bucket under rag/<tenant_key>/<lineage_id>/<version>/, and an image chunk
 *     (page, section path of the enclosing text, image_url, caption) is added per picture.
 * A picture that cannot be used (bytes gone, type unsupported, caption or upload failed) is left out with a warning; the document is not failed.
 */
async function runPictures(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'images');
  const document = requireDocument(ctx, 'images');
  const pictures = ctx.work.pictures ?? [];
  if (pictures.length === 0) return { kind: 'next', outcome: 'images_none' };
  if (ctx.state.quarantine !== null) return { kind: 'next', outcome: 'images_quarantined' };

  const selection = selectPictures(pictures);
  const { kept } = selection;
  const initial = ctx.state.images;
  const resumeFrom = initial?.nextIndex ?? 0;
  const skipped = new Set<number>(initial?.skipped ?? []);
  let captioned = initial?.captioned ?? 0;
  let nextIndex = resumeFrom;
  let uploaded = initial?.uploaded ?? 0;
  const lost = selection.skippedInvalid;
  const outcomeCode = (): string => `kept_${kept.length - skipped.size}.small_${selection.skippedSmall}.cap_${selection.skippedOverCap}.lost_${lost + skipped.size}`;

  const record = (): void => {
    ctx.state.images = { ...(initial ?? { nextIndex: 0, captioned: 0 }), nextIndex, captioned, skipped: [...skipped].sort((a, b) => a - b), uploaded };
  };
  const giveUp = (index: number, reason: string): void => {
    skipped.add(index);
    warn(ctx, `image_skipped:${reason}`);
  };
  const yieldNow = async (): Promise<StageOutcome> => {
    record();
    await ctx.writer.saveState(document.id, 'processing', { ...ctx.state });
    return { kind: 'yield', reason: 'deadline' };
  };

  const captions = new Map<number, string>();
  for (let index = 0; index < kept.length; index += 1) {
    if (skipped.has(index)) continue;
    const picture = kept[index] as ParsedPicture;
    let caption = index < resumeFrom ? await storedCaption(ctx, index) : null;
    if (caption === null) {
      const loaded = await loadPicture(ctx, picture);
      if ('skip' in loaded) {
        giveUp(index, loaded.skip);
        nextIndex = index + 1;
        continue;
      }
      const made = await captionWithinBudget(ctx, loaded.bytes, loaded.mimeType);
      if (made === null) return yieldNow();
      if (typeof made === 'object') {
        giveUp(index, 'caption_failed');
        nextIndex = index + 1;
        continue;
      }
      if (made === '') {
        giveUp(index, 'caption_empty');
        nextIndex = index + 1;
        continue;
      }
      caption = made;
      await saveCaption(ctx, index, caption);
      captioned += 1;
      nextIndex = index + 1;
      record();
      await ctx.writer.saveState(document.id, 'processing', { ...ctx.state });
    }
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
        nextIndex = kept.length;
        record();
        return { kind: 'next', outcome: 'quarantined' };
      }
    }
    captions.set(index, caption);
  }
  nextIndex = kept.length;

  const store = getPublicImageStore();
  const urls = new Map<number, { url: string; mimeType: string }>();
  for (let index = 0; index < kept.length; index += 1) {
    const caption = captions.get(index);
    if (caption === undefined) continue;
    const picture = kept[index] as ParsedPicture;
    const loaded = await loadPicture(ctx, picture);
    if ('skip' in loaded) {
      giveUp(index, loaded.skip);
      continue;
    }
    const ordinal = kept.slice(0, index + 1).filter((entry) => entry.page === picture.page).length;
    let key: string;
    try {
      key = publicImageKey(identity.tenantKey, document.lineageId, document.version, picture.page, ordinal, publicImageExtension(loaded.mimeType) as string);
    } catch {
      giveUp(index, 'store_failed');
      continue;
    }
    try {
      if (index >= uploaded) {
        const remaining = ctx.deadline - ctx.deps.now();
        if (remaining < UPLOAD_MIN_MS) {
          uploaded = index;
          return yieldNow();
        }
        const budget = AbortSignal.timeout(Math.min(UPLOAD_MAX_MS, Math.max(UPLOAD_MIN_MS, remaining - CAPTION_RESERVE_MS)));
        try {
          await store.put(key, loaded.bytes, { contentType: loaded.mimeType, signal: AbortSignal.any([ctx.signal, budget]) });
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          if (budget.aborted) {
            uploaded = index;
            return yieldNow();
          }
          throw error;
        }
      }
      urls.set(index, { url: store.urlFor(key), mimeType: loaded.mimeType });
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      console.error('[Ingest] public image store failed', { error: error instanceof Error ? error.name : 'unknown' });
      giveUp(index, 'store_failed');
    }
  }
  uploaded = kept.length;
  record();

  const text = ctx.work.chunks.filter((chunk) => chunk.chunk_kind !== 'image');
  const images: ChunkDraft[] = [];
  for (let index = 0; index < kept.length; index += 1) {
    const stored = urls.get(index);
    const caption = captions.get(index);
    if (!stored || caption === undefined) continue;
    const picture = kept[index] as ParsedPicture;
    const section_path = sectionPathAt(text, picture.page);
    const position = text.length + images.length;
    images.push({
      content: caption,
      section_path,
      chunk_kind: 'image',
      page_start: picture.page,
      page_end: picture.page,
      metadata: enrichChunkWithURLs(caption, {
        image_url: stored.url,
        image_type: stored.mimeType,
        document_title: identity.filename,
        chunk_index: position,
        chunk_position: position + 1,
      }) as Record<string, unknown>,
      content_hash: contentHash(caption),
      lexical_text: lexicalText(section_path, caption),
    });
  }
  const all = [...text, ...images];
  for (const draft of all) draft.metadata = { ...draft.metadata, total_chunks: all.length };
  ctx.work.chunks = all;
  return { kind: 'next', outcome: outcomeCode() };
}

/**
 * Picture captioning. A picture document is captioned whole (the image_caption chunker); with RAG_PDF_IMAGE_CHUNKS on, the pictures
 * the parser found inside any other document become image chunks of it. With the switch off (the default) every other document passes.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  if (ctx.work.captionOnly) return runCaptionOnly(ctx);
  if (!ctx.config.pdfImageChunks) return { kind: 'next', disabled: true, outcome: 'images_off' };
  return runPictures(ctx);
}

export const imagesStage: StageSpec = { name: 'images', minMsNeeded: 0, run };
