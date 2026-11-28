import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('05.2-UI-REVIEW fixes', () => {
  it('sentence mark focus ring uses the chat accent-ink token, not a hex value', () => {
    const source = read('src/components/ui/sentence-mark.tsx');
    expect(source).toContain('focus-visible:ring-chat-accent-ink');
    expect(source).not.toMatch(/ring-\[#/i);
    expect(read('tailwind.config.ts')).toMatch(/'accent-ink': 'var\(--chat-accent-ink\)'/);
    expect(read('src/app/chat-shell.css')).toMatch(/--chat-accent-ink:/);
  });

  it('neutral notices use the declared chat surface and hairline tokens in dark mode', () => {
    const source = read('src/components/ui/answer-notices.tsx');
    expect(source).toContain('dark:bg-chat-surface');
    expect(source).toContain('dark:ring-chat-hairline');
    expect(source).not.toMatch(/\[#[0-9a-f]{3,6}\]/i);
  });

  it('Answer rules: the two uploader-alert number inputs are capped on desktop', () => {
    const html = read('scripts/config-ui/index.html');
    for (const id of ['RAG_UPLOADER_ALERT_THRESHOLD', 'RAG_UPLOADER_ALERT_WINDOW_HOURS']) {
      const input = new RegExp(`<input type="number" id="${id}"[^>]*class="([^"]*)"`).exec(html);
      expect(input?.[1]).toContain('md:max-w-40');
      expect(input?.[1]).toContain('w-full');
    }
  });

  it('dark theme: a warning alert inside a card keeps the warning content colour', () => {
    const html = read('scripts/config-ui/index.html');
    expect(html).toMatch(/\[data-theme="dark"\] \.card \.alert-warning h3,[\s\S]{0,120}color: var\(--fallback-wac, oklch\(var\(--wac\) \/ 1\)\);/);
  });
});
