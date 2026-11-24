import { hasExtractor, pickDocDate, runChunkExtractors, type DateCandidate } from '../extractors';
import { requireDocument, requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/** Extractors the enrich stage already covers; the profile keeps them listed (D-14). */
const HANDLED_BY_ENRICH = new Set(['urls']);

/**
 * Runs the profile's extractors over every chunk, merges their metadata into the chunk and sets the document date from the
 * highest-confidence full date. Which extractors run comes from profile.extractors only. A listed extractor with no
 * implementation yet (invoice, plan 03-29) is recorded as unavailable instead of silently skipped.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  const { profile } = requireIdentity(ctx, 'extract');
  const names = profile.extractors.filter((name) => !HANDLED_BY_ENRICH.has(name));
  const unavailable = names.filter((name) => !hasExtractor(name));
  for (const name of unavailable) ctx.warnings.push(`extractor_unavailable:${name}`);

  const candidates: Array<DateCandidate & { chunkIndex: number }> = [];
  ctx.work.chunks.forEach((draft, chunkIndex) => {
    const result = runChunkExtractors(names, draft);
    draft.metadata = { ...draft.metadata, ...result.metadata };
    for (const candidate of result.dateCandidates) candidates.push({ ...candidate, chunkIndex });
  });

  const docDate = pickDocDate(candidates);
  if (docDate !== null) await ctx.writer.setFields(requireDocument(ctx, 'extract').id, { doc_date: docDate });

  if (unavailable.length === 0) return { kind: 'next' };
  return { kind: 'next', disabled: true, fallbackReason: 'extractor_unavailable' };
}

export const extractStage: StageSpec = { name: 'extract', minMsNeeded: 0, run };
