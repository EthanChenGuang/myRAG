import type { StreamTextTransform, TextStreamPart, ToolSet } from 'ai';
import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';
import { fixedText, type TextKey, type TextParams } from '../lang/texts';

/** D-11: every server-added notice; calc_corrected and calc_not_verified are reserved for Phase 5.2.1. */
export const NOTICE_KINDS = [
  'answer_truncated',
  'credential_request_blocked',
  'credential_request_warning',
  'calc_corrected',
  'calc_not_verified',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

const NOTICE_KEYS: Readonly<Record<NoticeKind, TextKey>> = Object.freeze({
  answer_truncated: 'notices.answer_truncated',
  credential_request_blocked: 'notices.credential_request_blocked',
  credential_request_warning: 'notices.credential_request_warning',
  calc_corrected: 'notices.calc_corrected',
  calc_not_verified: 'notices.calc_not_verified',
});

export interface NoticeOptions {
  language: string;
  params?: TextParams;
}

/** The one notice emitter (D-11): the registry text of the kind in the answer language; a missing parameter throws. */
export function emitNotice(kind: NoticeKind, options: NoticeOptions): AnswerNotice {
  if (!Object.prototype.hasOwnProperty.call(NOTICE_KEYS, kind)) throw new Error(`[Notices] unknown notice kind ${String(kind)}`);
  const text = fixedText(NOTICE_KEYS[kind], options.language, options.params);
  return { kind, text, language: options.language };
}

/** The plain-text form for channels that read text only (WhatsApp, embed, the eval answer): one final delta after a blank line. */
export function renderNoticeAsText(notice: AnswerNotice): string {
  return `\n\n${notice.text}`;
}

type Part = TextStreamPart<ToolSet>;

/**
 * D-11 stream adapter: appends end-of-answer text at the final finish-step (finish reason not tool-calls), into the held text
 * block of that step or a new block when the step has none. `textFor` returns already rendered text (each notice after a blank
 * line); the leading blank line is dropped when no text was streamed before. Only text-end is held; finish-step, start-step, tool
 * parts and finish are forwarded at once (RESEARCH Pitfall 1).
 */
export function noticeTransform(textFor: (finishReason: string) => string | null): StreamTextTransform<ToolSet> {
  return () => {
    let heldEnd: Extract<Part, { type: 'text-end' }> | null = null;
    let emitted = false;
    let appended = false;
    let blocks = 0;
    return new TransformStream<Part, Part>({
      transform(part, controller) {
        if (part.type === 'text-delta' && part.text) emitted = true;
        if (part.type === 'text-end') {
          if (heldEnd) controller.enqueue(heldEnd);
          heldEnd = part;
          return;
        }
        if (part.type === 'finish-step' && part.finishReason !== 'tool-calls' && !appended) {
          appended = true;
          const rendered = textFor(part.finishReason);
          const text = rendered && !emitted ? rendered.replace(/^\n+/, '') : rendered;
          if (text) {
            emitted = true;
            if (heldEnd) {
              controller.enqueue({ type: 'text-delta', id: heldEnd.id, text });
            } else {
              blocks += 1;
              const id = `notice-${blocks}`;
              controller.enqueue({ type: 'text-start', id });
              controller.enqueue({ type: 'text-delta', id, text });
              controller.enqueue({ type: 'text-end', id });
            }
          }
        }
        if (heldEnd) {
          controller.enqueue(heldEnd);
          heldEnd = null;
        }
        controller.enqueue(part);
      },
      flush(controller) {
        if (heldEnd) controller.enqueue(heldEnd);
        heldEnd = null;
      },
    });
  };
}
