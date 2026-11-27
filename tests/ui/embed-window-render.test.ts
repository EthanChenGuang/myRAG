import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { FIXED_TEXTS } from '@/lib/rag/lang/texts.generated';
import { renderEmbedMarkdown } from '@/lib/embed/render-markdown';

const html = (text: string) => renderToStaticMarkup(renderEmbedMarkdown(text));

describe('renderEmbedMarkdown (UI-SPEC 6.10)', () => {
  test('answer text, a blank line and a notice: the notice stays a separate plain paragraph', () => {
    const notice = FIXED_TEXTS.en.notices.answer_truncated!;
    const out = html(`The value is seven.\n\n${notice}`);
    expect(out).toBe(`The value is seven.\n\n${notice}`);
  });

  test('the link placeholder in every shipped language is plain text with no anchor', () => {
    for (const [language, texts] of Object.entries(FIXED_TEXTS)) {
      const placeholder = texts.notices.link_removed!;
      const out = html(`Read the page ${placeholder} for details.`);
      expect(out, language).not.toContain('<a');
      expect(out, language).toContain(placeholder);
    }
  });

  test('a removed markdown link ("visible text (link removed)") is plain text with no anchor', () => {
    const out = html('See visible text (link removed) for details.');
    expect(out).toBe('See visible text (link removed) for details.');
  });

  test('a bold label on its own line renders as strong', () => {
    const label = FIXED_TEXTS.en.labels.from_web!;
    expect(html(`**${label}**\nA web part.`)).toBe(`<strong>${label}</strong>\nA web part.`);
  });

  test('an allowlisted [text](url) renders an anchor as today', () => {
    expect(html('Open [the guide](https://docs.example.test/guide).')).toBe(
      'Open <a href="https://docs.example.test/guide" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:text-blue-800 underline break-all">the guide</a>.',
    );
  });

  test('existing inputs render as before the move (bold, italic, link with trailing punctuation)', () => {
    expect(html('*a* and **b** [c](https://x.example.test/p).')).toBe(
      '<em>a</em> and <strong>b</strong> <a href="https://x.example.test/p" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:text-blue-800 underline break-all">c</a>.',
    );
    expect(html('')).toBe('');
  });

  test('markup in model text is text', () => {
    const out = html('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  test('the embed window page uses the moved renderer', () => {
    const page = readFileSync('src/app/embed/window/page.tsx', 'utf8');
    expect(page).toContain("from '@/lib/embed/render-markdown'");
    expect(page).toContain('renderEmbedMarkdown(messageText(message))');
    expect(page).not.toMatch(/function renderMarkdown\(/);
  });
});
