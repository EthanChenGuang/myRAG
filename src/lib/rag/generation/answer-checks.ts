import { AnswerChecksSchema, type AnswerSentence, type CitationRecord } from '@/lib/rag-eval/contracts.generated';
import type { z } from 'zod/v3';
import type { AnswerCollector } from './answer-collector';
import { answerTextHash } from './sentences-record';
import type { OutputGuardLinkSummary } from '../security/output-guard';
import { detectMixedVersions, versionConflictTrace, type VersionConflict } from '../context/version-conflicts';

export type OutputGuardCheck = NonNullable<z.infer<typeof AnswerChecksSchema>['output_guard']>;
export type VersionConflictCheck = NonNullable<z.infer<typeof AnswerChecksSchema>['version_conflict']>;

/** What the output guard of this turn found (D-39, D-41); the summary's in-memory fields are never copied. */
export interface OutputGuardChecksSource {
  summary: OutputGuardLinkSummary;
  sourceChunkIds: readonly string[];
  /** Filled when the event writer returns ids; empty otherwise. */
  eventIds?: readonly string[];
}

/** The part of `checks` known at stream end (D-23). */
export interface AnswerChecksInput {
  sentences?: AnswerSentence[];
  output_guard?: OutputGuardCheck;
  /** D-52: present only when the retrieval result carries a version conflict. */
  version_conflict?: VersionConflictCheck;
  truncated: boolean;
  finish_reason: string | null;
}

export interface BuildAnswerChecksInput {
  collector: AnswerCollector;
  citationRecords?: readonly CitationRecord[] | null;
  retrievalResult?: unknown;
  outputGuard?: OutputGuardChecksSource | null;
  /** The user's question; the temporal detector reads it for the mixed-versions check (D-52). */
  question?: string;
}

const FINISH_REASON = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * D-23, D-33: sentences (when computed for this turn), truncated and finish_reason, validated with the generated schema.
 * `retrievalResult` gives the version conflict (D-52); `citationRecords` is read by the claim check.
 */
export function buildAnswerChecksInput(input: BuildAnswerChecksInput): AnswerChecksInput {
  const { collector } = input;
  const reason = collector.finishReason();
  const checks: AnswerChecksInput = {
    truncated: collector.truncated(),
    finish_reason: reason === null ? null : FINISH_REASON.test(reason) ? reason : 'other',
  };
  const sentences = collector.sentences();
  if (sentences) checks.sentences = sentences;
  if (input.outputGuard) checks.output_guard = outputGuardCheck(input.outputGuard, collector);
  const versionConflict = versionConflictCheck(input.retrievalResult, collector, input.question);
  if (versionConflict) checks.version_conflict = versionConflict;
  AnswerChecksSchema.parse(checks);
  return checks;
}

type ConflictSource = { versionConflict?: VersionConflict; blocks?: Array<{ documentId: string; text: string; isImage?: boolean }> };

function conflictSourceOf(value: unknown): ConflictSource | null {
  if (!value || typeof value !== 'object') return null;
  const conflict = (value as ConflictSource).versionConflict;
  if (!conflict || typeof conflict !== 'object' || !Array.isArray(conflict.pairs) || !Array.isArray(conflict.document_ids)) return null;
  return value as ConflictSource;
}

/** D-52: the conflict of the retrieval result with mixed_versions computed on the collector's final text; the text is not changed. */
export function versionConflictCheck(
  retrievalResult: unknown,
  collector: Pick<AnswerCollector, 'finalText'>,
  question: string | undefined,
): VersionConflictCheck | null {
  const source = conflictSourceOf(retrievalResult);
  if (!source?.versionConflict) return null;
  const mixed = detectMixedVersions({
    answerText: collector.finalText(),
    conflict: source.versionConflict,
    blocks: source.blocks ?? [],
    question: question ?? '',
  });
  return versionConflictTrace(source.versionConflict, mixed) as VersionConflictCheck;
}

/**
 * D-23, D-39, UI-SPEC 6.5: counts, rule ids, attributed chunk ids and event ids of the output guard, plus each late-blocked
 * sentence as a range of the text part the collector saw (part index and text hash), so the web UI can mark it blocked.
 */
export function outputGuardCheck(source: OutputGuardChecksSource, collector: Pick<AnswerCollector, 'textPartById'>): OutputGuardCheck {
  const { summary } = source;
  const check: OutputGuardCheck = {
    mode: summary.mode,
    rules_version: summary.rules_version,
    links_checked: summary.links_checked,
    links_removed: summary.links_removed,
    credential_blocked: summary.credential_blocked,
    credential_warned: summary.credential_warned,
    rule_ids: [...summary.rule_ids],
    source_chunk_ids: [...source.sourceChunkIds],
    event_ids: [...(source.eventIds ?? [])],
  };
  const ranges: NonNullable<OutputGuardCheck['blocked_ranges']> = [];
  for (const range of summary.blockedRanges) {
    const part = collector.textPartById(range.textId);
    if (!part || range.end > part.text.length || range.start > range.end) continue;
    ranges.push({ part: part.index, start: range.start, end: range.end, text_hash: answerTextHash(part.text) });
  }
  if (ranges.length > 0) check.blocked_ranges = ranges;
  return check;
}
