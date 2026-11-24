import { chunkMarkdownSections } from '../chunkers/markdown-sections';
import type { ProcessingProfile } from '../profiles/load';
import {
  requireIdentity,
  type ChunkDraft,
  type StageContext,
  type StageOutcome,
  type StageSpec,
} from '../types';

type ChunkerKind = ProcessingProfile['chunker']['kind'];
type Chunker = (text: string, profile: ProcessingProfile) => ChunkDraft[];

/** Chunkers by profile chunker kind; plans that add a chunker register it here. */
const CHUNKERS: Partial<Record<ChunkerKind, Chunker>> = {
  markdown_sections: (text, profile) =>
    chunkMarkdownSections(text, {
      maxTokens: profile.chunker.max_tokens,
      overlapTokens: profile.chunker.overlap_tokens,
      minChunkTokens: profile.chunker.min_chunk_tokens,
      repeatTableHeader: profile.chunker.repeat_table_header,
    }),
};

async function run(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'chunk');
  const kind = identity.profile.chunker.kind;
  const chunker = CHUNKERS[kind];
  if (!chunker) ctx.warnings.push(`chunker_fallback:${kind}`);

  const drafts = (chunker ?? CHUNKERS.markdown_sections)?.(ctx.work.parseText ?? '', identity.profile) ?? [];
  if (drafts.length === 0) return { kind: 'fail', reason: 'no_chunks' };

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
