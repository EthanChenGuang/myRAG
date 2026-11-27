import type { StreamTextTransform, ToolSet } from 'ai';
import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';
import { createNoticeState } from './answer-collector';
import type { AnswerChannel } from './answer-turn';
import { emitNotice } from './notices';
import { applySentinelToText } from './sentinel';
import type { AnswerConfig } from './answer-config';
import { guardWholeText, type OutputGuardLinkSummary, type OutputGuardPolicy } from '../security/output-guard';
import { outputGuardTransform, type OutputGuardTransformOptions } from '../security/output-guard-stream';

type Transform = StreamTextTransform<ToolSet>;

export interface AnswerTransformParts {
  citationTransforms: readonly Transform[];
  sentinel?: Transform | null;
  /** Reserved for Phase 5.2.1's calculation-block transform. */
  calcBlock?: Transform | null;
  /** The output guard (05.2-13); see guardSlot. */
  guard?: Transform | null;
  /** The notice transform and the collector, in that order; always last (RESEARCH Pitfall 22). */
  noticeCollector?: readonly Transform[] | null;
}

/**
 * D-35, D-64: the one fixed order citation, sentinel, calculation block, output guard, notice and collector. With nothing but
 * citation transforms the given array is returned unchanged, so the route's experimental_transform is what it is today.
 */
export function buildAnswerTransforms(parts: AnswerTransformParts): Transform[] {
  const rest: Transform[] = [];
  for (const slot of [parts.sentinel, parts.calcBlock, parts.guard]) if (slot) rest.push(slot);
  if (parts.noticeCollector) rest.push(...parts.noticeCollector);
  if (rest.length === 0) return parts.citationTransforms as Transform[];
  return [...parts.citationTransforms, ...rest];
}

/** D-36: the guard slot; null with RAG_OUTPUT_GUARD off, so the chain is exactly the one without the guard. */
export function guardSlot(mode: AnswerConfig['outputGuard'], options: OutputGuardTransformOptions): Transform | null {
  return mode === 'off' ? null : outputGuardTransform(options);
}

export interface AnswerTextPipelineOptions {
  /** Installs the sentinel with this refusal text; absent or null: no sentinel. */
  refusalText?: string | null;
  finishReason?: string | null;
  language: string | null;
  channel: AnswerChannel;
  /** False skips the notice stage (no truncation notice, nothing appended). */
  notices?: boolean;
  /** D-35: the output guard's whole-text function with this policy, after the sentinel; absent or null: no guard. */
  guard?: OutputGuardPolicy | null;
}

export interface AnswerTextPipelineResult {
  text: string;
  refused: boolean;
  strippedCount: number;
  notices: AnswerNotice[];
  truncated: boolean;
  /** The guard's summary; absent when no guard ran. */
  outputGuard?: OutputGuardLinkSummary;
}

/**
 * Whole-text twin of the stream chain for the eval answer and WhatsApp (RESEARCH Pitfall 21): the same cores in the same order,
 * so the text, refusal flag and notices equal the stream's for the same answer. A string is one step; an array is one text per step.
 */
export function applyAnswerPipelineToText(text: string | readonly string[], options: AnswerTextPipelineOptions): AnswerTextPipelineResult {
  const steps = typeof text === 'string' ? [text] : text;
  let out = steps.join('');
  let refused = false;
  let strippedCount = 0;
  if (options.refusalText) {
    const sentinel = applySentinelToText(steps, options.refusalText);
    out = sentinel.text;
    refused = sentinel.refused;
    strippedCount = sentinel.strippedCount;
  }
  const state = createNoticeState({ language: options.language, channel: options.channel });
  let outputGuard: OutputGuardLinkSummary | undefined;
  if (options.guard) {
    const language = options.language;
    // The stream guard hands its notices to the collector; here they go to the same notice state the final stage renders.
    const guarded = guardWholeText(out, {
      ...options.guard,
      onNotice: (notice) => {
        if (language) state.add(emitNotice(notice.kind, { language }));
      },
    });
    out = guarded.text;
    outputGuard = guarded.summary;
  }
  const guardField = outputGuard ? { outputGuard } : {};
  if (options.notices === false) return { text: out, refused, strippedCount, notices: [], truncated: false, ...guardField };
  if (refused) state.markRefused();
  const appended = state.atFinal(options.finishReason ?? 'stop');
  if (appended) out += out ? appended : appended.replace(/^\n+/, '');
  return { text: out, refused, strippedCount, notices: state.notices(), truncated: state.truncated(), ...guardField };
}
