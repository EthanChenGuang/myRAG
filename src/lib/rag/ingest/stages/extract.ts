import { detectLanguage } from '../../lang/detect';
import { getLanguageSettings } from '../../lang/settings';
import { documentExtractors, hasExtractor, pickDocDate, runChunkExtractors, type DateCandidate } from '../extractors';
import { extractEffectiveDates } from '../extractors/effective-dates';
import { decideEffectiveDateProposal, recordExtractedEffectiveDates, todayUtc } from '../versions/effective-dates';
import { requireDocument, requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/** Extractors the enrich stage already covers; the profile keeps them listed (D-14). */
const HANDLED_BY_ENRICH = new Set(['urls']);
const LANGUAGE_SAMPLE_CHARS = 20000;

function documentText(ctx: StageContext): string {
  return ctx.work.parseText ?? ctx.work.chunks.map((draft) => draft.content).join('\n\n');
}

/**
 * D-43: effective dates stated in the document. The rules always run here; they only fill the effective-date columns, through the
 * apply rule (a date that keeps the document usable today at confidence 0.8 or more), and otherwise store a proposal for an admin.
 * The model step runs only with RAG_EFFECTIVE_DATE_LLM_EXTRACT. Admin-set dates are kept by the SQL setter. Never fails the stage.
 */
async function recordEffectiveDates(ctx: StageContext, documentId: string, tenantKey: string, filename: string): Promise<void> {
  const text = documentText(ctx);
  if (text.trim() === '') return;
  const language = ctx.work.documentLanguage ?? detectLanguage(text.slice(0, LANGUAGE_SAMPLE_CHARS));
  const { result, warnings } = await extractEffectiveDates(text, {
    language,
    primary: getLanguageSettings().primary,
    llm: ctx.config.effectiveDateLlmExtract ? { filename, signal: ctx.signal } : null,
  });
  ctx.warnings.push(...warnings);
  if (result === null) return;

  const now = new Date(ctx.deps.now());
  const proposal = { from: result.from, to: result.to, confidence: result.confidence };
  const decision = decideEffectiveDateProposal(proposal, { origin: null }, todayUtc(now));
  const recorded = await recordExtractedEffectiveDates({
    documentId,
    tenantKey,
    proposal: { ...proposal, evidenceQuote: result.evidenceQuote },
    current: { origin: null },
    now,
    signal: ctx.signal,
  });
  ctx.signal.throwIfAborted();
  if (!recorded.ok) {
    ctx.warnings.push('effective_dates_unavailable');
    return;
  }
  console.log('[Ingest] effective dates', { decision, outcome: recorded.outcome, source: result.source });
}

/**
 * Runs the profile's extractors over every chunk, merges their metadata into the chunk and sets the document date from the
 * highest-confidence full date. Which extractors run comes from profile.extractors only. Document-level extractors
 * (invoice) run after the chunk-level ones. A listed extractor with no implementation is recorded as unavailable instead of silently skipped.
 * Effective dates (D-43) are read from the whole document text after them.
 */
async function run(ctx: StageContext): Promise<StageOutcome> {
  const { profile, tenantKey, filename } = requireIdentity(ctx, 'extract');
  const names = profile.extractors.filter((name) => !HANDLED_BY_ENRICH.has(name));
  const unavailable = names.filter((name) => !hasExtractor(name));
  for (const name of unavailable) ctx.warnings.push(`extractor_unavailable:${name}`);

  const candidates: Array<DateCandidate & { chunkIndex: number }> = [];
  ctx.work.chunks.forEach((draft, chunkIndex) => {
    const result = runChunkExtractors(names, draft);
    draft.metadata = { ...draft.metadata, ...result.metadata };
    for (const candidate of result.dateCandidates) candidates.push({ ...candidate, chunkIndex });
  });

  const documentId = requireDocument(ctx, 'extract').id;
  const docDate = pickDocDate(candidates);
  if (docDate !== null) await ctx.writer.setFields(documentId, { doc_date: docDate });

  for (const extractor of documentExtractors(names)) await extractor.run(ctx);

  await recordEffectiveDates(ctx, documentId, tenantKey, filename);

  if (unavailable.length === 0) return { kind: 'next' };
  return { kind: 'next', disabled: true, fallbackReason: 'extractor_unavailable' };
}

export const extractStage: StageSpec = { name: 'extract', minMsNeeded: 0, run };
