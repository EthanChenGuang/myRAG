import type { AnswerNotice } from '@/lib/rag-eval/contracts.generated';
import type { TextParams } from '../lang/texts';

export const NOTICE_KINDS = [] as const;
export type NoticeKind = 'answer_truncated' | 'credential_request_blocked' | 'credential_request_warning' | 'calc_corrected' | 'calc_not_verified';

export interface NoticeOptions {
  language: string;
  params?: TextParams;
}

export function emitNotice(kind: NoticeKind, options: NoticeOptions): AnswerNotice {
  return { kind, text: '', language: options.language };
}

export function renderNoticeAsText(notice: AnswerNotice): string {
  return notice.text;
}
