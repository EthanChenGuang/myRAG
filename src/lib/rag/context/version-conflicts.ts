import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupersessionRules } from '@/lib/rag-eval/contracts.generated';
import { enqueueReviewItem, type EnqueueReviewItemDeps } from '../feedback-loop/enqueue-item';
import { pairSignals, supersessionRules, type SupersessionDocument, type SupersessionSignals } from '../ingest/versions/detect';
import { sameDocType } from '../ingest/profiles/same-doc-type';
import { getRagDeps } from '../deps';
import { analyzeQuery } from '../query/temporal-query-detector';
import { scanProtected } from '../query/protected';
import { scheduleAfterResponse } from '../trace/schedule';
import { effectiveDateOf } from './version-labels';

/**
 * D-52: version conflicts among the context blocks, by rules only and before generation. A version group is two blocks of different
 * documents of one doc type that a supersession row connects, or whose titles are equal once the registry's version markers are removed
 * (Phase 3.2 D-41 rule a). A group is a conflict when the texts overlap strongly and differ in at least one number or date (rule b on
 * block text). The older block is labelled, never dropped; the conflict is handed to the supersession candidates and the review queue
 * after the response, and nothing is superseded here. Logs carry ids and counts only.
 */

export type VersionGroupRule = 'supersession_link' | 'supersession_candidate' | 'title_match';

/** A rag_supersession_candidates row between two documents of the request; confirmed rows carry the link (0806). */
export interface VersionPairRow {
  documentId: string;
  candidateDocumentId: string;
  status: 'pending' | 'confirmed';
}

/** One document's part of the context: its block texts joined, with the row facts the rules read. */
export interface VersionBlock {
  documentId: string;
  filename: string;
  docType: string | null;
  language?: string | null;
  effectiveFrom: string | null;
  version: number | null;
  text: string;
}

export interface VersionGroup {
  blocks: [VersionBlock, VersionBlock];
  rule: VersionGroupRule;
}

export interface VersionConflictPair {
  /** Context order: the block rendered first comes first. */
  documentIds: [string, string];
  /** Null when neither the effective dates nor the versions decide; the admin then chooses. */
  newerDocumentId: string | null;
  olderDocumentId: string | null;
  rule: VersionGroupRule;
  signals: SupersessionSignals;
}

/** The trace and result shape (RagTrace.version_conflict, checks.version_conflict) plus the pairs the hand-off writes. */
export interface VersionConflict {
  document_ids: string[];
  latest_document_id: string;
  group_rule: VersionGroupRule;
  pairs: VersionConflictPair[];
}

/** D-52 rule b on block text: at least one differing number or date (the whole-document detector asks for more). */
const MIN_BLOCK_CONFLICTING_NUMBERS = 1;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function asSupersessionDocument(block: VersionBlock): SupersessionDocument {
  return {
    documentId: block.documentId,
    lineageId: null,
    filename: block.filename,
    docType: block.docType,
    language: block.language ?? null,
    docDate: null,
    effectiveFrom: block.effectiveFrom,
    contentHash: null,
    content: block.text,
  };
}

/** Pairs of blocks that form a version group: a supersession row first (confirmed before pending), else the title rule. */
export function findVersionGroups(
  blocks: readonly VersionBlock[],
  links: readonly VersionPairRow[],
  rules: SupersessionRules = supersessionRules(),
): VersionGroup[] {
  const rowRule = new Map<string, VersionGroupRule>();
  for (const row of links) {
    const key = pairKey(row.documentId.toLowerCase(), row.candidateDocumentId.toLowerCase());
    if (row.status === 'confirmed') rowRule.set(key, 'supersession_link');
    else if (!rowRule.has(key)) rowRule.set(key, 'supersession_candidate');
  }
  const groups: VersionGroup[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      if (a.documentId === b.documentId || !sameDocType(a.docType, b.docType)) continue;
      const linked = rowRule.get(pairKey(a.documentId.toLowerCase(), b.documentId.toLowerCase()));
      if (linked) {
        groups.push({ blocks: [a, b], rule: linked });
        continue;
      }
      if (pairSignals(asSupersessionDocument(a), asSupersessionDocument(b), rules).signals.title_match) {
        groups.push({ blocks: [a, b], rule: 'title_match' });
      }
    }
  }
  return groups;
}

function compare<T extends string | number>(a: T | null, b: T | null): 'a' | 'b' | null {
  if (a === null || b === null || a === b) return null;
  return a > b ? 'a' : 'b';
}

/** The newer block: the later effective date, else the higher version; null when neither decides. */
function newerOf(a: VersionBlock, b: VersionBlock): VersionBlock | null {
  const side = compare(a.effectiveFrom, b.effectiveFrom) ?? compare(a.version, b.version);
  return side === 'a' ? a : side === 'b' ? b : null;
}

/** The groups whose texts overlap strongly (rules' content_overlap_min_percent) and differ in at least one number or date. */
export function findVersionConflicts(groups: readonly VersionGroup[], rules: SupersessionRules = supersessionRules()): VersionConflictPair[] {
  const out: VersionConflictPair[] = [];
  for (const group of groups) {
    const [a, b] = group.blocks;
    const { signals } = pairSignals(asSupersessionDocument(a), asSupersessionDocument(b), rules);
    if (signals.content_overlap_percent < rules.content_overlap_min_percent) continue;
    if (signals.conflicting_numbers < MIN_BLOCK_CONFLICTING_NUMBERS) continue;
    const newer = newerOf(a, b);
    const older = newer === null ? null : newer === a ? b : a;
    out.push({
      documentIds: [a.documentId, b.documentId],
      newerDocumentId: newer?.documentId ?? null,
      olderDocumentId: older?.documentId ?? null,
      rule: group.rule,
      signals,
    });
  }
  return out;
}

/** The result field for the conflicts found, or null; the first pair (context order) names the rule and the latest document. */
export function summarizeVersionConflicts(pairs: readonly VersionConflictPair[]): VersionConflict | null {
  if (pairs.length === 0) return null;
  const ids: string[] = [];
  for (const pair of pairs) for (const id of pair.documentIds) if (!ids.includes(id)) ids.push(id);
  const first = pairs[0]!;
  return {
    document_ids: ids,
    latest_document_id: first.newerDocumentId ?? first.documentIds[0],
    group_rule: first.rule,
    pairs: pairs.map((pair) => ({ ...pair, documentIds: [...pair.documentIds] as [string, string], signals: { ...pair.signals } })),
  };
}

/** The contract shape (strict schema): the pairs stay in memory. */
export function versionConflictTrace(
  conflict: VersionConflict,
  mixedVersions?: boolean,
): { document_ids: string[]; latest_document_id: string; group_rule: VersionGroupRule; mixed_versions?: boolean } {
  return {
    document_ids: [...conflict.document_ids],
    latest_document_id: conflict.latest_document_id,
    group_rule: conflict.group_rule,
    ...(mixedVersions !== undefined ? { mixed_versions: mixedVersions } : {}),
  };
}

/** Scalar stage attributes for the trace (ids and counts only); undefined without a conflict so the stage record is unchanged. */
export function versionConflictAttributes(conflict: VersionConflict | null | undefined): Record<string, string | number> | undefined {
  if (!conflict) return undefined;
  return {
    version_conflict_rule: conflict.group_rule,
    version_conflict_latest_document_id: conflict.latest_document_id,
    version_conflict_document_ids: conflict.document_ids.join(','),
    version_conflict_pairs: conflict.pairs.length,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Builds the per-document view the rules read from the row and the document's block texts in context order. */
export function versionBlockOf(
  documentId: string,
  row: { filename?: string | null; doc_type?: string | null; version?: number | null; effective_from?: string | null; doc_date?: string | null } | undefined,
  texts: readonly string[],
): VersionBlock | null {
  if (!row || texts.length === 0) return null;
  return {
    documentId,
    filename: row.filename ?? '',
    docType: stringOrNull(row.doc_type),
    effectiveFrom: effectiveDateOf(row),
    version: typeof row.version === 'number' && Number.isFinite(row.version) ? row.version : null,
    text: texts.join('\n\n'),
  };
}

// --- Batched supersession read --------------------------------------------------------------------------------------------------

const PAIR_STATUSES = ['pending', 'confirmed'] as const;

/**
 * D-52, T-05.2-223: the candidate and link rows between the request's documents in one query on the admin client, filtered by the
 * request's tenant key and both document ids. Confirmed candidates are the ones a link was written for (0806). A failure returns no
 * rows, so groups fall back to the title rule.
 */
export async function fetchVersionPairs(
  adminClient: SupabaseClient,
  documentIds: readonly string[],
  { tenantKey, signal }: { tenantKey: string; signal: AbortSignal },
): Promise<VersionPairRow[]> {
  const ids = [...new Set(documentIds)];
  if (ids.length < 2) return [];
  const { data, error } = await adminClient
    .from('rag_supersession_candidates')
    .select('document_id, candidate_document_id, status')
    .eq('tenant_key', tenantKey)
    .in('document_id', ids)
    .in('candidate_document_id', ids)
    .in('status', [...PAIR_STATUSES])
    .abortSignal(signal);
  signal.throwIfAborted();
  if (error) {
    console.warn('[RAG Context] supersession rows lookup failed', { code: (error as { code?: string }).code ?? 'unknown' });
    return [];
  }
  const out: VersionPairRow[] = [];
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const documentId = row.document_id;
    const candidateDocumentId = row.candidate_document_id;
    const status = row.status;
    if (typeof documentId !== 'string' || typeof candidateDocumentId !== 'string') continue;
    if (status !== 'pending' && status !== 'confirmed') continue;
    out.push({ documentId, candidateDocumentId, status });
  }
  return out;
}

// --- Hand-off after the response ------------------------------------------------------------------------------------------------

type RpcResult = { data: unknown; error: unknown };

export interface RecordAnswerConflictDeps {
  rpc?: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcResult>;
  enqueue?: typeof enqueueReviewItem;
  enqueueDeps?: EnqueueReviewItemDeps;
  /** Defaults to scheduleAfterResponse; tests pass a runner that awaits. */
  schedule?: (task: () => Promise<void>) => void;
  log?: (line: string, detail: Record<string, unknown>) => void;
}

function reasonOf(error: unknown): string {
  const message = error && typeof error === 'object' ? (error as { message?: unknown }).message : null;
  return /^[a-z_]+/u.exec(typeof message === 'string' ? message : '')?.[0] ?? 'unknown';
}

/** Writes the pending candidates and the review item now; recordAnswerConflict schedules it after the response. Never throws. */
export async function writeAnswerConflict(
  input: { tenantKey: string; conflict: VersionConflict; traceId?: string | null; accessSets?: readonly (readonly string[])[] | null },
  deps: RecordAnswerConflictDeps = {},
): Promise<{ raised: number; failed: number; reviewItem: string | null }> {
  const log = deps.log ?? ((line, detail) => console.warn(line, detail));
  let raised = 0;
  let failed = 0;
  let rpc = deps.rpc;
  if (!rpc) {
    const client = getRagDeps().adminClient();
    if (client) rpc = (fn, args) => client.rpc(fn, args) as unknown as PromiseLike<RpcResult>;
  }
  const seen = new Set<string>();
  for (const pair of input.conflict.pairs) {
    const key = pairKey(pair.documentIds[0], pair.documentIds[1]);
    if (seen.has(key)) continue;
    seen.add(key);
    const [documentId, candidateDocumentId] =
      pair.newerDocumentId !== null && pair.olderDocumentId !== null ? [pair.newerDocumentId, pair.olderDocumentId] : pair.documentIds;
    try {
      if (!rpc) throw new Error('no_admin_client');
      const { error } = await rpc('rag_supersession_raise', {
        p_tenant_key: input.tenantKey,
        p_document_id: documentId,
        p_candidate_document_id: candidateDocumentId,
        p_signals: { ...pair.signals },
        p_direction: pair.newerDocumentId !== null ? 'document_newer' : null,
        p_origin: 'answer_conflict',
      });
      if (error) {
        failed += 1;
        log('[RAG Context] answer conflict candidate not raised', { documentId, candidateDocumentId, reason: reasonOf(error) });
      } else raised += 1;
    } catch (error) {
      failed += 1;
      log('[RAG Context] answer conflict candidate not raised', { documentId, candidateDocumentId, reason: reasonOf(error) });
    }
  }
  const enqueue = deps.enqueue ?? enqueueReviewItem;
  const reviewItem = await enqueue(
    {
      tenantKey: input.tenantKey,
      reason: 'version_conflict',
      documentIds: input.conflict.document_ids,
      detector: 'version_conflict',
      traceId: input.traceId ?? null,
      ...(input.accessSets ? { accessSets: input.accessSets } : {}),
    },
    deps.enqueueDeps,
  );
  return { raised, failed, reviewItem };
}

/** D-52, D-55: schedules the hand-off after the response; the request never waits and never sees a failure. */
export function recordAnswerConflict(
  input: { tenantKey: string; conflict: VersionConflict | null | undefined; traceId?: string | null; accessSets?: readonly (readonly string[])[] | null },
  deps: RecordAnswerConflictDeps = {},
): void {
  const { conflict } = input;
  if (!conflict || conflict.pairs.length === 0) return;
  const schedule = deps.schedule ?? scheduleAfterResponse;
  schedule(async () => {
    await writeAnswerConflict({ tenantKey: input.tenantKey, conflict, traceId: input.traceId, accessSets: input.accessSets }, deps);
  });
}

// --- Mixed versions after generation -------------------------------------------------------------------------------------------

const BARE_NUMBER = /\d+(?:[.,]\d+)*/gu;

/** Number and date tokens: the protected-token scan's literals that carry a digit, plus every bare number. */
export function valueTokens(text: string): Set<string> {
  const normalized = text.normalize('NFKC');
  const out = new Set<string>();
  for (const token of scanProtected(normalized).tokens) if (/\d/u.test(token)) out.add(token);
  for (const match of normalized.matchAll(BARE_NUMBER)) out.add(match[0]);
  return out;
}

/**
 * D-52: true when the answer holds a value found only in the older block and a value found only in the newer block of a conflict, unless
 * the existing temporal detector classes the question as historical. Pairs without an order are skipped. The answer is never changed.
 */
export function detectMixedVersions(input: {
  answerText: string;
  conflict: VersionConflict | null | undefined;
  blocks: ReadonlyArray<{ documentId: string; text: string; isImage?: boolean }>;
  question: string;
}): boolean {
  const { conflict } = input;
  if (!conflict || typeof input.answerText !== 'string' || input.answerText.length === 0) return false;
  if (typeof input.question === 'string' && input.question.length > 0 && analyzeQuery(input.question).isTemporalQuery) return false;
  const answer = valueTokens(input.answerText);
  const textOf = (documentId: string) =>
    input.blocks
      .filter((block) => block.documentId === documentId && !block.isImage)
      .map((block) => block.text)
      .join('\n\n');
  for (const pair of conflict.pairs) {
    if (pair.newerDocumentId === null || pair.olderDocumentId === null) continue;
    const older = valueTokens(textOf(pair.olderDocumentId));
    const newer = valueTokens(textOf(pair.newerDocumentId));
    const onlyOlder = [...older].some((token) => !newer.has(token) && answer.has(token));
    const onlyNewer = [...newer].some((token) => !older.has(token) && answer.has(token));
    if (onlyOlder && onlyNewer) return true;
  }
  return false;
}
