import type { InjectionCheckMode } from './config';
import { scanText } from './injection-rules';
import type { InjectionSummary, ReferencedSection, ReferencedState } from '../types';

export type ActiveInjectionMode = Exclude<InjectionCheckMode, 'off'>;

/** Time added to the configured stage budget so the stage race never pre-empts the rules or a later inner ML deadline. */
export const INJECTION_STAGE_GUARD_MS = 250;

export interface InjectionCheckItem {
  /** `chunk:<chunk id>` or `ref:<section index>`. */
  key: string;
  kind: 'chunk' | 'reference';
  documentId: string;
  chunkIds: string[];
  text: string;
}

export interface InjectionVerdict {
  flagged: boolean;
  ruleIds: string[];
  /** The matcher threw for this item; it counts as unflagged for this request. */
  error: boolean;
}

export type InjectionVerdicts = ReadonlyMap<string, InjectionVerdict>;

interface ItemCandidate {
  chunk_id: string;
  document_id: string;
  content: string;
  metadata?: Record<string, any> | null;
}

export function chunkKey(chunkId: string): string {
  return `chunk:${chunkId}`;
}

function referenceKey(index: number): string {
  return `ref:${index}`;
}

/** The texts the generator would see: chunk content plus an image caption, and referenced document sections. */
export function injectionItems(
  candidates: readonly ItemCandidate[],
  chunkMetadata: ReadonlyMap<string, Record<string, any> | null> | null,
  referenced: ReferencedState | null,
): InjectionCheckItem[] {
  const items: InjectionCheckItem[] = [];
  referenced?.sections?.forEach((section, index) => {
    if (section.missing || !section.text) return;
    items.push({ key: referenceKey(index), kind: 'reference', documentId: section.documentId, chunkIds: [...section.chunkIds], text: section.text });
  });
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.chunk_id)) continue;
    seen.add(candidate.chunk_id);
    const caption = candidate.metadata?.image_context ?? chunkMetadata?.get(candidate.chunk_id)?.image_context;
    const text = typeof caption === 'string' && caption !== '' ? `${candidate.content}\n${caption}` : candidate.content;
    items.push({ key: chunkKey(candidate.chunk_id), kind: 'chunk', documentId: candidate.document_id, chunkIds: [candidate.chunk_id], text });
  }
  return items;
}

/** Runs the rules on every item synchronously; never awaits, so a stage timeout cannot skip it. */
export function runInjectionCheck(input: { items: readonly InjectionCheckItem[]; mode: ActiveInjectionMode }): InjectionVerdicts {
  const verdicts = new Map<string, InjectionVerdict>();
  for (const item of input.items) {
    try {
      const scan = scanText(item.text);
      verdicts.set(item.key, { flagged: scan.matched, ruleIds: [...scan.rule_ids], error: false });
    } catch {
      console.warn('[RAG Security] Injection rules failed for one item, treated as unflagged', {
        chunkIds: item.chunkIds,
        documentId: item.documentId,
      });
      verdicts.set(item.key, { flagged: false, ruleIds: [], error: true });
    }
  }
  return verdicts;
}

export interface InjectionMarks {
  /** Flagged chunk ids, rendered after unflagged chunks and marked flagged. */
  chunkIds: ReadonlySet<string>;
  /** Indexes of flagged referenced sections, marked flagged. */
  sectionIndexes: ReadonlySet<number>;
}

export interface InjectionApplied<C extends ItemCandidate> {
  candidates: C[];
  referenced: ReferencedState | null;
  summary: InjectionSummary;
  /** Stage counts: items checked, flagged, dropped and downweighted. */
  counts: Record<string, number>;
  /** Set for downweight only. */
  marks: InjectionMarks | null;
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function dropReferences(referenced: ReferencedState, dropped: ReadonlySet<number>, render: (section: ReferencedSection) => string): ReferencedState {
  const sections = referenced.sections ?? [];
  const kept = sections.filter((_, index) => !dropped.has(index));
  const surviving = new Set(kept.map((section) => section.documentId));
  const removed = new Set(sections.filter((_, index) => dropped.has(index)).map((section) => section.documentId));
  return {
    usedDocuments: referenced.usedDocuments.filter((doc) => !removed.has(doc.id) || surviving.has(doc.id)),
    context: kept.map(render).join(''),
    sections: kept,
  };
}

/**
 * flag records only; drop removes flagged candidates and referenced sections (and the referenced document's
 * UsedDocument); downweight removes nothing and returns the marks the renderer uses to move and mark them.
 */
export function applyInjectionAction<C extends ItemCandidate>(input: {
  candidates: readonly C[];
  referenced: ReferencedState | null;
  items: readonly InjectionCheckItem[];
  verdicts: InjectionVerdicts;
  mode: ActiveInjectionMode;
  renderSection: (section: ReferencedSection) => string;
}): InjectionApplied<C> {
  const { items, verdicts, mode } = input;
  const flaggedChunks = new Set<string>();
  const flaggedSections = new Set<number>();
  const flaggedReferenceDocs = new Set<string>();
  const ruleIds = new Set<string>();
  for (const item of items) {
    const verdict = verdicts.get(item.key);
    if (!verdict?.flagged) continue;
    for (const ruleId of verdict.ruleIds) ruleIds.add(ruleId);
    if (item.kind === 'chunk') flaggedChunks.add(item.chunkIds[0]!);
    else {
      flaggedSections.add(Number(item.key.slice('ref:'.length)));
      flaggedReferenceDocs.add(item.documentId);
    }
  }
  const sectionChunkIds = [...flaggedSections].flatMap((index) => input.referenced?.sections?.[index]?.chunkIds ?? []);
  const flagged = flaggedChunks.size > 0 || flaggedSections.size > 0;

  let candidates = [...input.candidates];
  let referenced = input.referenced;
  let dropped: string[] = [];
  let downweighted: string[] = [];
  let marks: InjectionMarks | null = null;

  if (mode === 'drop' && flagged) {
    candidates = candidates.filter((candidate) => !flaggedChunks.has(candidate.chunk_id));
    if (referenced && flaggedSections.size > 0) referenced = dropReferences(referenced, flaggedSections, input.renderSection);
    dropped = unique([...flaggedChunks, ...sectionChunkIds]);
  } else if (mode === 'downweight' && flagged) {
    downweighted = unique(flaggedChunks);
    marks = { chunkIds: flaggedChunks, sectionIndexes: flaggedSections };
  }

  const flaggedItems = flaggedChunks.size + flaggedSections.size;
  return {
    candidates,
    referenced,
    marks,
    counts: {
      checked: items.length,
      flagged: flaggedItems,
      dropped: mode === 'drop' ? flaggedItems : 0,
      downweighted: mode === 'downweight' ? flaggedItems : 0,
    },
    summary: {
      mode,
      checkedCount: items.length,
      flaggedChunkIds: unique([...flaggedChunks, ...sectionChunkIds]),
      flaggedReferenceIds: unique(flaggedReferenceDocs),
      droppedChunkIds: dropped,
      downweightedChunkIds: downweighted,
      droppedReferenceIds: mode === 'drop' ? unique(flaggedReferenceDocs) : [],
      ruleIds: unique(ruleIds),
      detectorsUnavailable: [],
      flagged,
    },
  };
}

/** One summary line per request: ids, rule ids and counts only, never chunk or query text. */
export function logInjectionSummary(summary: InjectionSummary, counts: Record<string, number>, extra: { traceId: string; stalled?: boolean }): void {
  console.log('[RAG Security] Injection check', {
    traceId: extra.traceId,
    mode: summary.mode,
    counts,
    ruleIds: summary.ruleIds,
    flaggedChunkIds: summary.flaggedChunkIds,
    flaggedReferenceIds: summary.flaggedReferenceIds,
    droppedChunkIds: summary.droppedChunkIds,
    ...(extra.stalled ? { stalled: true } : {}),
  });
}

let stallForTests: (() => Promise<void>) | null = null;

/** Test hook: delays the end of the stage after the rules ran, to exercise the stall fail-safe. */
export function setInjectionStallForTests(stall: (() => Promise<void>) | null): void {
  stallForTests = stall;
}

/** The part of the stage after the rules; plan 05.1-21 adds the ML detectors here under their own deadline. */
export function afterRules<T>(value: T): T | Promise<T> {
  if (!stallForTests) return value;
  return stallForTests().then(() => value);
}
