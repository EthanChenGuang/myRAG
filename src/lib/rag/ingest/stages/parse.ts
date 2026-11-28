import type { ParseResult } from '@/lib/rag-eval/contracts.generated';
import { ParseResultSchema } from '@/lib/rag-eval/contracts.generated';
import {
  DOCLING_ARTIFACT,
  PARSE_ARTIFACT,
  PARSE_CHUNKS_ARTIFACT,
  PICTURES_ARTIFACT,
  isArtifactName,
  loadArtifact,
  originalName,
  saveArtifact,
  type ArtifactContext,
} from '../artifacts';
import { imageContextOf, validImageUrl } from '../image-options';
import { buildParserChain, parseWithFallback, type ChainOutcome } from '../parsers/chain';
import type { ParseArtifact, PendingJob } from '../parsers/shared';
import { profileFor } from '../profiles/load';
import { refineDocTypeAfterParse } from '../profiles/resolve-doc-type';
import { effectiveIngestSettings, ingestLanguageSettings } from '../routing/effective-settings';
import { saveContextState } from '../state-store';
import {
  IngestStageError,
  requireDocument,
  requireIdentity,
  type StageContext,
  type StageOutcome,
  type StageSpec,
} from '../types';

/** Time kept after the last poll for saving the state, the artifacts and the parse output. */
const POLL_RESERVE_MS = 3000;
/** Less than this left before the deadline: the run yields instead of starting a parser. */
const MIN_PARSE_MS = 2000;

export interface Parsed {
  result: ParseResult;
  artifacts: ParseArtifact[];
  warnings: string[];
}

export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

function warn(ctx: StageContext, code: string): void {
  if (!ctx.warnings.includes(code)) ctx.warnings.push(code);
}

/** A storage failure fails the run with one stable reason; an abort is passed on. */
async function stored(ctx: StageContext, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw new IngestStageError('parse', 'store_parse_output_failed');
  }
}

function textResult(markdown: string): ParseResult {
  return {
    markdown,
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

/** A whole image: no text, one picture that is the stored original, parsed by nothing (parser text, version image). */
function imageResult(imageRef: string): ParseResult {
  return {
    markdown: '',
    chunks: [],
    pictures: [{ bbox: [0, 0, 1, 1], image_ref: imageRef, page: 1, page_area_share: 1 }],
    page_count: 1,
    language: null,
    parser: 'text',
    parser_version: 'image',
    partial: false,
    text_layer_page_share: null,
    warnings: [],
  };
}

/**
 * The parse of a document whose profile chunks from a caption (an image upload): the file must be an image and carry a usable
 * public URL. What the images stage needs without the upload (URL, context, media type) goes into the images slice of the state,
 * which survives a resume; an earlier slot supplies the URL when a resumed run parses the stored original again.
 */
function wholeImage(ctx: StageContext, bytes: Uint8Array | null): { parsed: Parsed } | { reason: string } {
  const identity = requireIdentity(ctx, 'parse');
  const mimeType = ctx.input.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (ctx.input.text !== undefined || bytes === null || !mimeType.startsWith('image/')) return { reason: 'not_an_image' };
  const slot = ctx.state.images;
  const imageUrl = validImageUrl(ctx.input.options?.imageUrl) ?? validImageUrl(slot?.imageUrl);
  if (imageUrl === null) return { reason: 'image_url_invalid' };
  const imageContext = imageContextOf(ctx.input.options?.imageContext) ?? imageContextOf(slot?.imageContext);
  ctx.state.images = {
    nextIndex: slot?.nextIndex ?? 0,
    captioned: slot?.captioned ?? 0,
    imageUrl,
    ...(imageContext !== null ? { imageContext } : {}),
    mimeType,
  };
  return { parsed: { result: imageResult(originalName(identity.filename)), artifacts: [], warnings: [] } };
}

/**
 * The parse output an earlier version of this lineage stored (the admin type change with equal parser options, D-18): parse.md, the
 * parser's own chunks and the Docling JSON are read back from that version's prefix, and no parser runs. Null when parse.md is not
 * there or the parser that made it was not recorded; the caller then parses the stored original instead.
 */
async function reuseStoredParse(ctx: StageContext, previousVersion: number): Promise<Parsed | null> {
  const identity = requireIdentity(ctx, 'parse');
  const document = requireDocument(ctx, 'parse');
  const reused = ctx.state.typeChange?.reusedParser ?? null;
  if (reused === null) return null;
  const earlier: ArtifactContext = {
    identity,
    document: { lineageId: document.lineageId, version: previousVersion },
    signal: ctx.signal,
    state: { artifacts: {} },
  };
  const markdown = await loadArtifact(earlier, PARSE_ARTIFACT);
  if (!markdown) return null;

  let chunks: ParseResult['chunks'] = [];
  const storedChunks = await loadArtifact(earlier, PARSE_CHUNKS_ARTIFACT);
  if (storedChunks) {
    try {
      const checked = ParseResultSchema.shape.chunks.safeParse(JSON.parse(new TextDecoder('utf-8').decode(storedChunks.bytes)));
      if (checked.success) chunks = checked.data;
    } catch {
      chunks = [];
    }
  }
  // A sanitized version's docling.json still holds the hidden spans (F-17): it is never carried over.
  const docling = ctx.state.typeChange?.sanitizedParse ? null : await loadArtifact(earlier, DOCLING_ARTIFACT);
  const result: ParseResult = {
    markdown: new TextDecoder('utf-8').decode(markdown.bytes),
    chunks,
    pictures: [],
    page_count: 0,
    language: null,
    parser: reused.parser,
    parser_version: reused.version,
    partial: false,
    text_layer_page_share: null,
    warnings: [],
  };
  return {
    result,
    artifacts: docling ? [{ name: DOCLING_ARTIFACT, bytes: docling.bytes, contentType: docling.contentType || 'application/json' }] : [],
    warnings: ['parse_reused'],
  };
}

/** The job a previous call saved in processing_state, when it has the shape this code wrote. */
function savedJob(ctx: StageContext): PendingJob | null {
  const job = ctx.state.parseJob;
  if (!job || (job.parser !== 'llamaparse' && job.parser !== 'docling')) return null;
  if (typeof job.jobId !== 'string' || typeof job.submittedAt !== 'string' || !Number.isInteger(job.attempt)) return null;
  return { parser: job.parser, jobId: job.jobId, submittedAt: job.submittedAt, attempt: job.attempt };
}

async function runChain(ctx: StageContext, bytes: Uint8Array, resume: PendingJob | null): Promise<ChainOutcome> {
  const identity = requireIdentity(ctx, 'parse');
  const document = requireDocument(ctx, 'parse');
  const now = ctx.deps.now;
  const chain = buildParserChain(identity.profile, ctx.config, { filename: identity.filename, mimeType: ctx.input.mimeType });
  const outcome = await parseWithFallback(chain, {
    scope: ctx.input.scope,
    filename: identity.filename,
    mimeType: ctx.input.mimeType,
    bytes,
    profile: identity.profile,
    signal: ctx.signal,
    now,
    deadline: ctx.deadline,
    pollUntil: Math.min(now() + ctx.config.parsePollBudgetMs, ctx.deadline - POLL_RESERVE_MS),
    resume,
    // The job id is saved before the first poll, so a request that ends mid-wait can resume the same job.
    onSubmitted: async (job) => {
      ctx.state.parseJob = { ...job };
      await saveContextState(ctx, 'processing');
    },
    settings: effectiveIngestSettings({ ingestConfig: ctx.config, profile: identity.profile, languageSettings: ingestLanguageSettings(ctx.config) }),
  });
  for (const fallback of outcome.fallbacks) warn(ctx, `parser_fallback:${fallback.parser}:${fallback.reason}`);
  return outcome;
}

/** A type refined after parse is written at once, so a resume rebuilds the same profile and chunks as an uninterrupted run. */
async function persistRefinedType(ctx: StageContext): Promise<void> {
  const identity = requireIdentity(ctx, 'parse');
  const document = requireDocument(ctx, 'parse');
  await ctx.writer.setFields(document.id, {
    doc_type: identity.docType,
    doc_type_origin: identity.docTypeOrigin,
    processing_profile_id: identity.profile.id,
    processing_profile_version: identity.profile.version,
  });
}

/** Keeps the result: the work every later stage reads, the parser fields, the artifacts and parse.md. A queued run applies the parse result its callback cached through the same function. */
export async function applyParseResult(ctx: StageContext, parsed: Parsed): Promise<void> {
  const document = requireDocument(ctx, 'parse');
  const { result } = parsed;
  ctx.state.parseJob = null;
  ctx.work.parseText = stripBom(result.markdown);
  ctx.work.parseChunks = result.chunks.length > 0 ? result.chunks : null;
  ctx.work.pictures = result.pictures.length > 0 ? result.pictures : null;
  ctx.work.parserVersion = result.parser_version;
  ctx.state.parserVersion = result.parser_version;
  ctx.parserUsed = result.parser;
  for (const code of [...(result.warnings ?? []), ...parsed.warnings]) warn(ctx, code);
  if (result.partial) warn(ctx, 'parse_partial');
  await ctx.writer.setFields(document.id, { parser_used: result.parser, parser_version: result.parser_version });

  for (const artifact of parsed.artifacts) {
    // docling.json is the one name the type-change plan reads back by constant.
    const name = artifact.name === DOCLING_ARTIFACT ? DOCLING_ARTIFACT : artifact.name;
    if (!isArtifactName(name)) {
      warn(ctx, 'artifact_name_unsupported');
      continue;
    }
    await stored(ctx, () => saveArtifact(ctx, name, artifact.bytes, artifact.contentType));
  }
  if (ctx.work.parseChunks) {
    const bytes = new TextEncoder().encode(JSON.stringify(ctx.work.parseChunks));
    await stored(ctx, () => saveArtifact(ctx, PARSE_CHUNKS_ARTIFACT, bytes, 'application/json'));
  }
  // Only with the picture switch on, so the stored set of a run with it off is what it was.
  if (ctx.config.pdfImageChunks && result.parser !== 'text' && result.pictures.length > 0) {
    const bytes = new TextEncoder().encode(JSON.stringify(result.pictures));
    await stored(ctx, () => saveArtifact(ctx, PICTURES_ARTIFACT, bytes, 'application/json'));
  }
  await stored(ctx, () => saveArtifact(ctx, PARSE_ARTIFACT, new TextEncoder().encode(ctx.work.parseText ?? ''), 'text/markdown'));
}

/** Either the parse output, or the outcome the stage ends with when there is none (a failure, or a yield while a parse job is pending). */
export type ParseToResult = { kind: 'parsed'; parsed: Parsed } | { kind: 'stopped'; outcome: StageOutcome };

/**
 * The parse stage up to, and not including, keeping the result: the chain (or plain text, or the whole image), the doc type refinement
 * and the one re-parse it may ask for. The parse-external callback of a queued job runs this and caches what it returns.
 */
export async function parseToResult(ctx: StageContext): Promise<ParseToResult> {
  const identity = requireIdentity(ctx, 'parse');
  requireDocument(ctx, 'parse');

  // A resume rebuilds the profile of a type that was refined after parse.
  const refinedType = ctx.state.docTypeDetection?.refined ?? null;
  if (refinedType !== null && identity.docTypeOrigin === 'auto') {
    identity.docType = refinedType;
    identity.profile = profileFor(ctx.input.source, refinedType);
  }

  let parsed: Parsed;
  const bytes = identity.bytes;
  if (identity.profile.chunker.kind === 'image_caption') {
    const image = wholeImage(ctx, bytes);
    if ('reason' in image) return { kind: 'stopped', outcome: { kind: 'fail', reason: image.reason } };
    parsed = image.parsed;
  } else if (ctx.input.text !== undefined) {
    parsed = { result: textResult(stripBom(ctx.input.text)), artifacts: [], warnings: [] };
  } else {
    if (bytes === null) return { kind: 'stopped', outcome: { kind: 'fail', reason: 'no_parser_available' } };
    const previousVersion = ctx.state.typeChange?.reuseParseOfVersion ?? null;
    const reused = previousVersion === null ? null : await reuseStoredParse(ctx, previousVersion);
    // The original of a sanitized version holds the hidden spans: without its sanitized parse output the run stops instead of parsing it.
    if (reused === null && ctx.state.typeChange?.sanitizedParse) return { kind: 'stopped', outcome: { kind: 'fail', reason: 'sanitized_parse_unavailable' } };
    if (reused !== null) {
      parsed = reused;
    } else {
      if (ctx.deadline - ctx.deps.now() < MIN_PARSE_MS) return { kind: 'stopped', outcome: { kind: 'yield', reason: 'deadline' } };
      const first = await runChain(ctx, bytes, savedJob(ctx));
      if (first.kind === 'failed') {
        ctx.state.parseJob = null;
        return { kind: 'stopped', outcome: { kind: 'fail', reason: first.reason } };
      }
      if (first.kind === 'pending') return { kind: 'stopped', outcome: { kind: 'yield', reason: 'parse_pending' } };
      parsed = first;
    }
  }

  const refined = await refineDocTypeAfterParse(ctx, {
    text: parsed.result.markdown,
    textLayerPageShare: parsed.result.text_layer_page_share ?? null,
  });
  if (refined.changed) await persistRefinedType(ctx);

  // At most one re-parse, and only when a parser ran: plain text has no options to change.
  if (refined.parserOptionsDiffer && parsed.result.parser !== 'text' && bytes !== null && !ctx.state.typeChange?.sanitizedParse) {
    if (ctx.state.docTypeDetection) ctx.state.docTypeDetection.reparsed = true;
    ctx.state.parseJob = null;
    const second = await runChain(ctx, bytes, null);
    if (second.kind === 'pending') return { kind: 'stopped', outcome: { kind: 'yield', reason: 'parse_pending' } };
    if (second.kind === 'done') parsed = second;
    else warn(ctx, 'reparse_failed');
  }

  return { kind: 'parsed', parsed };
}

async function run(ctx: StageContext): Promise<StageOutcome> {
  const outcome = await parseToResult(ctx);
  if (outcome.kind === 'stopped') return outcome.outcome;
  await applyParseResult(ctx, outcome.parsed);
  return { kind: 'next' };
}

export const parseStage: StageSpec = { name: 'parse', minMsNeeded: 0, run };
