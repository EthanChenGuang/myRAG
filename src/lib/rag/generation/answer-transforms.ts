import type { StreamTextTransform, ToolSet } from 'ai';
import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';
import { createNoticeState } from './answer-collector';
import type { AnswerChannel } from './answer-turn';
import { applySentinelToText } from './sentinel';

type Transform = StreamTextTransform<ToolSet>;

export interface AnswerTransformParts {
  citationTransforms: readonly Transform[];
  sentinel?: Transform | null;
  /** Reserved for Phase 5.2.1's calculation-block transform. */
  calcBlock?: Transform | null;
  /** Filled by plan 05.2-13 (output guard). */
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

export interface AnswerTextPipelineOptions {
  /** Installs the sentinel with this refusal text; absent or null: no sentinel. */
  refusalText?: string | null;
  finishReason?: string | null;
  language: string | null;
  channel: AnswerChannel;
  /** False skips the notice stage (no truncation notice, nothing appended). */
  notices?: boolean;
}

export interface AnswerTextPipelineResult {
  text: string;
  refused: boolean;
  strippedCount: number;
  notices: AnswerNotice[];
  truncated: boolean;
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
  if (options.notices === false) return { text: out, refused, strippedCount, notices: [], truncated: false };
  const state = createNoticeState({ language: options.language, channel: options.channel });
  if (refused) state.markRefused();
  const appended = state.atFinal(options.finishReason ?? 'stop');
  if (appended) out += out ? appended : appended.replace(/^\n+/, '');
  return { text: out, refused, strippedCount, notices: state.notices(), truncated: state.truncated() };
}
