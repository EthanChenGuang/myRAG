import { TENANT_LINE_DEFAULT_DEADLINE_MS } from '../../patterns/tenant-line-pattern';
import { scopeKey } from '../../tenant/scope';
import { ChunkerUnavailableError, chunkDocument, type ChunkerConfig } from '../chunkers';
import {
  applyPrepareOutcome,
  loadPageLines,
  needsPageLines,
  needsPatternCall,
  prepareChunkInput,
  uncleanedSnapshot,
} from '../prepare';
import { loadTenantRules, type TenantRules } from '../rules/load';
import { requireIdentity, type IngestIdentity, type StageContext, type StageOutcome, type StageSpec } from '../types';

/** Time kept free after a worker call, so the stage never starts a pattern call it cannot finish (T-03.3-1001). */
const PATTERN_CALL_MARGIN_MS = 2000;

function pushWarning(ctx: StageContext, warning: string): void {
  if (!ctx.warnings.includes(warning)) ctx.warnings.push(warning);
}

/**
 * Page boilerplate cleaning before chunking (D-06 to D-11). Runs only while the effective mode is not off; the snapshot in the saved state
 * makes a resumed run replay the first run's removal without the tenant's rules or the worker. Returns the chunker to use, or a yield.
 */
async function prepare(ctx: StageContext, identity: IngestIdentity): Promise<{ chunker: ChunkerConfig } | { outcome: StageOutcome }> {
  const mode = ctx.config.pageBoilerplate;
  const baseChunker = identity.profile.chunker;
  if (mode === 'off') return { chunker: baseChunker };
  if (baseChunker.kind === 'image_caption') {
    ctx.state.chunkPrep = ctx.state.chunkPrep ?? uncleanedSnapshot(mode);
    return { chunker: baseChunker };
  }

  const snapshot = ctx.state.chunkPrep ?? null;
  let rules: TenantRules | null = null;
  if (!snapshot && mode !== 'detect') {
    rules = await loadTenantRules(ctx.input.scope, { docType: identity.docType, source: ctx.input.source }, { signal: ctx.signal });
  }
  const pageLines = !snapshot && needsPageLines(mode, rules)
    ? await loadPageLines(ctx, { reuseOfVersion: ctx.state.typeChange?.sanitizedParse ? null : (ctx.state.typeChange?.reuseParseOfVersion ?? null) })
    : null;
  if (needsPatternCall(mode, rules, snapshot) && ctx.deadline - ctx.deps.now() < TENANT_LINE_DEFAULT_DEADLINE_MS + PATTERN_CALL_MARGIN_MS) {
    return { outcome: { kind: 'yield', reason: 'deadline' } };
  }

  const prepared = await prepareChunkInput({
    markdown: ctx.work.parseText ?? '',
    parseChunks: ctx.work.parseChunks ?? null,
    pageLines,
    baseChunker,
    mode,
    rules,
    snapshot,
    deadlineMs: TENANT_LINE_DEFAULT_DEADLINE_MS,
    signal: ctx.signal,
  });
  ctx.work.parseText = prepared.markdown;
  ctx.work.parseChunks = prepared.parseChunks;
  for (const warning of prepared.warnings) pushWarning(ctx, warning);
  if (ctx.document) {
    await applyPrepareOutcome(
      { writer: ctx.writer, db: ctx.deps.db(), documentId: ctx.document.id, tenantKey: scopeKey(ctx.input.scope).toLowerCase() },
      { report: prepared.report, review: prepared.review },
      { signal: ctx.signal },
    );
  }
  ctx.state.chunkPrep = prepared.snapshot;
  return { chunker: prepared.chunker };
}

async function run(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'chunk');

  let chunker = identity.profile.chunker;
  if (ctx.config?.pageBoilerplate !== undefined && ctx.config.pageBoilerplate !== 'off') {
    const prepared = await prepare(ctx, identity);
    if ('outcome' in prepared) return prepared.outcome;
    chunker = prepared.chunker;
  }

  let result;
  try {
    result = chunkDocument(chunker, {
      markdown: ctx.work.parseText ?? '',
      chunks: ctx.work.parseChunks ?? null,
    }, { languageAwareIngest: ctx.config?.languageAwareIngest, tableHeaderRepeat: ctx.config?.tableHeaderRepeat });
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
