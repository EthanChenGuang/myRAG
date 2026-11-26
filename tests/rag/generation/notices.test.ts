import { describe, expect, it } from 'vitest';
import { AnswerNoticeSchema } from '@/lib/rag-eval/contracts.generated';
import { fixedText, MissingTextParameterError } from '@/lib/rag/lang/texts';
import { emitNotice, NOTICE_KINDS, renderNoticeAsText, type NoticeKind } from '@/lib/rag/generation/notices';

describe('emitNotice (D-11)', () => {
  it('returns the registry text for the kind and language, valid against AnswerNoticeSchema', () => {
    const notice = emitNotice('answer_truncated', { language: 'it' });
    expect(notice).toEqual({ kind: 'answer_truncated', text: fixedText('notices.answer_truncated', 'it'), language: 'it' });
    expect(AnswerNoticeSchema.parse(notice)).toEqual(notice);
  });

  it.each(['credential_request_blocked', 'credential_request_warning'] as const)('maps %s to its notices key', (kind) => {
    expect(emitNotice(kind, { language: 'zh' }).text).toBe(fixedText(`notices.${kind}`, 'zh'));
  });

  it('rejects a missing parameter', () => {
    expect(() => emitNotice('calc_corrected', { language: 'en' })).toThrow(MissingTextParameterError);
  });

  it('fills a named parameter', () => {
    expect(emitNotice('calc_corrected', { language: 'en', params: { value: '42' } }).text).toBe(
      fixedText('notices.calc_corrected', 'en', { value: '42' }),
    );
  });

  it('lists exactly the kinds this phase emits plus the two reserved for Phase 5.2.1', () => {
    expect([...NOTICE_KINDS].sort()).toEqual(
      ['answer_truncated', 'calc_corrected', 'calc_not_verified', 'credential_request_blocked', 'credential_request_warning'].sort(),
    );
  });

  it('an unknown kind is a type error', () => {
    // @ts-expect-error not a NoticeKind
    const kind: NoticeKind = 'link_removed';
    expect(() => emitNotice(kind, { language: 'en' })).toThrow();
  });
});

describe('renderNoticeAsText (D-11)', () => {
  it('is a blank line followed by the text, and nothing else', () => {
    const notice = emitNotice('answer_truncated', { language: 'en' });
    expect(renderNoticeAsText(notice)).toBe(`\n\n${notice.text}`);
  });
});
