import { describe, expect, it } from 'vitest';
import { terminalViewportRect } from './use-terminal-layout';

describe('terminal mobile viewport', () => {
  it('uses the visible height and pan offset when the software keyboard opens', () => {
    expect(
      terminalViewportRect({ width: 390, height: 360, offsetTop: 64, offsetLeft: 0 }, 390, 844),
    ).toEqual({ width: 390, height: 360, top: 64, left: 0 });
  });

  it('falls back to the window when VisualViewport is unavailable', () => {
    expect(terminalViewportRect(null, 390, 844)).toEqual({
      width: 390,
      height: 844,
      top: 0,
      left: 0,
    });
  });

  it('handles transient zero dimensions and negative overscroll during rotation', () => {
    expect(
      terminalViewportRect({ width: 0, height: 0, offsetTop: -10, offsetLeft: -5 }, 844, 390),
    ).toEqual({ width: 844, height: 390, top: 0, left: 0 });
  });
});
