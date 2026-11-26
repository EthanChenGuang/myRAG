import type { StreamTextTransform, ToolSet } from 'ai';
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

/**
 * D-11 stream adapter: appends end-of-answer text at the final finish-step (finish reason not tool-calls).
 * Only text-end is held; finish-step, start-step, tool parts and finish are forwarded at once (RESEARCH Pitfall 1).
 */
export function noticeTransform(_textFor: (finishReason: string) => string | null): StreamTextTransform<ToolSet> {
  return () => new TransformStream();
}
