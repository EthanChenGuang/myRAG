import { detectLanguage } from '../../lang/detect';
import { getLanguageSettings } from '../../lang/settings';
import { documentExtractors, hasExtractor, pickDocDate, runChunkExtractors, type DateCandidate } from '../extractors';
import { extractEffectiveDates } from '../extractors/effective-dates';
import { suggestScopeTags, type ScopeVocabularyEntry } from '../extractors/scope-suggest';
import { SCOPE_DIMENSIONS, type ScopeDimension } from '../scopes/admin';
import { decideEffectiveDateProposal, recordExtractedEffectiveDates, todayUtc } from '../versions/effective-dates';
import { requireDocument, requireIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/** Extractors the enrich stage already covers; the profile keeps them listed (D-14). */
const HANDLED_BY_ENRICH = new Set(['urls']);
const LANGUAGE_SAMPLE_CHARS = 20000;
const FIRST_PAGE_CHARS = 3000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^(region|legal_entity|department):[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function vocabularyEntry(row: unknown): ScopeVocabularyEntry | null {
  if (row === null || typeof row !== 'object') return null;
  const { dimension, value, label, aliases, active } = row as Record<string, unknown>;
  if (!(SCOPE_DIMENSIONS as readonly unknown[]).includes(dimension) || typeof value !== 'string' || !SLUG.test(value)) return null;
  if (typeof label !== 'string' || typeof active !== 'boolean') return null;
  const names = Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string') : [];
  return { dimension: dimension as ScopeDimension, value, label, aliases: names, active };
}

async function readVocabulary(ctx: StageContext, tenantKey: string): Promise<ScopeVocabularyEntry[] | null> {
  const db = ctx.deps.db();
  if (!db) return null;
  try {
    const response = await db.rpc('rag_scope_vocabulary_for', { p_tenant_key: tenantKey }).abortSignal(ctx.signal);
    if (response.error) return null;
    const rows = Array.isArray(response.data) ? response.data : [];
    return rows.map(vocabularyEntry).filter((entry): entry is ScopeVocabularyEntry => entry !== null);
  } catch (error) {
    ctx.signal.throwIfAborted();
    console.error('[Ingest] scope vocabulary read failed', { error: error instanceof Error ? error.name : 'unknown' });
    return null;
  }
}

/** The first page: the chunks the parser placed on page 1, else the start of the text. */
function firstPageText(ctx: StageContext): string {
  const pageOne = ctx.work.chunks.filter((draft) => draft.page_start === 1).map((draft) => draft.content);
  const text = pageOne.length > 0 ? pageOne.join('\n\n') : documentText(ctx);
  return text.slice(0, FIRST_PAGE_CHARS);
}

/**
 * D-40: with RAG_SCOPE_TAGS and RAG_SCOPE_TAG_SUGGEST on, tag suggestions from the tenant's vocabulary go to
 * documents.metadata.scope_suggestions for an admin to confirm; documents.scopes and the chunks are never touched here. The model
 * step runs only when the doc-type model is allowed too (RAG_DOC_TYPE_LLM_DETECT), the same model and the same consent. Never fails the stage.
 */
async function recordScopeSuggestions(ctx: StageContext, documentId: string, tenantKey: string, filename: string): Promise<void> {
  if (!ctx.config.scopeTags || !ctx.config.scopeTagSuggest) return;
  const vocabulary = await readVocabulary(ctx, tenantKey);
  if (vocabulary === null) {
    ctx.warnings.push('scope_suggestions_unavailable');
    return;
  }
  const uploaderTags = ctx.input.options?.scopes;
  const existing = Array.isArray(uploaderTags) ? uploaderTags.filter((tag): tag is string => typeof tag === 'string' && TAG.test(tag)) : [];
  const { suggestion, warnings } = await suggestScopeTags({
    title: filename.replace(/\.[^./\\]+$/, ''),
    firstPage: firstPageText(ctx),
    vocabulary,
    existing,
    llm: ctx.config.docTypeLlmDetect ? { signal: ctx.signal } : null,
  });
  ctx.warnings.push(...warnings);
  if (suggestion.suggestions.length === 0) return;
  await ctx.writer.setFields(documentId, { metadata: { scope_suggestions: suggestion } });
  console.log('[Ingest] scope tags suggested', { count: suggestion.suggestions.length });
}

/**
 * Runs the profile's extractors over every chunk, merges their metadata into the chunk and sets the document date from the
 * highest-confidence full date. Which extractors run comes from profile.extractors only. Document-level extractors
 * (invoice) run after the chunk-level ones. A listed extractor with no implementation is recorded as unavailable instead of silently skipped.
 * Effective dates (D-43) and scope tag suggestions (D-40) come after them.
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
  await recordScopeSuggestions(ctx, documentId, tenantKey, filename);

  if (unavailable.length === 0) return { kind: 'next' };
  return { kind: 'next', disabled: true, fallbackReason: 'extractor_unavailable' };
}

export const extractStage: StageSpec = { name: 'extract', minMsNeeded: 0, run };
