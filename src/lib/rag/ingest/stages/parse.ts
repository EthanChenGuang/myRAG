import {
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

async function run(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'parse');
  const document = requireDocument(ctx, 'parse');

  let text: string;
  if (ctx.input.text !== undefined) {
    text = ctx.input.text;
  } else if (identity.bytes !== null && isTextLike(identity.filename, ctx.input.mimeType)) {
    text = new TextDecoder('utf-8').decode(identity.bytes);
  } else {
    throw new Error('unsupported file type');
  }

  ctx.work.parseText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  ctx.work.parserVersion = 'native';
  ctx.parserUsed = 'text';
  await ctx.writer.setFields(document.id, { parser_used: 'text', parser_version: 'native' });
  return { kind: 'next' };
}

export const parseStage: StageSpec = { name: 'parse', minMsNeeded: 0, run };
