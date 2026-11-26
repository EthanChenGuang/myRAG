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
 * Chunk preparation (D-06 to D-11, D-17 to D-20): page boilerplate cleaning while the effective mode is not off, and the tenant's section
 * rules while RAG_SECTION_RULES is effectively on. The snapshot in the saved state makes a resumed run replay the first run without the
 * tenant's rules or the worker. When the rules select another chunker, the run's identity is replaced by a copy whose profile carries it,
 * so every later reader of the identity (the dual-write of live chunking profiles) cuts the same way. Returns the chunker, or a yield.
 */
async function prepare(ctx: StageContext, identity: IngestIdentity): Promise<{ chunker: ChunkerConfig } | { outcome: StageOutcome }> {
  const mode = ctx.config.pageBoilerplate;
  const sectionRules = ctx.config.sectionRules ?? 'off';
  const baseChunker = identity.profile.chunker;
  if (mode === 'off' && sectionRules === 'off') return { chunker: baseChunker };
  if (baseChunker.kind === 'image_caption') {
    if (mode !== 'off') ctx.state.chunkPrep = ctx.state.chunkPrep ?? uncleanedSnapshot(mode);
    return { chunker: baseChunker };
  }

  const snapshot = ctx.state.chunkPrep ?? null;
  let rules: TenantRules | null = null;
  if (!snapshot && (mode === 'rules' || mode === 'both' || sectionRules === 'on')) {
    rules = await loadTenantRules(ctx.input.scope, { docType: identity.docType, source: ctx.input.source }, { signal: ctx.signal });
  }
  const pageLines = !snapshot && needsPageLines(mode, rules)
    ? await loadPageLines(ctx, { reuseOfVersion: ctx.state.typeChange?.sanitizedParse ? null : (ctx.state.typeChange?.reuseParseOfVersion ?? null) })
    : null;
  if (needsPatternCall(mode, rules, snapshot, sectionRules) && ctx.deadline - ctx.deps.now() < TENANT_LINE_DEFAULT_DEADLINE_MS + PATTERN_CALL_MARGIN_MS) {
    return { outcome: { kind: 'yield', reason: 'deadline' } };
  }

  const prepared = await prepareChunkInput({
    markdown: ctx.work.parseText ?? '',
    parseChunks: ctx.work.parseChunks ?? null,
    pageLines,
    baseChunker,
    mode,
    sectionRules,
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
      { report: mode === 'off' ? null : prepared.report, review: prepared.review, sectionRules: prepared.sectionRules },
      { signal: ctx.signal },
    );
  }
  ctx.state.chunkPrep = prepared.snapshot;
  if (prepared.chunker !== baseChunker) ctx.identity = { ...identity, profile: { ...identity.profile, chunker: prepared.chunker } };
  return { chunker: prepared.chunker };
}

function preparesChunks(config: StageContext['config'] | undefined): boolean {
  if (!config) return false;
  return (config.pageBoilerplate !== undefined && config.pageBoilerplate !== 'off') || config.sectionRules === 'on';
}

async function run(ctx: StageContext): Promise<StageOutcome> {
  const identity = requireIdentity(ctx, 'chunk');

  let chunker = identity.profile.chunker;
  if (preparesChunks(ctx.config)) {
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
