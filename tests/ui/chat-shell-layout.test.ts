import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeKeyboardInset, KEYBOARD_MIN_INSET_PX } from '@/lib/hooks/use-chat-viewport';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('computeKeyboardInset', () => {
  it('is the keyboard height when only the visual viewport shrinks (iOS)', () => {
    expect(computeKeyboardInset({ innerHeight: 852, visualHeight: 516, visualOffsetTop: 0 })).toBe(336);
  });

  it('subtracts a panned visual viewport so the dock lands on the visible bottom', () => {
    expect(computeKeyboardInset({ innerHeight: 852, visualHeight: 516, visualOffsetTop: 120 })).toBe(216);
  });

  it('is 0 when the layout viewport resizes with the keyboard (interactive-widget=resizes-content)', () => {
    expect(computeKeyboardInset({ innerHeight: 516, visualHeight: 516, visualOffsetTop: 0 })).toBe(0);
  });

  it('ignores small gaps from collapsing browser toolbars', () => {
    expect(computeKeyboardInset({ innerHeight: 852, visualHeight: 852 - (KEYBOARD_MIN_INSET_PX - 1), visualOffsetTop: 0 })).toBe(0);
  });
});

describe('chat shell layout contract', () => {
  it('lets the keyboard resize the layout viewport and keeps pinch zoom', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toMatch(/interactiveWidget: 'resizes-content'/);
    expect(layout).toMatch(/viewportFit: 'cover'/);
    expect(layout).not.toMatch(/maximumScale|userScalable/);
  });

  it('has a single viewport meta source', () => {
    expect(read('src/app/client-layout.tsx')).not.toMatch(/<meta name="viewport"/);
  });

  it('renders one phone disclaimer, inside the composer', () => {
    const page = read('src/app/page.tsx');
    expect(page).not.toMatch(/ios-hidden/);
    expect(page.match(/t\('mobileDisclaimer'\)/g) ?? []).toHaveLength(0);
    expect(read('src/components/ui/chat-input.tsx').match(/t\('mobileDisclaimer'\)/g)).toHaveLength(1);
  });

  it('applies the safe-area inset once, on the dock', () => {
    const page = read('src/app/page.tsx');
    const docks = page.match(/className="[^"]*\bchat-dock\b[^"]*"|"[^"]*\bchat-dock\b[^"]*"/g) ?? [];
    expect(docks.length).toBe(2);
    for (const dock of docks) expect(dock).not.toMatch(/pb-safe/);
    const input = read('src/components/ui/chat-input.tsx');
    expect(input).not.toMatch(/safe-area-inset-bottom\)?\s*\+\s*25px/);
  });

  it('keeps fixed bars pinned to the viewport (no blanket transform on every element)', () => {
    const css = read('src/app/globals.css');
    expect(css).not.toMatch(/\*\s*\{[^}]*transform:\s*translateZ\(0\)/);
  });

  it('gives the glass bars a solid fallback and honours reduced transparency', () => {
    const css = read('src/app/chat-shell.css');
    expect(css).toMatch(/@supports \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)/);
    expect(css).toMatch(/-webkit-backdrop-filter: blur\(20px\) saturate\(180%\)/);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\)/);
    expect(css).toMatch(/padding-bottom: max\(8px, env\(safe-area-inset-bottom, 0px\)\)/);
  });
});
