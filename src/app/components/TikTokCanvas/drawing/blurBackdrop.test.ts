import { describe, it, expect } from 'vitest';
import { visibleSourceRect } from './blurBackdrop';

// The backdrop must sample ONLY the slice of the source frame visible inside the crop clip window.
// `draw` = where the video is painted on the canvas (reelVideoRect); `clip` = the crop window.

describe('visibleSourceRect', () => {
  const SRC_W = 1920, SRC_H = 1080;   // a landscape source

  it('uncropped, video exactly filling the clip → the whole frame', () => {
    const draw = { dx: 0, dy: 0, dw: 1080, dh: 1920 };
    const clip = { x: 0, y: 0, w: 1080, h: 1920 };
    const r = visibleSourceRect(draw, clip, 1080, 1920);
    expect(r).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 1920 });
  });

  it('cropping the top half of the clip maps to the top half of the drawn source region', () => {
    // Source drawn 1:1 into a 0..1080 x 0..1080 square of the canvas; clip keeps only y 540..1080.
    const draw = { dx: 0, dy: 0, dw: 1080, dh: 1080 };
    const clip = { x: 0, y: 540, w: 1080, h: 540 };
    const r = visibleSourceRect(draw, clip, 1080, 1080);
    expect(r.sy).toBeCloseTo(540, 5);
    expect(r.sh).toBeCloseTo(540, 5);
    expect(r.sx).toBe(0);
    expect(r.sw).toBeCloseTo(1080, 5);
  });

  it('cover-fit overflow: the drawn rect extends past the clip → sample rect clamps inside the frame', () => {
    // Landscape source cover-fit into a portrait band: dw ≫ band width, dx negative (sides overflow).
    const draw = { dx: -1290, dy: 0, dw: 3660, dh: 1920 };   // 1920x1080 scaled by 1920/1080
    const clip = { x: 0, y: 0, w: 1080, h: 1920 };
    const r = visibleSourceRect(draw, clip, SRC_W, SRC_H);
    // Visible horizontal span: canvas 0..1080 → source (0-(-1290))/3660*1920 .. (1080+1290)/3660*1920
    expect(r.sx).toBeCloseTo((1290 / 3660) * SRC_W, 3);
    expect(r.sw).toBeCloseTo((1080 / 3660) * SRC_W, 3);
    expect(r.sy).toBe(0);
    expect(r.sh).toBeCloseTo(SRC_H, 5);
  });

  it('a clip window fully outside the drawn video degenerates to a ≥1px rect (never 0/negative)', () => {
    const draw = { dx: 0, dy: 0, dw: 1080, dh: 500 };
    const clip = { x: 0, y: 800, w: 1080, h: 400 };   // entirely below the drawn video
    const r = visibleSourceRect(draw, clip, 1080, 500);
    expect(r.sw).toBeGreaterThanOrEqual(1);
    expect(r.sh).toBeGreaterThanOrEqual(1);
    expect(r.sy).toBeLessThanOrEqual(500);
  });

  it('clamps to the frame bounds for any clip', () => {
    const draw = { dx: -500, dy: -500, dw: 2000, dh: 3000 };
    const clip = { x: 0, y: 0, w: 1080, h: 1920 };
    const r = visibleSourceRect(draw, clip, SRC_W, SRC_H);
    expect(r.sx).toBeGreaterThanOrEqual(0);
    expect(r.sy).toBeGreaterThanOrEqual(0);
    expect(r.sx + r.sw).toBeLessThanOrEqual(SRC_W + 1e-6);
    expect(r.sy + r.sh).toBeLessThanOrEqual(SRC_H + 1e-6);
  });
});
