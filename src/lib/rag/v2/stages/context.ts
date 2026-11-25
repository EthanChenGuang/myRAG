import {
  buildContext,
  filterCandidates,
  IMAGE_EXTENSIONS,
  type AssembleInput,
  type AssembleOutput,
  type AssemblyDocumentRow,
} from '../../context/assemble';
import { selectWithinBudget, type BudgetOptions, type RenderEstimate } from '../../context/budget';
import { compressChunks, type CompressibleChunk } from '../../context/compress';
import { edgeOrder } from '../../context/edge-order';
import type { AssemblyRows } from '../../context/fetch-rows';
import { mergeAdjacent, type AdjacentChunk } from '../../context/merge-adjacent';
import { getRagDeps } from '../../deps';
import { countTokens } from '../../ingest/text/tokens';
import type { RpcClient } from '../../backend/supabase-rpc';
import { expandParents, selectWithParents, type ParentBudgetCandidate, type ParentSelection } from '../../parents/expand';
import type { RerankSpan } from '../../rerank/types';
import type { FusedHit } from '../../fusion/rrf';
import type { RagConfig, StageName } from '../../config';
import { downweightOrder, injectionDropped, runInjectionStage, runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { SecurityConfig } from '../../security/config';
import { injectionItems, releasedRulesFromRows, type InjectionMarks } from '../../security/injection-check';
import type { TraceCollector } from '../../trace/collector';
import type {
  Candidate,
  CitationLabeler,
  InjectionSummary,
  KeptBy,
  Profile,
  ReferencedState,
  RunRetrievalInput,
  StageOverrides,
} from '../../types';
import { v2ProfileSettings } from '../profiles';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';

export interface ContextRerankInput {
  ran: boolean;
  scoreByChunk?: Map<string, number>;
  spansByChunk?: Map<string, RerankSpan[]>;
  prefixLengthByChunk?: Map<string, number>;
}

export interface ContextStagesInput {
  input: RunRetrievalInput;
  config: RagConfig;
  profile: Profile;
  params: RetrievalParams;
  fusedHits: FusedHit[];
  referenced: ReferencedState | null;
  signal: AbortSignal;
  collector: TraceCollector;
  stageOverrides?: StageOverrides;
  rerank?: ContextRerankInput;
  /** Defaults to RagDeps.securityConfig(). */
  security?: SecurityConfig;
}

export interface ContextStagesOutput {
  assembly: AssembleOutput<Candidate> | null;
  candidates: Candidate[];
  /** Present only when RAG_INJECTION_CHECK is on and the stage produced a verdict. */
  injection?: InjectionSummary;
  injectionStalled?: boolean;
}

function assemblyRowsFromHits(hits: FusedHit[]): AssemblyRows {
  const documents = new Map<string, AssemblyDocumentRow>();
  const chunkMetadata = new Map<string, Record<string, unknown> | null>();
  for (const row of hits) {
    const hit = row.hit;
    if (!documents.has(hit.documentId)) {
      documents.set(hit.documentId, {
        id: hit.documentId,
        filename: hit.document.filename,
        created_at: hit.document.createdAt,
        content: hit.document.contentPreview || null,
        metadata: hit.document.metadata,
      });
    }
    chunkMetadata.set(hit.chunkId, hit.metadata);
  }
  return { documents, chunkMetadata };
}

function fusedToCandidate(row: FusedHit, rerankScore?: number): Candidate {
  const similarity = row.hit.similarity ?? 0;
  const legs = Object.fromEntries(Object.entries(row.ranks).map(([key, rank]) => [key, rank]));
  return {
    chunk_id: row.hit.chunkId,
    document_id: row.hit.documentId,
    content: row.hit.content,
    similarity,
    metadata: row.hit.metadata,
    temporal_score: 0,
    financial_score: 0,
    final_score: row.score,
    fused_score: row.score,
    match_reason: `fused: ${row.score.toFixed(4)}`,
    parent_id: row.hit.parentId,
    legs,
    language: row.hit.language,
    ...(rerankScore !== undefined ? { rerank_score: rerankScore } : {}),
  };
}

function isImageFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** A null chunk index never touches a neighbour: each gets its own far-off slot. */
function chunkIndexOf(hit: FusedHit['hit'], rank: number): number {
  return hit.chunkIndex ?? -1_000_000 - rank * 2;
}

interface ExpandStageValue {
  /** Null when no parent came back: assembly then takes the plain child selection. */
  selection: ParentSelection<ParentBudgetCandidate> | null;
  fetched: number;
  /** The children with their parents attached, before budget selection. */
  expanded: ParentBudgetCandidate[];
}

/** Moves flagged entries after the others and renumbers ranks, so budget selection reaches them last. */
function rerankFlaggedLast<C extends ParentBudgetCandidate>(list: C[], flagged: ReadonlySet<string>): C[] {
  return downweightOrder(list, flagged).map((entry, index) => (entry.rank === index + 1 ? entry : { ...entry, rank: index + 1 }));
}

/**
 * Downweighted groups never take an edge slot: without edge order they follow the others; with it the clean groups
 * are edge-ordered and the flagged ones sit in the middle. With fewer than two clean groups an edge cannot be avoided.
 */
export function placeFlaggedGroups(groupIds: string[], flagged: ReadonlySet<string>, edgeOrdered: boolean): string[] {
  const clean = groupIds.filter((id) => !flagged.has(id));
  const marked = groupIds.filter((id) => flagged.has(id));
  if (!edgeOrdered) return [...clean, ...marked];
  const ordered = edgeOrder(clean);
  if (ordered.length < 2) return [...ordered, ...marked];
  const middle = Math.ceil(ordered.length / 2);
  return [...ordered.slice(0, middle), ...marked, ...ordered.slice(middle)];
}

interface AssembleStageValue {
  output: AssembleOutput<Candidate>;
  selected: Candidate[];
  parentChunkIds: Set<string>;
  groupOrder: string[];
  blockRuns: Map<string, string>;
  blockChunkIds: Map<string, string[]>;
  budgetTokens: number;
  usedTokens: number;
  groups: number;
}

interface CompressStageValue {
  output: AssembleOutput<Candidate>;
  selected: Candidate[];
  compressed: number;
  savedTokens: number;
}

export async function runContextStages(ctx: ContextStagesInput): Promise<ContextStagesOutput> {
  const { input, config, profile, params, fusedHits, signal, collector, stageOverrides, rerank } = ctx;
  let referenced = ctx.referenced;
  const security = ctx.security ?? getRagDeps().securityConfig();
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);
  const settings = v2ProfileSettings(profile, config);
  const topHits = fusedHits.slice(0, params.final_top_k);
  let candidates = topHits.map((row) => fusedToCandidate(row, rerank?.scoreByChunk?.get(row.hit.chunkId)));
  const rows = assemblyRowsFromHits(topHits);
  const hitById = new Map(topHits.map((row) => [row.hit.chunkId, row.hit]));
  const rankById = new Map(candidates.map((candidate, index) => [candidate.chunk_id, index + 1]));
  const keptBy: KeptBy = rerank?.ran ? 'rerank' : 'fused';
  const isGPTModel = input.options?.isGPTModel ?? false;

  interface BlockShape {
    runs: Map<string, string>;
    chunkIds: Map<string, string[]>;
    labeler?: CitationLabeler;
  }

  const assemblyInput = (list: Candidate[], groupOrder: string[], blocks?: BlockShape): AssembleInput<Candidate> => ({
    queryText: input.query,
    candidates: list,
    documents: rows.documents,
    chunkMetadata: rows.chunkMetadata,
    referenced,
    isGPTModel,
    ragMode: input.options?.ragMode ?? 'strict',
    webSearchEnabled: input.options?.webSearchEnabled ?? false,
    applyRelevanceFilter: false,
    groupOrder,
    keptByOverride: keptBy,
    blockRuns: blocks?.runs,
    blockChunkIds: blocks?.chunkIds,
    citationLabeler: blocks?.labeler,
    // With tagging on, buildContext renders the final blocks through wrapDocuments on every render (assemble, compress, label).
    ...(security.contextTagging ? { contextTagging: true } : {}),
    ...(injectionMarks ? { injectionMarks } : {}),
  });

  const render = (list: Candidate[], groupOrder: string[], blocks?: BlockShape): AssembleOutput<Candidate> => {
    const rendered = assemblyInput(list, groupOrder, blocks);
    return buildContext(filterCandidates(rendered), rendered);
  };

  const filenameOf = (documentId: string) => rows.documents.get(documentId)?.filename ?? 'Unknown Document';

  let injectionMarks: InjectionMarks | null = null;
  let budgetInput: ParentBudgetCandidate[] = candidates.map((candidate, index) => ({
    rank: index + 1,
    chunk_id: candidate.chunk_id,
    document_id: candidate.document_id,
    document_filename: filenameOf(candidate.document_id),
    content: candidate.content,
    parent_id: candidate.parent_id ?? null,
  }));
  const budgetOptions: BudgetOptions = { imageExtensions: IMAGE_EXTENSIONS };
  const estimateRender: RenderEstimate<ParentBudgetCandidate> = (candidate, { addsDocumentHeader }) => {
    const header = addsDocumentHeader ? `\n--- Document: ${candidate.document_filename} (1 relevant chunks) ---\n\n` : '';
    const label = isGPTModel ? `[Source: ${candidate.document_filename}]\n` : '';
    return `${header}${label}${candidate.content}`;
  };

  const expansion = await runStage(
    spec('expand_parents', 'skip'),
    signal,
    async (stageSignal): Promise<ExpandStageValue> => {
      if (!input.scope) throw new Error('[RAG Context] expand_parents needs a tenant scope');
      const expanded = await expandParents({
        survivors: budgetInput,
        scope: input.scope,
        admin: getRagDeps().adminClient() as RpcClient | null,
        signal: stageSignal,
        eligible: (child) => !isImageFilename(child.document_filename),
      });
      const selection =
        expanded.fetched > 0 ? selectWithParents(expanded.candidates, settings.tokenBudget, estimateRender, budgetOptions) : null;
      return { selection, fetched: expanded.fetched, expanded: expanded.candidates };
    },
    collector,
    {
      candidatesIn: candidates.length,
      candidatesOut: (value) => value.selection?.selected.length ?? candidates.length,
      counts: (value) => ({ parents_fetched: value.fetched, parents_used: value.selection?.parentIds.size ?? 0 }),
    },
  );
  let parentSelection = expansion.skipped || !expansion.value.selection?.parentIds.size ? null : expansion.value.selection;

  // injection_check sits after expand_parents and before budget selection and aliasing (D-06, R3): it sees the
  // candidates with their expanded parent text, captions and referenced sections, so nothing dropped is budgeted or cited.
  let injection: InjectionSummary | undefined;
  let injectionStalled = false;
  if (security.injectionCheck !== 'off') {
    const expandedList = expansion.skipped ? null : expansion.value.expanded;
    const parentTextById = new Map<string, string>();
    for (const entry of expandedList ?? []) if (entry.parent) parentTextById.set(entry.chunk_id, entry.parent.content);
    const checkedTexts = candidates.map((candidate) => {
      const parentText = parentTextById.get(candidate.chunk_id);
      return parentText === undefined ? candidate : { ...candidate, content: `${candidate.content}\n${parentText}` };
    });
    const run = await runInjectionStage({
      spec: spec('injection_check', 'skip'),
      signal,
      collector,
      scope: input.scope ?? null,
      profile,
      security,
      mode: security.injectionCheck,
      items: injectionItems(checkedTexts, rows.chunkMetadata, referenced),
      candidates,
      referenced,
      // Released rule ids come only from the document rows this request's scoped search returned (D-10).
      released: releasedRulesFromRows(rows.documents),
    });
    injectionStalled = run.stalled;
    if (run.applied) {
      injection = run.applied.summary;
      const dropped = injectionDropped(run.applied.summary);
      const flaggedChunks = run.applied.marks?.chunkIds ?? null;
      if (dropped || flaggedChunks) {
        const survivors = new Set(run.applied.candidates.map((candidate) => candidate.chunk_id));
        candidates = run.applied.candidates;
        referenced = run.applied.referenced;
        injectionMarks = run.applied.marks;
        const keep = <C extends ParentBudgetCandidate>(list: C[]): C[] => {
          const kept = list.filter((entry) => survivors.has(entry.chunk_id));
          return flaggedChunks ? rerankFlaggedLast(kept, flaggedChunks) : kept.map((entry, index) => ({ ...entry, rank: index + 1 }));
        };
        budgetInput = keep(budgetInput);
        if (expandedList && !expansion.skipped && expansion.value.fetched > 0) {
          const selection = selectWithParents(keep(expandedList), settings.tokenBudget, estimateRender, budgetOptions);
          parentSelection = selection.parentIds.size ? selection : null;
        } else {
          parentSelection = null;
        }
      }
    }
  }

  const assembled = await runStage(
    spec('assemble', 'skip'),
    signal,
    (): AssembleStageValue => {
      const selection = parentSelection ?? selectWithinBudget(budgetInput, settings.tokenBudget, estimateRender, budgetOptions);

      const chosenById = new Map(selection.selected.map((chosen) => [chosen.chunk_id, chosen]));
      const selected = candidates
        .filter((candidate) => chosenById.has(candidate.chunk_id))
        .map((candidate) => {
          const content =
            selection.contentOverrides.get(candidate.chunk_id) ?? (parentSelection ? chosenById.get(candidate.chunk_id)?.content : undefined);
          return content === undefined || content === candidate.content ? candidate : { ...candidate, content };
        });

      const adjacent: AdjacentChunk[] = selected
        .filter((candidate) => !isImageFilename(filenameOf(candidate.document_id)))
        .map((candidate) => {
          const rank = rankById.get(candidate.chunk_id) ?? 0;
          const source = hitById.get(candidate.chunk_id);
          return {
            chunk_id: candidate.chunk_id,
            document_id: candidate.document_id,
            chunk_index: source ? chunkIndexOf(source, rank) : -1_000_000 - rank * 2,
            parent_id: candidate.parent_id ?? null,
            rank,
          };
        });
      const groups = mergeAdjacent(adjacent);
      const groupIds = groups.map((group) => group.documentId);
      const marks = injectionMarks as InjectionMarks | null;
      const flaggedGroups = new Set(
        marks ? groups.filter((group) => group.runs.flat().some((chunk) => marks.chunkIds.has(chunk.chunk_id))).map((group) => group.documentId) : [],
      );
      const groupOrder =
        flaggedGroups.size > 0
          ? placeFlaggedGroups(groupIds, flaggedGroups, config.v2.edgeOrder)
          : config.v2.edgeOrder
            ? edgeOrder(groupIds)
            : groupIds;

      const blockRuns = new Map<string, string>();
      for (const group of groups) {
        group.runs.forEach((runChunks, index) => {
          for (const chunk of runChunks) blockRuns.set(chunk.chunk_id, `${group.documentId}#${index}`);
        });
      }
      const blockChunkIds = new Map<string, string[]>();
      for (const candidate of selected) {
        const parentId = candidate.parent_id;
        if (!parentId || !parentSelection?.parentChunkIds.has(candidate.chunk_id)) continue;
        const children = candidates
          .filter((child) => child.parent_id === parentId && child.document_id === candidate.document_id)
          .sort(
            (x, y) =>
              chunkIndexOf(hitById.get(x.chunk_id)!, rankById.get(x.chunk_id) ?? 0) -
              chunkIndexOf(hitById.get(y.chunk_id)!, rankById.get(y.chunk_id) ?? 0),
          )
          .map((child) => child.chunk_id);
        blockChunkIds.set(candidate.chunk_id, children);
      }

      const output = render(selected, groupOrder, { runs: blockRuns, chunkIds: blockChunkIds });
      const kept = output.kept.map((row) => ({ ...row, rank: rankById.get(row.chunk_id) ?? row.rank }));
      return {
        output: { ...output, kept },
        selected,
        parentChunkIds: parentSelection?.parentChunkIds ?? new Set<string>(),
        groupOrder,
        blockRuns,
        blockChunkIds,
        budgetTokens: settings.tokenBudget,
        usedTokens: selection.usedTokens,
        groups: groupIds.length,
      };
    },
    collector,
    {
      candidatesIn: candidates.length,
      candidatesOut: (value) => value.output.usedDocuments.length,
      counts: (value) => ({
        selected: value.selected.length,
        budget_tokens: value.budgetTokens,
        used_tokens: value.usedTokens,
        groups: value.groups,
      }),
    },
  );

  const injectionOut = injection ? { injection, injectionStalled } : {};
  if (assembled.skipped) {
    return { assembly: null, candidates, ...injectionOut };
  }

  const base = assembled.value;
  const compressSpec = spec('compress', 'skip');
  const compressed = await runStage(
    settings.compression ? compressSpec : { ...compressSpec, enabled: false },
    signal,
    (): CompressStageValue => {
      const compressible: CompressibleChunk[] = base.selected.map((candidate) => ({
        chunk_id: candidate.chunk_id,
        content: candidate.content,
        chunk_kind: hitById.get(candidate.chunk_id)?.chunkKind ?? null,
        metadata: candidate.metadata,
        language: candidate.language,
        mergedParent: base.parentChunkIds.has(candidate.chunk_id),
      }));
      const result = compressChunks(compressible, {
        query: input.query,
        spansByChunk: rerank?.spansByChunk,
        prefixLengthByChunk: rerank?.prefixLengthByChunk,
        enabled: true,
      });
      const contentById = new Map(result.map((chunk) => [chunk.chunk_id, chunk.content]));
      let changed = 0;
      let savedTokens = 0;
      const rewritten = base.selected.map((candidate) => {
        const next = contentById.get(candidate.chunk_id);
        if (next === undefined || next === candidate.content) return candidate;
        changed += 1;
        savedTokens += Math.max(countTokens(candidate.content) - countTokens(next), 0);
        return { ...candidate, content: next };
      });
      const output = render(rewritten, base.groupOrder, { runs: base.blockRuns, chunkIds: base.blockChunkIds });
      return { output, selected: rewritten, compressed: changed, savedTokens };
    },
    collector,
    {
      candidatesIn: base.selected.length,
      counts: (value) => ({ compressed: value.compressed, saved_tokens: value.savedTokens }),
    },
  );

  const final = compressed.skipped
    ? { output: base.output, selected: base.selected }
    : {
        output: { ...base.output, context: compressed.value.output.context, blocks: compressed.value.output.blocks },
        selected: compressed.value.selected,
      };

  // Labelling is the last context step: it renders the final selection once more, in the same order, with the labels.
  const labeler = input.citationLabeler;
  if (!labeler) return { assembly: final.output, candidates, ...injectionOut };
  const labelled = render(final.selected, base.groupOrder, { runs: base.blockRuns, chunkIds: base.blockChunkIds, labeler });
  return { assembly: { ...final.output, context: labelled.context, blocks: labelled.blocks }, candidates, ...injectionOut };
}
