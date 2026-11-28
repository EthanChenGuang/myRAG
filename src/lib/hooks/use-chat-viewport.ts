'use client';

import { useEffect, type RefObject } from 'react';

/** A visual-viewport gap smaller than this is browser chrome (toolbar collapse), not an on-screen keyboard. */
export const KEYBOARD_MIN_INSET_PX = 80;

export interface ViewportSample {
  innerHeight: number;
  visualHeight: number;
  visualOffsetTop: number;
}

/**
 * Height of the strip between the bottom of the visual viewport and the bottom of the layout viewport.
 * iOS keeps the layout viewport when the keyboard opens and only shrinks the visual one, so this is the
 * keyboard height there. With `interactive-widget=resizes-content` (Chrome on Android) both shrink together
 * and the result is 0: the fixed dock already sits on the keyboard.
 */
export function computeKeyboardInset({ innerHeight, visualHeight, visualOffsetTop }: ViewportSample): number {
  const gap = Math.round(innerHeight - visualHeight - visualOffsetTop);
  return gap >= KEYBOARD_MIN_INSET_PX ? gap : 0;
}

/**
 * Keeps `--chat-kb-inset`, `--chat-vv-top` and `data-chat-keyboard` on <html> in step with the on-screen keyboard, and
 * `--chat-dock-h` with the composer dock's height, so the dock rides on the keyboard and the message list
 * always clears the dock.
 */
export function useChatViewport(dockRef: RefObject<HTMLElement | null>, dockKey?: unknown): void {
  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    let frame = 0;

    const apply = () => {
      frame = 0;
      const inset = vv
        ? computeKeyboardInset({ innerHeight: window.innerHeight, visualHeight: vv.height, visualOffsetTop: vv.offsetTop })
        : 0;
      root.style.setProperty('--chat-kb-inset', `${inset}px`);
      root.style.setProperty('--chat-vv-top', `${inset > 0 && vv ? Math.max(0, Math.round(vv.offsetTop)) : 0}px`);
      root.dataset.chatKeyboard = inset > 0 ? 'open' : 'closed';
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(apply);
    };

    apply();
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      root.style.removeProperty('--chat-kb-inset');
      root.style.removeProperty('--chat-vv-top');
      delete root.dataset.chatKeyboard;
    };
  }, []);

  useEffect(() => {
    const dock = dockRef.current;
    if (!dock || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.borderBoxSize?.[0];
      const height = box ? box.blockSize : dock.getBoundingClientRect().height;
      root.style.setProperty('--chat-dock-h', `${Math.round(height)}px`);
    });
    observer.observe(dock);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--chat-dock-h');
    };
  }, [dockRef, dockKey]);
}
