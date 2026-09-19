import { describe, it, expect } from 'vitest';
import { fullBleedVideoRects } from './fullBleedVideo';
import { reelLayout, reelVideoRect } from './drawReelCell';
import { defaultTwitterTemplateSettings } from '../../twitterTemplateTypes';
import { CANVAS_W, CANVAS_H } from '../constants';
import type { Box } from '../types';

// Commentary reels used to composite through the reel-band machinery, pinned to
// defaultTwitterTemplateSettings(). The fork inlined that as "cover-fit to the whole canvas", which is only
// correct while the default template really is a full-bleed band. These tests pin BOTH halves of that claim,
// so a future edit to the template defaults or to reelVideoRect fails here instead of silently reframing
// every commentary reel (and desyncing the preview from the exported MP4).

const sources: [string, number, number][] = [
  ['portrait 9:16 (matches the canvas)', 1080, 1920],
  ['landscape 16:9', 1920, 1080],
  ['square', 1000, 1000],
  ['ultra-wide', 2560, 800],
  ['taller than 9:16', 900, 2400],
];

describe('fullBleedVideoRects — parity with the reel band it replaced', () => {
  const L = reelLayout(defaultTwitterTemplateSettings());

  it('the default template really is a full-bleed band (the premise of the whole collapse)', () => {
    expect(L.bandX).toBe(0);
    expect(L.bandY).toBe(0);
    expect(L.bandW).toBe(CANVAS_W);
    expect(L.bandH).toBe(CANVAS_H);
    // A zero corner radius is what lets the exporter's rect() stand in for the old roundRect().
    expect(defaultTwitterTemplateSettings().videoCornerRadius).toBe(0);
  });

  for (const [label, vw, vh] of sources) {
    it(`draws ${label} exactly where reelVideoRect did`, () => {
      for (const zoom of [0.5, 1, 1.37, 3]) {
        for (const offset of [{ x: 0, y: 0 }, { x: 120, y: -240 }, { x: -75.5, y: 33.25 }]) {
          const crop: Box = { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H };
          const { draw } = fullBleedVideoRects(vw, vh, zoom, offset, crop);
          const ref = reelVideoRect(vw, vh, L, zoom, offset.x, offset.y);
          expect(draw).toEqual({ dx: ref.dx, dy: ref.dy, dw: ref.dw, dh: ref.dh });
        }
      }
    });
  }

  it('cover-fits: the drawn rect always covers the canvas at zoom 1 (never letterboxed)', () => {
    for (const [, vw, vh] of sources) {
      const { draw } = fullBleedVideoRects(vw, vh, 1, { x: 0, y: 0 }, { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H });
      expect(draw.dw).toBeGreaterThanOrEqual(CANVAS_W - 1e-9);
      expect(draw.dh).toBeGreaterThanOrEqual(CANVAS_H - 1e-9);
      // Cover-fit means one axis matches exactly and the other overflows — never both short.
      expect(Math.min(draw.dw - CANVAS_W, draw.dh - CANVAS_H)).toBeCloseTo(0, 9);
    }
  });
});

describe('fullBleedVideoRects — the crop bars', () => {
  const CROPPED: Box = { x: 0, y: 300, w: CANVAS_W, h: 900 };

  it('clip follows the crop box vertically and spans the full width', () => {
    const { clip } = fullBleedVideoRects(1920, 1080, 1, { x: 0, y: 0 }, CROPPED);
    expect(clip).toEqual({ x: 0, y: 300, w: CANVAS_W, h: 900 });
  });

  it('ignores the crop box x/w — a full-bleed video always spans the canvas width', () => {
    const narrowed: Box = { ...CROPPED, x: 400, w: 200 };
    expect(fullBleedVideoRects(1920, 1080, 1, { x: 0, y: 0 }, narrowed).clip)
      .toEqual(fullBleedVideoRects(1920, 1080, 1, { x: 0, y: 0 }, CROPPED).clip);
  });

  it('cropping never moves or rescales the video — only the clip window changes', () => {
    const uncropped = fullBleedVideoRects(1920, 1080, 1.2, { x: 40, y: -60 }, { x: 0, y: 0, w: CANVAS_W, h: CANVAS_H });
    const cropped = fullBleedVideoRects(1920, 1080, 1.2, { x: 40, y: -60 }, CROPPED);
    expect(cropped.draw).toEqual(uncropped.draw);
    expect(cropped.clip).not.toEqual(uncropped.clip);
  });
});
