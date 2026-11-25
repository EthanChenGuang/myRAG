import { ChunkerUnavailableError, chunkDocument } from '../chunkers';
import { requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

async function run(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'chunk');

  let result;
  try {
    result = chunkDocument(identity.profile.chunker, {
      markdown: ctx.work.parseText ?? '',
      chunks: ctx.work.parseChunks ?? null,
    });
  } catch (error) {
    if (error instanceof ChunkerUnavailableError) return { kind: 'fail', reason: 'chunker_unavailable' };
    throw error;
  }

  const { chunks: drafts, warnings } = result;
  for (const warning of warnings) {
    if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
  }
  // A picture has no text chunk: its caption becomes the only chunk in the images stage.
  ctx.work.captionOnly = result.captionOnly === true;
  if (drafts.length === 0 && !ctx.work.captionOnly) return { kind: 'fail', reason: 'no_chunks' };

  drafts.forEach((draft, index) => {
    draft.metadata = {
      ...draft.metadata,
      document_title: identity.filename,
      chunk_index: index,
      chunk_position: index + 1,
      total_chunks: drafts.length,
    };
  });
  ctx.work.chunks = drafts;
  return { kind: 'next' };
}

export const chunkStage: StageSpec = { name: 'chunk', minMsNeeded: 0, run };
