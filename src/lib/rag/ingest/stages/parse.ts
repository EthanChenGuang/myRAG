import { PARSE_ARTIFACT, saveArtifact } from '../artifacts';
import {
  IngestStageError,
  requireDocument,
  requireIdentity,
  type StageContext,
  type StageOutcome,
  type StageSpec,
} from '../types';

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'csv']);
const TEXT_MIME_TYPES = new Set(['text/markdown', 'text/plain', 'text/csv']);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

function isTextLike(filename: string, mimeType: string): boolean {
  const extension = extensionOf(filename);
  if (extension !== '') return TEXT_EXTENSIONS.has(extension);
  return TEXT_MIME_TYPES.has((mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? '');
}

/** The Markdown every later stage chunks from, kept next to the original; a resume and a type change start from it. */
async function storeParseOutput(ctx: StageContext, markdown: string): Promise<void> {
  try {
    await saveArtifact(ctx, PARSE_ARTIFACT, new TextEncoder().encode(markdown), 'text/markdown');
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    throw new IngestStageError('parse', 'store_parse_output_failed');
  }
}

async function run(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'parse');
  const document = requireDocument(ctx, 'parse');

  let text: string;
  if (ctx.input.text !== undefined) {
    text = ctx.input.text;
  } else if (identity.bytes !== null && isTextLike(identity.filename, ctx.input.mimeType)) {
    text = new TextDecoder('utf-8').decode(identity.bytes);
  } else {
    return { kind: 'fail', reason: 'parser_unavailable' };
  }

  ctx.work.parseText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  ctx.work.parserVersion = 'native';
  ctx.parserUsed = 'text';
  await ctx.writer.setFields(document.id, { parser_used: 'text', parser_version: 'native' });
  await storeParseOutput(ctx, ctx.work.parseText);
  return { kind: 'next' };
}

export const parseStage: StageSpec = { name: 'parse', minMsNeeded: 0, run };
