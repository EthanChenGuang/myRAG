import type { StreamTextTransform, ToolSet } from 'ai';
import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';
import { createNoticeState } from './answer-collector';
import type { AnswerChannel } from './answer-turn';
import { emitNotice } from './notices';
import { applySentinelToText } from './sentinel';
import type { AnswerConfig } from './answer-config';
import { calcBlockTransform, extractCalcBlocks, type CalcBlockExtraction, type CalcBlockOptions } from './calc-block';
import { guardWholeText, type OutputGuardLinkSummary, type OutputGuardPolicy } from '../security/output-guard';
import { outputGuardTransform, type OutputGuardTransformOptions } from '../security/output-guard-stream';
import type { CalcCheck } from '@/lib/rag-eval/contracts.generated';
import type { CalcBlock, CalcReviewReason } from '../calc/check-step';
import type { CalcTraceHolder } from '../calc/trace-holder';

type Transform = StreamTextTransform<ToolSet>;

export interface AnswerTransformParts {
  citationTransforms: readonly Transform[];
  sentinel?: Transform | null;
  /** Phase 5.2.1 D-72: the calculation-block transform, or its options (the builder then makes it); absent: no slot. */
  calcBlock?: Transform | CalcBlockOptions | null;
  /** The output guard (05.2-13); see guardSlot. */
  guard?: Transform | null;
  /** Phase 5.2.1 D-73: the calculation check at the final finish-step, after the guard and before the notices; absent: no slot. */
  calcCheck?: CalcCheckSlotInput | null;
  /** The notice transform and the collector, in that order; always last (RESEARCH Pitfall 22). */
  noticeCollector?: readonly Transform[] | null;
}

/** What one calculation check of an answer produced (D-75); numbers, statuses and the duration only. */
export interface CalcCheckRun {
  checks: CalcCheck[];
  primary: CalcCheck | null;
  reviewReasons: CalcReviewReason[];
  durationMs: number;
}

export interface CalcCheckSink {
  record(run: CalcCheckRun): void;
  /** Null while the check has not run on this turn. */
  result(): CalcCheckRun | null;
}

export function createCalcCheckSink(): CalcCheckSink {
  let stored: CalcCheckRun | null = null;
  return {
    record(run) {
      stored = run;
    },
    result: () => stored,
  };
}

export interface CalcCheckSlotInput {
  holder: Pick<CalcTraceHolder, 'traces' | 'invalid' | 'markToolCall'>;
  blocks: readonly CalcBlock[];
  question: string;
  answerLanguage: string;
  /** Whether the tool or the block instruction was offered on this turn. */
  offered: boolean;
  sink: CalcCheckSink;
  /** The collector's notice list (D-11); the notice stage after this slot renders what it receives. */
  addNotice: (notice: AnswerNotice) => void;
  /** The model text the check reads; defaults to the calculation block's raw text, else the text seen at this slot. */
  rawText?: () => string;
}

/**
 * D-35, D-64: the one fixed order citation, sentinel, calculation block, output guard, notice and collector. With nothing but
 * citation transforms the given array is returned unchanged, so the route's experimental_transform is what it is today.
 */
export function buildAnswerTransforms(parts: AnswerTransformParts): Transform[] {
  const rest: Transform[] = [];
  const calcBlock = parts.calcBlock && typeof parts.calcBlock === 'object' ? calcBlockTransform(parts.calcBlock) : parts.calcBlock;
  for (const slot of [parts.sentinel, calcBlock, parts.guard]) if (slot) rest.push(slot);
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
  /** Phase 5.2.1 D-72: removes the trailing calculation block after the sentinel and before the guard; absent: no extraction. */
  calcBlock?: CalcBlockOptions | null;
}

export interface AnswerTextPipelineResult {
  text: string;
  refused: boolean;
  strippedCount: number;
  notices: AnswerNotice[];
  truncated: boolean;
  /** The guard's summary; absent when no guard ran. */
  outputGuard?: OutputGuardLinkSummary;
  /** The extraction (raw text, traces, invalid blocks); absent when no calcBlock input was given. */
  calcBlock?: Omit<CalcBlockExtraction, 'visibleText'>;
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
  let calcBlock: AnswerTextPipelineResult['calcBlock'];
  if (options.calcBlock) {
    const extraction = extractCalcBlocks(out, options.calcBlock);
    out = extraction.visibleText;
    calcBlock = { rawText: extraction.rawText, traces: extraction.traces, invalid: extraction.invalid };
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
  const guardField = { ...(outputGuard ? { outputGuard } : {}), ...(calcBlock ? { calcBlock } : {}) };
  if (options.notices === false) return { text: out, refused, strippedCount, notices: [], truncated: false, ...guardField };
  if (refused) state.markRefused();
  const appended = state.atFinal(options.finishReason ?? 'stop');
  if (appended) out += out ? appended : appended.replace(/^\n+/, '');
  return { text: out, refused, strippedCount, notices: state.notices(), truncated: state.truncated(), ...guardField };
}
