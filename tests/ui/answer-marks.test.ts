import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';
import { SentenceMark } from '@/components/ui/sentence-mark';
import { AnswerMarkLegend, legendAnnouncement, legendItemText } from '@/components/ui/answer-mark-legend';

const EN = FIXED_TEXTS.en.notices;
const ZH = FIXED_TEXTS.zh.notices;

const mark = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(SentenceMark as never, props as never));
const legend = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AnswerMarkLegend as never, props as never));

describe('SentenceMark', () => {
  test('uncited is a dashed empty circle with its registry text, focusable, not a control', () => {
    const html = mark({ kind: 'uncited', index: 3, text: EN.uncited });
    expect(html).toContain('data-sentence-mark="uncited"');
    expect(html).toContain('data-sentence-index="3"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('border-dashed');
    expect(html).toContain('rounded-full');
    expect(html).toMatch(new RegExp(`<span class="sr-only">${EN.uncited}</span>`));
    expect(html).toMatch(/^<sup[^>]*class="[^"]*align-super/);
    expect(html).not.toMatch(/<button|role="button"|onclick|href=/i);
  });

  test('unsupported is the amber triangle with its registry text', () => {
    const html = mark({ kind: 'unsupported', index: 1, text: EN.not_confirmed });
    expect(html).toContain('data-sentence-mark="unsupported"');
    expect(html).toContain('lucide-triangle-alert');
    expect(html).toContain('text-amber-700');
    expect(html).toContain(`<span class="sr-only">${EN.not_confirmed}</span>`);
    expect(html).toMatch(/aria-hidden="true"/);
  });

  test('lang is set only when it differs from the UI language', () => {
    expect(mark({ kind: 'uncited', index: 0, text: ZH.uncited, lang: 'zh', uiLanguage: 'en' })).toContain('lang="zh"');
    expect(mark({ kind: 'uncited', index: 0, text: EN.uncited, lang: 'en', uiLanguage: 'en' })).not.toContain('lang=');
  });

  test('injected markup in a registry string is text', () => {
    const html = mark({ kind: 'uncited', index: 0, text: '<img src=x onerror=alert(1)><a href="javascript:x">y</a>' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('an empty text renders nothing', () => {
    expect(mark({ kind: 'uncited', index: 0, text: '' })).toBe('');
  });
});

describe('AnswerMarkLegend', () => {
  const texts = { uncited: EN.uncited!, unsupported: EN.not_confirmed! };

  test('one item per kind with a count above zero', () => {
    const html = legend({ counts: { uncited: 2, unsupported: 0 }, texts, language: 'en', uiLanguage: 'en' });
    expect(html).toContain('data-mark-legend');
    expect(html).toContain(`${EN.uncited}: 2`);
    expect(html).not.toContain(EN.not_confirmed!);
    expect(html).toContain('tabular-nums');
  });

  test('both counts zero renders nothing', () => {
    expect(legend({ counts: { uncited: 0, unsupported: 0 }, texts, language: 'en', uiLanguage: 'en' })).toBe('');
  });

  test('zh uses the full-width colon and lang differs from the UI', () => {
    const zh = { uncited: ZH.uncited!, unsupported: ZH.not_confirmed! };
    expect(legendItemText(zh.uncited, 4, 'zh')).toBe(`${ZH.uncited}：4`);
    const html = legend({ counts: { uncited: 1, unsupported: 1 }, texts: zh, language: 'zh', uiLanguage: 'en' });
    expect(html).toContain(`${ZH.not_confirmed}：1`);
    expect(html).toContain('lang="zh"');
  });

  test('the status region exists and is empty on first render', () => {
    const html = legend({ counts: { uncited: 1, unsupported: 1 }, texts, language: 'en', uiLanguage: 'en', live: true });
    expect(html).toMatch(/<span role="status" aria-live="polite" class="sr-only"><\/span>/);
  });

  test('legendAnnouncement names only an item added after the first render', () => {
    expect(legendAnnouncement({ uncited: 1, unsupported: 0 }, { uncited: 1, unsupported: 0 }, texts, 'en')).toBe('');
    expect(legendAnnouncement({ uncited: 1, unsupported: 0 }, { uncited: 1, unsupported: 2 }, texts, 'en')).toBe(`${EN.not_confirmed}: 2`);
    expect(legendAnnouncement({ uncited: 0, unsupported: 1 }, { uncited: 0, unsupported: 1 }, texts, 'en')).toBe('');
  });

  test('injected markup in a registry string is text', () => {
    const html = legend({
      counts: { uncited: 1, unsupported: 0 },
      texts: { uncited: '<img src=x onerror=alert(1)>', unsupported: 'x' },
      language: 'en',
      uiLanguage: 'en',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
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

describe('ChatMessage sentence marks', async () => {
  const { ChatMessage } = await import('@/components/ui/chat-message');
  const { verifySentenceRecords } = await import('@/lib/chat/sentence-marks');
  const { useAnswerRecordsStore } = await import('@/lib/stores/answer-records-store');
  const { useGhostModeStore } = await import('@/lib/ghost-mode-store');

  const ANSWER_ID = '7d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f';
  const TEXT = 'The first value is seven [S1]. The second value is nine. The third value is four.';
  const HASH = createHash('sha256').update(TEXT, 'utf8').digest('hex');
  const at = (sentence: string) => TEXT.indexOf(sentence);
  const sentence = (index: number, text: string, extra: Record<string, unknown> = {}) => ({
    index, part: 0, start: at(text), end: at(text) + text.length, kind: 'sentence', text_hash: HASH,
    factual: true, cited: false, support: 'not_checked', scorer: null, reason: null, ...extra,
  });
  const SENTENCES = [
    sentence(0, 'The first value is seven [S1]. ', { cited: true }),
    sentence(1, 'The second value is nine. '),
    sentence(2, 'The third value is four.'),
  ];
  const citation = {
    n: 1, alias: 'S1', chunkIds: ['c1'], documentId: 'doc-1', documentName: 'document-a.pdf', documentVersion: 1,
    page: null, quote: 'Quote', quoteHash: 'b'.repeat(64), sectionPath: null, strategy: 'chunk-alias',
  };
  const baseMetadata = { answerId: ANSWER_ID, citationStrategy: 'chunk-alias', citations: [citation], answerLanguage: 'en' };

  const render = (metadata: Record<string, unknown>, options: { id?: string; text?: string; isStreaming?: boolean } = {}) =>
    renderToStaticMarkup(
      createElement(ChatMessage as never, {
        message: { id: options.id ?? 'm-1', role: 'assistant', parts: [], content: [{ type: 'text', text: options.text ?? TEXT }], metadata },
        isLastMessage: false,
        isStreaming: options.isStreaming ?? false,
      }) as ReactNode as never,
    );
  const today = (options: { id?: string; text?: string; isStreaming?: boolean } = {}) => render(baseMetadata, options);

  await verifySentenceRecords([TEXT], SENTENCES as never);

  // renderToStaticMarkup reads a zustand store's initial state (server snapshot), so the cases set it there.
  const ghostInitial = useGhostModeStore.getInitialState() as { isGhostMode: boolean };
  const recordsInitial = useAnswerRecordsStore.getInitialState() as { records: Record<string, unknown> };
  const setGhost = (value: boolean) => { ghostInitial.isGhostMode = value; };
  const setRecords = (records: Record<string, unknown>) => { recordsInitial.records = records; };

  afterEach(() => {
    setRecords({});
    setGhost(false);
  });

  test('a finished message whose sentences verify shows uncited marks after the chips and the legend', () => {
    const html = render({ ...baseMetadata, sentences: SENTENCES });
    expect(html.match(/data-sentence-mark="uncited"/g)).toHaveLength(2);
    expect(html).not.toContain('data-sentence-mark="unsupported"');
    expect(html).toContain('data-sentence-index="1"');
    expect(html).toContain('data-sentence-index="2"');
    expect(html).toContain('data-mark-legend');
    expect(html).toContain(`${EN.uncited}: 2`);
    expect(html.indexOf('data-citation-chip="1"')).toBeLessThan(html.indexOf('data-sentence-mark'));
    expect(html).not.toContain('#mark-');
  });

  test('after the claim check marks a sentence unsupported, its triangle and the second legend item appear', () => {
    const checks = { sentences: [{ ...SENTENCES[2], support: 'unsupported', scorer: 'llm_judge' }] };
    const html = render({ ...baseMetadata, sentences: SENTENCES, checks });
    expect(html.match(/data-sentence-mark="unsupported"/g)).toHaveLength(1);
    expect(html).toContain(`${EN.not_confirmed}: 1`);
    expect(html.indexOf('data-sentence-mark="uncited" data-sentence-index="2"')).toBeLessThan(html.indexOf('data-sentence-mark="unsupported"'));
  });

  test('without sentences, while streaming, in a ghost chat, for a refusal, a flexible record or a changed text, the message is today\'s', () => {
    expect(render({ ...baseMetadata }), 'no sentences').toBe(today());
    expect(render({ ...baseMetadata, sentences: SENTENCES }, { isStreaming: true }), 'streaming').toBe(today({ isStreaming: true }));
    expect(render({ ...baseMetadata, sentences: SENTENCES }, { text: TEXT + ' Edited.' }), 'edited').toBe(today({ text: TEXT + ' Edited.' }));
    expect(render({ ...baseMetadata, sentences: SENTENCES, refusal: true }), 'refusal').toBe(render({ ...baseMetadata, refusal: true }));
    setGhost(true);
    const ghostToday = today();
    expect(render({ ...baseMetadata, sentences: SENTENCES }), 'ghost').toBe(ghostToday);
    expect(ghostToday).not.toContain('data-sentence-mark');
    setGhost(false);
    setRecords({ [ANSWER_ID]: { answerId: ANSWER_ID, ragMode: 'flexible', updatedAt: '2026-01-01T00:00:00Z' } });
    expect(render({ ...baseMetadata, sentences: SENTENCES }), 'flexible').toBe(today());
  });

  test('a forged mark link with no verified record renders nothing', () => {
    const forged = 'A claim here.[](#mark-uncited-0-0) More text.';
    const html = render({ ...baseMetadata }, { text: forged });
    expect(html).not.toContain('data-sentence-mark');
    expect(html).not.toContain('#mark-');
  });

  test('a verified blocked range is replaced by the registry text and the original is not in the DOM', async () => {
    const blockedSentence = 'The second value is nine.';
    const range = { part: 0, start: at(blockedSentence), end: at(blockedSentence) + blockedSentence.length, text_hash: HASH };
    const checks = { output_guard: { mode: 'enforce', rules_version: 'r1', blocked_ranges: [range] } };
    const html = render({ ...baseMetadata, sentences: SENTENCES, checks });
    expect(html).toContain(FIXED_TEXTS.en.notices.credential_request_blocked!);
    expect(html).not.toContain('is nine');
    expect(html.match(/data-sentence-mark="uncited"/g)).toHaveLength(1);
  });

  test('a mark at the end of a list item and under a table keeps the table markup', async () => {
    const text = '- A listed value is three.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    const hash = createHash('sha256').update(text, 'utf8').digest('hex');
    const li = { ...sentence(0, '- A listed value is three.\n\n'), kind: 'list_item', text_hash: hash, start: 0, end: text.indexOf('|') };
    const table = { ...sentence(1, ''), kind: 'table', text_hash: hash, start: text.indexOf('|'), end: text.length };
    await verifySentenceRecords([text.replace(/\s+$/, '')], [li, table] as never);
    const html = render({ ...baseMetadata, sentences: [li, table] }, { text });
    expect(html).toMatch(/<li[^>]*>[^]*three\.[^]*data-sentence-mark="uncited"[^]*<\/li>/);
    expect(html).toMatch(/<\/table>[^]*data-sentence-mark="uncited" data-sentence-index="1"/);
    expect(html).toContain('<td>1</td>');
  });

  test('copy and read-aloud take their text from the display text and never carry a mark', () => {
    const source = readFileSync('src/components/ui/chat-message.tsx', 'utf8');
    const copy = source.slice(source.indexOf('const handleCopy = async'), source.indexOf('const handleCopy = async') + 400);
    expect(copy).toContain('copyTextParts()');
    expect(source).toMatch(/const displayParts = markHashesReady \? answerDisplayText\(/);
    expect(source.match(/prepareTextForTTS\(cleanToolCallMetadata\(speechSourceText\(\)\)\)/g)).toHaveLength(3);
    expect(source).not.toMatch(/prepareTextForTTS\(cleanToolCallMetadata\(messageContent\.text\)\)/);
  });
});

describe('ChatMessage sentence marks from the polled record', async () => {
  const { ChatMessage } = await import('@/components/ui/chat-message');
  const { verifySentenceRecords } = await import('@/lib/chat/sentence-marks');
  const { useAnswerRecordsStore } = await import('@/lib/stores/answer-records-store');
  const recordsInitial = useAnswerRecordsStore.getInitialState() as { records: Record<string, unknown> };
  afterEach(() => { recordsInitial.records = {}; });

  test('a strict-mode record with checked sentences adds the triangle', async () => {
    const answerId = '0d4a2c8e-1f3b-4c5d-9e6f-0a1b2c3d4e5f';
    const text = 'A plain fact is stated.';
    const hash = createHash('sha256').update(text, 'utf8').digest('hex');
    const s0 = { index: 0, part: 0, start: 0, end: text.length, kind: 'sentence', text_hash: hash, factual: true, cited: true, support: 'not_checked', scorer: null, reason: null };
    await verifySentenceRecords([text], [s0] as never);
    recordsInitial.records = { [answerId]: { answerId, ragMode: 'strict', updatedAt: '2026-01-01T00:00:00Z', checks: { sentences: [{ ...s0, support: 'unsupported' }] } } };
    const html = renderToStaticMarkup(
      createElement(ChatMessage as never, {
        message: { id: 'm-r', role: 'assistant', parts: [], content: [{ type: 'text', text }], metadata: { answerId, citations: [], sentences: [s0] } },
      }) as ReactNode as never,
    );
    expect(html).toContain('data-sentence-mark="unsupported"');
    expect(html).not.toContain('data-sentence-mark="uncited"');
    expect(html).toContain(`${EN.not_confirmed}: 1`);
  });
});
