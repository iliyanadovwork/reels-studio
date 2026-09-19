import { describe, it, expect } from 'vitest';
import { memeOverlayRect, MAX_MEME_IMAGE_BYTES, MIN_MEME_IMAGE_PX } from './memeImage';

// checkMemeImage needs a DOM (Image decoding) and the test env is node, so only the pure geometry is
// covered here. The layout is what decides whether a meme is readable in the export, and it has two
// competing constraints (width cap vs height cap) — exactly the kind of thing that silently gets one wrong.

const W = 1080;
const H = 1920;
const MAX_W = W * 0.86;
const MAX_H = H * 0.72;

describe('memeOverlayRect — constraints', () => {
  it('never exceeds either cap, across a wide range of aspects', () => {
    // 1:20 (a long comment-thread screenshot) through 20:1 (a wide banner meme).
    for (const [w, h] of [[100, 2000], [400, 1200], [800, 800], [1200, 400], [2000, 100], [1179, 2556], [3024, 4032]]) {
      const r = memeOverlayRect(w, h, W, H);
      expect(r.w, `${w}x${h} width`).toBeLessThanOrEqual(Math.round(MAX_W));
      expect(r.h, `${w}x${h} height`).toBeLessThanOrEqual(Math.round(MAX_H));
      expect(r.w, `${w}x${h} positive`).toBeGreaterThan(0);
      expect(r.h, `${w}x${h} positive`).toBeGreaterThan(0);
    }
  });

  it('preserves the source aspect ratio', () => {
    for (const [w, h] of [[100, 2000], [800, 800], [1200, 400], [1179, 2556]]) {
      const r = memeOverlayRect(w, h, W, H);
      // Rounding to whole canvas px moves the ratio slightly; 1.5% is well inside "no visible distortion".
      expect(r.h / r.w, `${w}x${h}`).toBeCloseTo(h / w, 1);
    }
  });

  it('is centred horizontally', () => {
    for (const [w, h] of [[100, 2000], [800, 800], [1200, 400]]) {
      const r = memeOverlayRect(w, h, W, H);
      expect(Math.abs((r.x + r.w / 2) - W / 2), `${w}x${h}`).toBeLessThanOrEqual(1);
    }
  });

  it('is centred vertically', () => {
    for (const [w, h] of [[100, 2000], [800, 800], [1200, 400]]) {
      const r = memeOverlayRect(w, h, W, H);
      expect(Math.abs((r.y + r.h / 2) - H / 2), `${w}x${h}`).toBeLessThanOrEqual(1);
    }
  });

  it('stays fully inside the frame (no negative origin, no overflow)', () => {
    for (const [w, h] of [[100, 4000], [4000, 100], [800, 800]]) {
      const r = memeOverlayRect(w, h, W, H);
      expect(r.x, `${w}x${h}`).toBeGreaterThanOrEqual(0);
      expect(r.y, `${w}x${h}`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w, `${w}x${h}`).toBeLessThanOrEqual(W);
      expect(r.y + r.h, `${w}x${h}`).toBeLessThanOrEqual(H);
    }
  });
});

describe('memeOverlayRect — which cap binds', () => {
  it('a WIDE image is limited by the width cap', () => {
    const r = memeOverlayRect(1600, 900, W, H);
    expect(r.w).toBe(Math.round(MAX_W));
    expect(r.h).toBeLessThan(Math.round(MAX_H));
  });

  it('a TALL image is limited by the height cap, not stretched to the width cap', () => {
    // The bug this catches: applying only the width cap gives h = 929*(2000/500) = 3716px — nearly twice
    // the canvas — so the meme would be drawn far outside the frame and read as blank.
    const r = memeOverlayRect(500, 2000, W, H);
    expect(r.h).toBe(Math.round(MAX_H));
    expect(r.w).toBeLessThan(Math.round(MAX_W));
  });

  it('the square case is width-bound (0.86·1080 = 929 < 0.72·1920 = 1382)', () => {
    const r = memeOverlayRect(1000, 1000, W, H);
    expect(r.w).toBe(Math.round(MAX_W));
    expect(r.h).toBe(Math.round(MAX_W));
  });
});

describe('memeOverlayRect — degenerate input never produces NaN/Infinity', () => {
  it('zero and negative dimensions still return a finite, on-canvas rect', () => {
    for (const [w, h] of [[0, 0], [0, 500], [500, 0], [-100, 200]]) {
      const r = memeOverlayRect(w, h, W, H);
      for (const [k, v] of Object.entries(r)) {
        expect(Number.isFinite(v), `${w}x${h} ${k}=${v}`).toBe(true);
      }
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
  });
});

describe('limits', () => {
  it('the byte cap is far below the video cap — an image is decoded every export frame', () => {
    expect(MAX_MEME_IMAGE_BYTES).toBe(25 * 1024 * 1024);
  });
  it('the minimum edge is large enough for OCR to see glyphs', () => {
    expect(MIN_MEME_IMAGE_PX).toBeGreaterThanOrEqual(100);
  });
});
