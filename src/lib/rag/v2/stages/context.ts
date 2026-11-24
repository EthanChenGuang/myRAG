import {
  buildContext,
  filterCandidates,
  type AssembleInput,
  type AssembleOutput,
  type AssemblyDocumentRow,
} from '../../context/assemble';
import type { AssemblyRows } from '../../context/fetch-rows';
import type { FusedHit } from '../../fusion/rrf';
import type { RagConfig, StageName } from '../../config';
import { runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { TraceCollector } from '../../trace/collector';
import type { Candidate, Profile, ReferencedState, RunRetrievalInput, StageOverrides } from '../../types';
import type { RetrievalParams } from '@/lib/rag-eval/contracts.generated';

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

export async function runContextStages(ctx: ContextStagesInput): Promise<ContextStagesOutput> {
  const { input, config, profile, params, fusedHits, referenced, signal, collector, stageOverrides } = ctx;
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);
  const topHits = fusedHits.slice(0, params.final_top_k);
  const candidates = topHits.map(fusedToCandidate);
  const rows = assemblyRowsFromHits(topHits);

  const assemblyInput = (): AssembleInput<Candidate> => ({
    queryText: input.query,
    candidates,
    documents: rows.documents,
    chunkMetadata: rows.chunkMetadata,
    referenced,
    isGPTModel: input.options?.isGPTModel ?? false,
    ragMode: input.options?.ragMode ?? 'strict',
    webSearchEnabled: input.options?.webSearchEnabled ?? false,
    applyRelevanceFilter: false,
    keptByOverride: 'fused',
  });

  const assembled = await runStage(
    spec('assemble', 'skip'),
    signal,
    () => {
      const filtered = filterCandidates(assemblyInput());
      return buildContext(filtered, assemblyInput());
    },
    collector,
    {
      candidatesIn: candidates.length,
      candidatesOut: (value) => value.usedDocuments.length,
    },
  );

  return {
    assembly: assembled.skipped ? null : assembled.value,
    candidates,
  };
}