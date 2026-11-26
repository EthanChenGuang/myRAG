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
import type { VersionScope } from '../../backend/types';
import { versionLabelLine, type VersionLabelInfo } from '../../context/version-label';
import { scopeKey, type TenantScope } from '../../tenant/scope';
import { expandParents, selectWithParents, type ParentBudgetCandidate, type ParentSelection } from '../../parents/expand';
import type { RerankSpan } from '../../rerank/types';
import type { FusedHit } from '../../fusion/rrf';
import { resolveFinalResultCount, type RagConfig, type StageName } from '../../config';
import { env } from '@/lib/env';
import { documentNamesFromRows, downweightOrder, injectionDropped, runInjectionStage, runStage, stageSpec, type StageSpec } from '../../pipeline';
import type { SecurityConfig } from '../../security/config';
import { injectionItems, releasedRulesFromRows, type InjectionMarks } from '../../security/injection-check';
import type { TraceCollector } from '../../trace/collector';
import { topkRedundancy } from '../diversify';
import type {
  AlsoIn,
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
  /** D-13: the search stage's effective version scope; absent or current renders today's context. */
  versionScope?: VersionScope;
  /** Picks the version line's language; absent falls back to English. */
  queryLanguage?: string | null;
  /** D-21: the diversify stage's dropped duplicates per kept chunk. */
  alsoIn?: ReadonlyMap<string, AlsoIn[]>;
}

/** D-13: the assemble stage detail when the version lookup failed and the labels were skipped. */
export const VERSION_LABELS_UNAVAILABLE = 'version_labels_unavailable';

interface DocumentVersionRow {
  document_id: string;
  version: number;
  is_current: boolean;
  effective_from: string | null;
  effective_to: string | null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  return value.slice(0, 10);
}

/** One batched rag_document_versions call for the request's documents (0855; tenant asserted in SQL). */
async function fetchDocumentVersions(scope: TenantScope, documentIds: string[], signal: AbortSignal): Promise<Map<string, VersionLabelInfo>> {
  const admin = getRagDeps().adminClient() as RpcClient | null;
  if (!admin) throw new Error('[RAG Context] admin client unavailable');
  const { data, error } = await admin
    .rpc('rag_document_versions', { p_tenant_key: scopeKey(scope), p_document_ids: documentIds })
    .abortSignal(signal);
  if (error) throw new Error(`[RAG Context] rag_document_versions failed (${error.code ?? 'unknown'})`);
  const out = new Map<string, VersionLabelInfo>();
  for (const row of (data ?? []) as DocumentVersionRow[]) {
    if (typeof row.document_id !== 'string' || typeof row.version !== 'number') continue;
    out.set(row.document_id, {
      version: row.version,
      isCurrent: row.is_current === true,
      effectiveFrom: isoDate(row.effective_from),
      effectiveTo: isoDate(row.effective_to),
    });
  }
  return out;
}

/** D-21: the assemble stage detail when the cluster source lookup failed; alsoIn then lists the dropped candidates only. */
export const ALSO_IN_SOURCES_UNAVAILABLE = 'also_in_sources_unavailable';
/** D-21: at most this many other documents are listed under one kept chunk or used document. */
export const ALSO_IN_MAX = 30;
const CLUSTER_SOURCES_MAX_IDS = 50;

interface ClusterSourceRow {
  cluster_id: string;
  document_id: string;
  filename: string | null;
  chunk_id: string;
}

/** One batched rag_dup_cluster_sources call for the request's clusters (0862; tenant asserted in SQL). */
async function fetchClusterSources(scope: TenantScope, clusterIds: string[], signal: AbortSignal): Promise<Map<string, AlsoIn[]>> {
  const admin = getRagDeps().adminClient() as RpcClient | null;
  if (!admin) throw new Error('[RAG Context] admin client unavailable');
  const { data, error } = await admin
    .rpc('rag_dup_cluster_sources', { p_tenant_key: scopeKey(scope), p_cluster_ids: clusterIds, p_limit: ALSO_IN_MAX })
    .abortSignal(signal);
  if (error) throw new Error(`[RAG Context] rag_dup_cluster_sources failed (${error.code ?? 'unknown'})`);
  const out = new Map<string, AlsoIn[]>();
  for (const row of (data ?? []) as ClusterSourceRow[]) {
    if (typeof row.cluster_id !== 'string' || typeof row.document_id !== 'string' || typeof row.chunk_id !== 'string') continue;
    const list = out.get(row.cluster_id) ?? [];
    list.push({ documentId: row.document_id, filename: typeof row.filename === 'string' ? row.filename : '', chunkId: row.chunk_id });
    out.set(row.cluster_id, list);
  }
  return out;
}

/** D-21: the dropped candidates first (rank order), then the cluster's other sources; never the own document, each document once. */
export function mergeAlsoIn(ownDocumentId: string, lists: ReadonlyArray<readonly AlsoIn[] | undefined>, cap: number = ALSO_IN_MAX): AlsoIn[] {
  const seen = new Set<string>([ownDocumentId]);
  const out: AlsoIn[] = [];
  for (const list of lists) {
    for (const entry of list ?? []) {
      if (out.length >= cap) return out;
      if (seen.has(entry.documentId)) continue;
      seen.add(entry.documentId);
      out.push(entry);
    }
  }
  return out;
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
        ...(typeof hit.documentVersion === 'number' ? { version: hit.documentVersion } : {}),
      });
    }
    chunkMetadata.set(hit.chunkId, hit.metadata);
  }
  return { documents, chunkMetadata };
}

export function fusedToCandidate(row: FusedHit, rerankScore?: number): Candidate {
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
    ...(row.standaloneSimilarity !== undefined ? { standaloneSimilarity: row.standaloneSimilarity } : {}),
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

/**
 * Eval only, and only when the request names a result count (the CI max-results negative control): the cap legacy
 * applies to its final results, here applied to the final top-k. Null leaves the v2 output untouched.
 */
export function evalResultCap(profile: Profile, input: RunRetrievalInput): number | null {
  if (profile !== 'eval' || input.options?.maxResults === undefined) return null;
  return resolveFinalResultCount(input.options.maxResults, env.RAG_FINAL_RESULT_COUNT);
}

export function evalFinalTopK(profile: Profile, input: RunRetrievalInput, finalTopK: number): number {
  const cap = evalResultCap(profile, input);
  return cap === null ? finalTopK : Math.min(finalTopK, cap);
}

export async function runContextStages(ctx: ContextStagesInput): Promise<ContextStagesOutput> {
  const { input, config, profile, params, fusedHits, signal, collector, stageOverrides, rerank } = ctx;
  let referenced = ctx.referenced;
  const security = ctx.security ?? getRagDeps().securityConfig();
  const spec = (name: StageName, onFail: StageSpec['onFail']) => stageSpec(config, profile, name, onFail, stageOverrides);
  const settings = v2ProfileSettings(profile, config);
  const resultCap = evalResultCap(profile, input);
  const topHits = fusedHits.slice(0, evalFinalTopK(profile, input, params.final_top_k));
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
    ...(versionLabels ? { versionLabels } : {}),
  });

  const render = (list: Candidate[], groupOrder: string[], blocks?: BlockShape): AssembleOutput<Candidate> => {
    const rendered = assemblyInput(list, groupOrder, blocks);
    return buildContext(filterCandidates(rendered), rendered);
  };

  const filenameOf = (documentId: string) => rows.documents.get(documentId)?.filename ?? 'Unknown Document';

  let injectionMarks: InjectionMarks | null = null;
  let versionLabels: Map<string, string> | null = null;
  let versionInfo: Map<string, VersionLabelInfo> | null = null;
  let versionLookupFailed = false;
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

  // D-21: the cluster source lookup starts next to expand_parents, only with diversity on and a candidate carrying a cluster id.
  const clusterIds = spec('diversify', 'skip').enabled
    ? [...new Set(topHits.map((row) => row.hit.dupClusterId).filter((id): id is string => typeof id === 'string' && id.length > 0))]
        .sort()
        .slice(0, CLUSTER_SOURCES_MAX_IDS)
    : [];
  const clusterSourcesPending: Promise<{ value: Map<string, AlsoIn[]> } | { error: unknown }> | null =
    clusterIds.length > 0
      ? (async () => {
          if (!input.scope) throw new Error('[RAG Context] cluster sources need a tenant scope');
          return fetchClusterSources(input.scope, clusterIds, signal);
        })().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
      : null;

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
      documentNames: documentNamesFromRows(rows.documents),
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

  let clusterSources: Map<string, AlsoIn[]> | null = null;
  let clusterSourcesFailed = false;
  if (clusterSourcesPending) {
    const settled = await clusterSourcesPending;
    if ('value' in settled) {
      clusterSources = settled.value;
    } else {
      if (signal.aborted) throw settled.error;
      clusterSourcesFailed = true;
    }
  }

  // D-13: only a non-current scope looks versions up; a current request makes no call and renders today's context.
  if (ctx.versionScope !== undefined && ctx.versionScope !== 'current') {
    const documentIds = [...new Set(candidates.map((candidate) => candidate.document_id))].sort();
    try {
      if (!input.scope) throw new Error('[RAG Context] version labels need a tenant scope');
      versionInfo = documentIds.length > 0 ? await fetchDocumentVersions(input.scope, documentIds, signal) : new Map();
      versionLabels = new Map([...versionInfo].map(([documentId, info]) => [documentId, versionLabelLine(info, ctx.queryLanguage)]));
    } catch (error) {
      if (signal.aborted) throw error;
      versionLookupFailed = true;
      versionInfo = null;
      versionLabels = null;
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
      const kept = output.kept.map((row) => {
        const dupClusterId = hitById.get(row.chunk_id)?.dupClusterId;
        const dropped = ctx.alsoIn?.get(row.chunk_id);
        const alsoIn =
          clusterSourcesPending && (dropped?.length || dupClusterId)
            ? mergeAlsoIn(row.document_id, [dropped, dupClusterId ? clusterSources?.get(dupClusterId) : undefined])
            : dropped;
        return {
          ...row,
          rank: rankById.get(row.chunk_id) ?? row.rank,
          ...(dupClusterId ? { dupClusterId } : {}),
          ...(alsoIn && alsoIn.length > 0 ? { alsoIn } : {}),
        };
      });
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
        ...(resultCap !== null ? { max_results: resultCap } : {}),
        ...redundancyCount(value.output.kept),
        ...(clusterSources ? { also_in_sources: [...clusterSources.values()].reduce((sum, list) => sum + list.length, 0) } : {}),
      }),
      ...(versionLookupFailed || clusterSourcesFailed
        ? {
            status: () => 'degraded' as const,
            detail: () =>
              [versionLookupFailed ? VERSION_LABELS_UNAVAILABLE : null, clusterSourcesFailed ? ALSO_IN_SOURCES_UNAVAILABLE : null]
                .filter(Boolean)
                .join(','),
          }
        : {}),
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
  if (!labeler) return { assembly: withAlsoIn(withVersionFields(final.output, versionInfo)), candidates, ...injectionOut };
  const labelled = render(final.selected, base.groupOrder, { runs: base.blockRuns, chunkIds: base.blockChunkIds, labeler });
  return {
    assembly: withAlsoIn(withVersionFields({ ...final.output, context: labelled.context, blocks: labelled.blocks }, versionInfo)),
    candidates,
    ...injectionOut,
  };
}

/** D-22, D-34: the top-k redundancy as an integer per mille, only when a kept chunk carries a cluster id. */
function redundancyCount(kept: ReadonlyArray<{ dupClusterId?: string }>): Record<string, number> {
  const share = topkRedundancy(kept);
  return share === null ? {} : { topk_redundancy_permille: Math.round(share * 1000) };
}

/** D-13: version fields on sources only for a non-current scope with a successful lookup; dates are the document's own. */
function withVersionFields(assembly: AssembleOutput<Candidate>, versions: Map<string, VersionLabelInfo> | null): AssembleOutput<Candidate> {
  if (!versions || versions.size === 0) return assembly;
  return {
    ...assembly,
    usedDocuments: assembly.usedDocuments.map((doc) => {
      const info = versions.get(doc.id);
      return info
        ? { ...doc, version: info.version, isCurrent: info.isCurrent, effectiveFrom: info.effectiveFrom, effectiveTo: info.effectiveTo }
        : doc;
    }),
  };
}

/** D-21: a used document lists the other documents of its kept chunks' clusters, merged in kept order; absent when there are none. */
function withAlsoIn(assembly: AssembleOutput<Candidate>): AssembleOutput<Candidate> {
  const listsByDocument = new Map<string, AlsoIn[][]>();
  for (const row of assembly.kept) {
    if (!row.alsoIn || row.alsoIn.length === 0) continue;
    const lists = listsByDocument.get(row.document_id) ?? [];
    lists.push(row.alsoIn);
    listsByDocument.set(row.document_id, lists);
  }
  if (listsByDocument.size === 0) return assembly;
  return {
    ...assembly,
    usedDocuments: assembly.usedDocuments.map((doc) => {
      const lists = listsByDocument.get(doc.id);
      if (!lists) return doc;
      const alsoIn = mergeAlsoIn(doc.id, lists);
      return alsoIn.length > 0 ? { ...doc, alsoIn } : doc;
    }),
  };
}
