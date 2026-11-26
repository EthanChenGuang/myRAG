import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
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
