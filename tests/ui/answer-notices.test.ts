import { createHash } from 'node:crypto';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';
import { AnswerNotices, orderNotices } from '@/components/ui/answer-notices';

const EN = FIXED_TEXTS.en.notices;
const notices = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AnswerNotices as never, props as never));
const n = (kind: string, text: string, language = 'en') => ({ kind, text, language });

describe('AnswerNotices', () => {
  test('known kinds in the fixed order with icon and tone, unknown kinds after them', () => {
    const html = notices({
      notices: [n('answer_truncated', EN.answer_truncated!), n('some_future_kind', 'A later notice.'), n('credential_request_blocked', EN.credential_request_blocked!)],
    });
    const kinds = [...html.matchAll(/data-answer-notice="([^"]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(['credential_request_blocked', 'answer_truncated', 'some_future_kind']);
    expect(html).toContain('lucide-shield-x');
    expect(html).toContain('lucide-scissors');
    expect(html).toContain('lucide-info');
    expect(html).toMatch(/data-answer-notice="credential_request_blocked"[^>]*class="[^"]*bg-red-50/);
    expect(html).toMatch(/data-answer-notice="answer_truncated"[^>]*class="[^"]*bg-gray-100/);
    expect(html).toMatch(/data-answer-notice="some_future_kind"[^>]*class="[^"]*bg-gray-100/);
    expect(html).toContain('A later notice.');
    expect(html.match(/role="note"/g)).toHaveLength(3);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(3);
    expect(html).not.toContain('role="alert"');
  });

  test('caution and calculation kinds', () => {
    const html = notices({ notices: [n('calc_not_verified', 'b'), n('calc_corrected', 'a'), n('credential_request_warning', EN.credential_request_warning!)] });
    const kinds = [...html.matchAll(/data-answer-notice="([^"]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(['credential_request_warning', 'calc_corrected', 'calc_not_verified']);
    expect(html).toContain('lucide-shield-alert');
    expect(html).toContain('lucide-calculator');
    expect(html).toMatch(/data-answer-notice="calc_corrected"[^>]*class="[^"]*bg-amber-50/);
  });

  test('an exact duplicate renders once; two different texts of one kind render twice', () => {
    const same = n('answer_truncated', EN.answer_truncated!);
    expect(notices({ notices: [same, { ...same }] }).match(/role="note"/g)).toHaveLength(1);
    expect(notices({ notices: [n('x_kind', 'One.'), n('x_kind', 'Two.')] }).match(/role="note"/g)).toHaveLength(2);
  });

  test('no notice renders no container', () => {
    expect(notices({ notices: [] })).toBe('');
  });

  test('the notice language is set on its block', () => {
    expect(notices({ notices: [n('answer_truncated', FIXED_TEXTS.zh.notices.answer_truncated!, 'zh')] })).toContain('lang="zh"');
  });

  test('markup and javascript: in notice text create no element and no link', () => {
    const html = notices({ notices: [n('x_kind', '<img src=x onerror=alert(1)><a href="javascript:alert(1)">y</a>')] });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(html).not.toMatch(/<a\b/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('calculation notices: corrected amber then not verified grey, one block per notice, each with the Calculator icon (UI-SPEC 14.1, 14.5)', () => {
    const corrected = (lang: 'en' | 'zh' | 'it', value: string) => n('calc_corrected', FIXED_TEXTS[lang].notices.calc_corrected!.replace('{value}', value), lang);
    const html = notices({
      notices: [
        n('calc_not_verified', FIXED_TEXTS.it.notices.calc_not_verified!, 'it'),
        corrected('zh', '1,234.5'),
        corrected('zh', '88'),
        corrected('zh', '88'),
      ],
    });
    const kinds = [...html.matchAll(/data-answer-notice="([^"]+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(['calc_corrected', 'calc_corrected', 'calc_not_verified']);
    expect(html.match(/lucide-calculator/g)).toHaveLength(3);
    expect(html).toMatch(/data-answer-notice="calc_corrected" lang="zh" class="[^"]*bg-amber-50/);
    expect(html).toMatch(/data-answer-notice="calc_not_verified" lang="it" class="[^"]*bg-gray-100/);
    expect(html).toContain('计算已复核：正确结果为 1,234.5。');
    expect(html).toContain(FIXED_TEXTS.it.notices.calc_not_verified!);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  test('markup in a calculation notice text creates no element and no link', () => {
    const html = notices({ notices: [n('calc_corrected', 'Result <img src=x onerror=alert(1)> <a href="javascript:alert(1)">z</a>')] });
    expect(html).not.toMatch(/<img|<a\b/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('orderNotices keeps arrival order among unknown kinds', () => {
    expect(orderNotices([n('z_kind', '1'), n('a_kind', '2'), n('answer_truncated', '3')]).map((x) => x.text)).toEqual(['3', '1', '2']);
  });
});


vi.mock('@/components/providers/auth-provider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ theme: 'light', resolvedTheme: 'light' }) }));
vi.mock('@/components/providers/text-size-provider', () => ({ useTextSize: () => ({ textSize: 'default' }) }));
vi.mock('@/components/providers/font-provider', () => ({ useFont: () => ({ fontFamily: 'inter' }) }));
vi.mock('@/components/providers/artifact-provider', () => ({ useArtifact: () => ({ openArtifact: () => {} }) }));
vi.mock('@/components/providers/model-provider', () => ({ useModel: () => ({ selectedModel: 'test/model' }) }));
vi.mock('@/components/providers/language-provider', () => ({
  useLanguage: () => ({ language: 'en', setLanguage: () => {}, t: (key: string) => key }),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: () => {} }) }));
vi.mock('@/components/ui/markdown', async () => {
  const { default: ReactMarkdown } = await import('react-markdown');
  const { default: remarkGfm } = await import('remark-gfm');
  return {
    Markdown: ({ children, components }: { children?: string; components?: Record<string, unknown> }) =>
      createElement(ReactMarkdown as never, { components, remarkPlugins: [remarkGfm] }, children),
  };
});
vi.mock('@/components/providers/sources-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/providers/sources-provider')>();
  return {
    ...actual,
    useSources: () => ({ sources: [], setSources: () => {}, isSourcesOpen: false, trackedSetIsSourcesOpen: () => {}, hasAvailableSources: false }),
  };
});

describe('ChatMessage notices', async () => {
  const { ChatMessage } = await import('@/components/ui/chat-message');
  const { verifySentenceRecords } = await import('@/lib/chat/sentence-marks');
  const { useAnswerRecordsStore } = await import('@/lib/stores/answer-records-store');
  const recordsInitial = useAnswerRecordsStore.getInitialState() as { records: Record<string, unknown> };
  afterEach(() => { recordsInitial.records = {}; });

  const ANSWER_ID = '5e4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f';
  const TEXT = 'The first value is seven [S1]. The second value is nine. Read more (link removed) later.';
  const HASH = createHash('sha256').update(TEXT, 'utf8').digest('hex');
  const citation = {
    n: 1, alias: 'S1', chunkIds: ['c1'], documentId: 'doc-1', documentName: 'document-a.pdf', documentVersion: 1,
    page: null, quote: 'Quote', quoteHash: 'b'.repeat(64), sectionPath: null, strategy: 'chunk-alias',
  };
  const cited = { answerId: ANSWER_ID, citationStrategy: 'chunk-alias', citations: [citation], answerLanguage: 'en' };
  const blockedNotice = n('credential_request_blocked', EN.credential_request_blocked!);
  const render = (metadata: Record<string, unknown> | undefined, text = TEXT) =>
    renderToStaticMarkup(
      createElement(ChatMessage as never, {
        message: { id: 'm-n', role: 'assistant', parts: [], content: [{ type: 'text', text }], metadata },
        isLastMessage: false,
        isStreaming: false,
      }) as ReactNode as never,
    );

  test('a message that is not citation-aware still shows its notices', () => {
    const html = render({ notices: [n('answer_truncated', EN.answer_truncated!)] });
    expect(html).toContain('data-answer-notice="answer_truncated"');
    expect(html).toContain(EN.answer_truncated!);
  });

  test('with no notices the message is today\'s', () => {
    expect(render({ notices: [] })).toBe(render(undefined));
    expect(render({})).not.toContain('data-answer-notices');
  });

  test('a verified blocked range is replaced, the original is absent and the red notice shows', async () => {
    const blocked = 'The second value is nine.';
    const range = { part: 0, start: TEXT.indexOf(blocked), end: TEXT.indexOf(blocked) + blocked.length, text_hash: HASH };
    await verifySentenceRecords([TEXT], [range] as never);
    const checks = { output_guard: { mode: 'enforce', rules_version: 'r1', blocked_ranges: [range] } };
    const html = render({ ...cited, notices: [blockedNotice], checks });
    expect(html).not.toContain('is nine');
    expect(html.match(new RegExp(EN.credential_request_blocked!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
    expect(html).toContain('data-answer-notice="credential_request_blocked"');
  });

  test('a range that does not verify leaves the sentence and still shows the red notice', async () => {
    const blocked = 'The second value is nine.';
    const range = { part: 0, start: TEXT.indexOf(blocked), end: TEXT.indexOf(blocked) + blocked.length, text_hash: 'c'.repeat(64) };
    await verifySentenceRecords([TEXT], [range] as never);
    const checks = { output_guard: { mode: 'enforce', rules_version: 'r1', blocked_ranges: [range] } };
    const html = render({ ...cited, notices: [blockedNotice], checks });
    expect(html).toContain('The second value is nine.');
    expect(html).toContain('data-answer-notice="credential_request_blocked"');
  });

  test('the link placeholder renders as plain text with no anchor', () => {
    const html = render({ notices: [] });
    expect(html).toContain('(link removed)');
    expect(html).not.toMatch(/<a[^>]*>[^<]*link removed/);
  });

  test('a corrected calculation leaves the number in the answer text unchanged and adds one notice', () => {
    const answer = 'The total is 15, from 5 plus 7.';
    const notice = n('calc_corrected', EN.calc_corrected!.replace('{value}', '12'));
    const html = render({ notices: [notice] }, answer);
    expect(html).toContain('The total is 15, from 5 plus 7.');
    expect(html).not.toMatch(/<(del|s|mark)\b/);
    expect(html.match(/data-answer-notice="calc_corrected"/g)).toHaveLength(1);
    expect(html).toContain('The calculation was rechecked: the correct result is 12.');
  });

  test('a verified calculation shows nothing beyond the answer', () => {
    expect(render({ notices: [], checks: { calc: { status: 'verified' } } })).not.toContain('data-answer-notice');
  });

  test('notices render after the answer text', () => {
    const html = render({ notices: [n('answer_truncated', EN.answer_truncated!)] });
    expect(html.indexOf('The first value')).toBeLessThan(html.indexOf('data-answer-notices'));
  });
});
