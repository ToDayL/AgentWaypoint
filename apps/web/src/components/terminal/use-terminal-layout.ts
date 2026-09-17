'use client';

import { useEffect, useState, type RefObject } from 'react';

// Keep in sync with the sidebar and terminal breakpoint in globals.css.
export const TERMINAL_MOBILE_QUERY = '(max-width: 860px)';

export function terminalViewportRect(
  viewport: Pick<VisualViewport, 'height' | 'width' | 'offsetTop' | 'offsetLeft'> | null,
  width: number,
  height: number,
) {
  return {
    width: viewport && viewport.width > 0 ? viewport.width : width,
    height: viewport && viewport.height > 0 ? viewport.height : height,
    top: Math.max(0, viewport?.offsetTop ?? 0),
    left: Math.max(0, viewport?.offsetLeft ?? 0),
  };
}

export function useTerminalLayout(panel: RefObject<HTMLElement | null>): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(TERMINAL_MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(TERMINAL_MOBILE_QUERY);
    const viewport = window.visualViewport;
    let frame = 0;
    const update = () => {
      setMobile(media.matches);
      if (!media.matches || !panel.current) return;
      const rect = terminalViewportRect(viewport, window.innerWidth, window.innerHeight);
      for (const [key, value] of Object.entries(rect))
        panel.current.style.setProperty(`--terminal-visible-${key}`, `${value}px`);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    media.addEventListener('change', schedule);
    window.addEventListener('resize', schedule);
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    document.addEventListener('visibilitychange', schedule);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener('change', schedule);
      window.removeEventListener('resize', schedule);
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [panel]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    return () => {
      // Defer until the covered UI is no longer inert.
      queueMicrotask(() => {
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
          previousFocus.focus({ preventScroll: true });
      });
    };
  }, []);

  useEffect(() => {
    if (!mobile || !panel.current) return;
    // The mobile panel is modal: keep the covered chat/sidebar controls out of
    // both pointer and keyboard navigation, restoring their previous state.
    const siblings = new Map<HTMLElement, boolean>();
    let current: HTMLElement | null = panel.current;
    while (current && current !== document.body) {
      for (const sibling of Array.from(current.parentElement?.children ?? [])) {
        if (sibling instanceof HTMLElement && sibling !== current) {
          siblings.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      current = current.parentElement;
    }
    return () => {
      for (const [sibling, inert] of siblings) sibling.inert = inert;
    };
  }, [mobile, panel]);

  return mobile;
}
