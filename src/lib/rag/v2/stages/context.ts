import {
  buildContext,
  filterCandidates,
  IMAGE_EXTENSIONS,
  type AssembleInput,
  type AssembleOutput,
  type AssemblyDocumentRow,
} from '../../context/assemble';
import { selectWithinBudget, type BudgetCandidate } from '../../context/budget';
import { compressChunks, type CompressibleChunk } from '../../context/compress';
import { edgeOrder } from '../../context/edge-order';
import type { AssemblyRows } from '../../context/fetch-rows';
import { mergeAdjacent, type AdjacentChunk } from '../../context/merge-adjacent';
import { countTokens } from '../../ingest/text/tokens';
import type { RerankSpan } from '../../rerank/types';
import type { FusedHit } from '../../fusion/rrf';
import type { RagConfig, StageName } from '../../config';
import { runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { TraceCollector } from '../../trace/collector';
import type { Candidate, KeptBy, Profile, ReferencedState, RunRetrievalInput, StageOverrides } from '../../types';
import { v2ProfileSettings } from '../profiles';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';

export interface ContextRerankInput {
  ran: boolean;
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
}

export interface ContextStagesOutput {
  assembly: AssembleOutput<Candidate> | null;
  candidates: Candidate[];
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

function fusedToCandidate(row: FusedHit): Candidate {
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

interface AssembleStageValue {
  output: AssembleOutput<Candidate>;
  selected: Candidate[];
  groupOrder: string[];
  budgetTokens: number;
  usedTokens: number;
  groups: number;
}

interface CompressStageValue {
  context: string;
  compressed: number;
  savedTokens: number;
}

export async function runContextStages(ctx: ContextStagesInput): Promise<ContextStagesOutput> {
  const { input, config, profile, params, fusedHits, referenced, signal, collector, stageOverrides, rerank } = ctx;
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);
  const settings = v2ProfileSettings(profile, config);
  const topHits = fusedHits.slice(0, params.final_top_k);
  const candidates = topHits.map(fusedToCandidate);
  const rows = assemblyRowsFromHits(topHits);
  const hitById = new Map(topHits.map((row) => [row.hit.chunkId, row.hit]));
  const rankById = new Map(candidates.map((candidate, index) => [candidate.chunk_id, index + 1]));
  const keptBy: KeptBy = rerank?.ran ? 'rerank' : 'fused';
  const isGPTModel = input.options?.isGPTModel ?? false;

  const assemblyInput = (list: Candidate[], groupOrder: string[]): AssembleInput<Candidate> => ({
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
  });

  const render = (list: Candidate[], groupOrder: string[]): AssembleOutput<Candidate> => {
    const rendered = assemblyInput(list, groupOrder);
    return buildContext(filterCandidates(rendered), rendered);
  };

  const filenameOf = (documentId: string) => rows.documents.get(documentId)?.filename ?? 'Unknown Document';

  const assembled = await runStage(
    spec('assemble', 'skip'),
    signal,
    (): AssembleStageValue => {
      const budgetInput: BudgetCandidate[] = candidates.map((candidate, index) => ({
        rank: index + 1,
        chunk_id: candidate.chunk_id,
        document_id: candidate.document_id,
        document_filename: filenameOf(candidate.document_id),
        content: candidate.content,
      }));
      const selection = selectWithinBudget(
        budgetInput,
        settings.tokenBudget,
        (candidate, { addsDocumentHeader }) => {
          const header = addsDocumentHeader ? `\n--- Document: ${candidate.document_filename} (1 relevant chunks) ---\n\n` : '';
          const label = isGPTModel ? `[Source: ${candidate.document_filename}]\n` : '';
          return `${header}${label}${candidate.content}`;
        },
        { imageExtensions: IMAGE_EXTENSIONS },
      );

      const selectedIds = new Set(selection.selected.map((chosen) => chosen.chunk_id));
      const selected = candidates
        .filter((candidate) => selectedIds.has(candidate.chunk_id))
        .map((candidate) => {
          const truncated = selection.contentOverrides.get(candidate.chunk_id);
          return truncated === undefined ? candidate : { ...candidate, content: truncated };
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
      const groupIds = mergeAdjacent(adjacent).map((group) => group.documentId);
      const groupOrder = config.v2.edgeOrder ? edgeOrder(groupIds) : groupIds;

      const output = render(selected, groupOrder);
      const kept = output.kept.map((row) => ({ ...row, rank: rankById.get(row.chunk_id) ?? row.rank }));
      return {
        output: { ...output, kept },
        selected,
        groupOrder,
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

  if (assembled.skipped) {
    return { assembly: null, candidates };
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
      return { context: render(rewritten, base.groupOrder).context, compressed: changed, savedTokens };
    },
    collector,
    {
      candidatesIn: base.selected.length,
      counts: (value) => ({ compressed: value.compressed, saved_tokens: value.savedTokens }),
    },
  );

  const assembly = compressed.skipped ? base.output : { ...base.output, context: compressed.value.context };
  return { assembly, candidates };
}
