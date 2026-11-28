import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('send button on touch screens', () => {
  const src = read('src/components/ui/chat-input.tsx');
  const button = src.slice(src.indexOf('type={parentIsLoading ? "button" : "submit"}'), src.lastIndexOf('"chat-send-button'));

  it('keeps the textarea focused while the button is pressed', () => {
    expect(button).toMatch(/onMouseDown=\{keepComposerFocus\}/);
    expect(src).toMatch(/const keepComposerFocus = \(e: React\.MouseEvent\) => \{\s*e\.preventDefault\(\);/);
  });

  it('sends on touchend instead of waiting for a click the keyboard can swallow', () => {
    expect(button).toMatch(/onTouchEnd=\{handleSendTouchEnd\}/);
    const handler = src.slice(src.indexOf('const handleSendTouchEnd'), src.indexOf('const handleButtonClick'));
    expect(handler).toMatch(/e\.preventDefault\(\)/);
    expect(handler).toMatch(/button\.form\?\.requestSubmit\(\)/);
    expect(handler).toMatch(/handleStop\?\.\(\)/);
  });
});

describe('thinking indicator', () => {
  it('replaces the bouncing dots with an announced, localized status', () => {
    const msg = read('src/components/ui/chat-message.tsx');
    expect(msg).toMatch(/<ThinkingIndicator \/>/);
    const comp = read('src/components/ui/thinking-indicator.tsx');
    expect(comp).toMatch(/role="status"/);
    expect(comp).toMatch(/t\('thinkingStatus'\)/);
  });

  it('stops animating for reduced motion', () => {
    const css = read('src/app/chat-shell.css');
    const block = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/\.chat-thinking-dots > span \{ animation: none/);
    expect(block).toMatch(/\.chat-thinking-label/);
  });
});
