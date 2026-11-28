import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getComposerState, type ComposerStateInput } from '@/lib/chat-composer-state';

const idle: ComposerStateInput = {
  focused: false,
  text: '',
  hasAttachment: false,
  hasActiveTool: false,
  menuOpen: false,
  isRecording: false,
};

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('getComposerState', () => {
  it('is a collapsed capsule when idle and empty', () => {
    expect(getComposerState(idle)).toBe('collapsed');
    expect(getComposerState({ ...idle, text: '   \n' })).toBe('collapsed');
  });

  it('expands on focus and stays expanded while it holds text after blur', () => {
    expect(getComposerState({ ...idle, focused: true })).toBe('expanded');
    expect(getComposerState({ ...idle, text: 'draft' })).toBe('expanded');
  });

  it('stays expanded while an attachment, tool, menu or dictation is in use', () => {
    expect(getComposerState({ ...idle, hasAttachment: true })).toBe('expanded');
    expect(getComposerState({ ...idle, hasActiveTool: true })).toBe('expanded');
    expect(getComposerState({ ...idle, menuOpen: true })).toBe('expanded');
    expect(getComposerState({ ...idle, isRecording: true })).toBe('expanded');
  });
});

describe('composer contract', () => {
  const input = read('src/components/ui/chat-input.tsx');

  it('keeps the textarea mounted and focused natively (no deferred focus to open the keyboard)', () => {
    expect(input).toMatch(/data-composer=\{composerState\}/);
    expect(input).toMatch(/data-chat-input-form=""/);
    expect(input).toMatch(/onFocus=\{handleComposerFocus\}/);
  });

  it('moves the model picker into the composer and out of the header', () => {
    expect(input).toMatch(/<ComposerModelPill/);
    const header = read('src/components/ui/header.tsx');
    expect(header).not.toMatch(/ModelSelector/);
    expect(header).toMatch(/chat-title-capsule/);
  });

  it('collapses only on phones and honours reduced motion', () => {
    const css = read('src/app/chat-shell.css');
    expect(css).toMatch(/@media \(max-width: 639px\) \{[\s\S]*\[data-composer='collapsed'\] \.chat-composer-secondary/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.chat-composer-text-row/);
  });
});
