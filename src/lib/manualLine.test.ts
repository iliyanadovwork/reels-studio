import { describe, it, expect } from 'vitest';
import { insertManualLine, recalcBoundaries } from './manualLine';
import type { OcrTextLine } from '@/app/components/TikTokCanvas/types';

const L = (y0: number, y1: number, over: Partial<OcrTextLine> = {}): OcrTextLine => ({
  text: 'x', bottomFrac: 1, endsBlock: false, blockIdx: 0,
  x0: 0.1, y0, x1: 0.9, y1, enabled: true, ...over,
});

describe('insertManualLine', () => {
  it('inserts in vertical order and rebuilds the neighbour boundaries', () => {
    // Two detected lines; the manual one lands between them. The FIRST line's boundary must move UP
    // to the gap above the manual line, or its reveal would flash the manual text early.
    const out = insertManualLine([L(0.1, 0.15), L(0.5, 0.55)], { text: 'Do nothing', x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.35 });
    expect(out.map(l => l.text)).toEqual(['x', 'Do nothing', 'x']);
    expect(out[0].bottomFrac).toBeCloseTo((0.15 + 0.3) / 2, 10);
    expect(out[1].bottomFrac).toBeCloseTo((0.35 + 0.5) / 2, 10);
    expect(out[2].bottomFrac).toBe(1);
  });

  it('appends after everything when it is the lowest line', () => {
    const out = insertManualLine([L(0.1, 0.15)], { text: 'bottom', x0: 0.1, y0: 0.8, x1: 0.9, y1: 0.85 });
    expect(out[1].text).toBe('bottom');
    expect(out[1].bottomFrac).toBe(1);
    expect(out[0].bottomFrac).toBeCloseTo((0.15 + 0.8) / 2, 10);
  });

  it('normalises a backwards drag and clamps to the image', () => {
    const out = insertManualLine([], { text: 't', x0: 0.9, y0: 1.4, x1: -0.2, y1: 0.8 });
    const l = out[0];
    expect(l.x0).toBe(0);
    expect(l.x1).toBe(0.9);
    expect(l.y0).toBe(0.8);
    expect(l.y1).toBe(1);
  });

  it('joins the block above when the gap is tight, else the one below', () => {
    const tight = insertManualLine([L(0.1, 0.15, { blockIdx: 2 })], { text: 't', x0: 0.1, y0: 0.16, x1: 0.9, y1: 0.2 });
    expect(tight[1].blockIdx).toBe(2);
    const far = insertManualLine(
      [L(0.05, 0.08, { blockIdx: 1 }), L(0.7, 0.75, { blockIdx: 4 })],
      { text: 't', x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.55 },
    );
    expect(far[1].blockIdx).toBe(4);
  });

  it('marks the line manual + enabled, and fromImage only when asked (erase-mode overlays)', () => {
    const plain = insertManualLine([], { text: 't', x0: 0, y0: 0, x1: 1, y1: 0.1 })[0];
    expect(plain.manual).toBe(true);
    expect(plain.enabled).toBe(true);
    expect(plain.fromImage).toBeUndefined();
    const erase = insertManualLine([], { text: 't', x0: 0, y0: 0, x1: 1, y1: 0.1 }, { fromImage: true })[0];
    expect(erase.fromImage).toBe(true);
  });
});

describe('recalcBoundaries', () => {
  it('keeps boundaries monotonic even for overlapping rows (side-by-side lines)', () => {
    const out = recalcBoundaries([L(0.1, 0.2), L(0.12, 0.18), L(0.5, 0.6)]);
    for (let i = 1; i < out.length; i++) expect(out[i].bottomFrac).toBeGreaterThanOrEqual(out[i - 1].bottomFrac);
    expect(out[2].bottomFrac).toBe(1);
  });

  it('recomputes endsBlock from blockIdx transitions', () => {
    const out = recalcBoundaries([L(0.1, 0.15, { blockIdx: 0 }), L(0.2, 0.25, { blockIdx: 0 }), L(0.5, 0.55, { blockIdx: 1 })]);
    expect(out.map(l => l.endsBlock)).toEqual([false, true, true]);
  });

  it('never places a boundary above the line’s own bottom', () => {
    // A next line that OVERLAPS this one would put the midpoint inside the text; clamp to y1.
    const out = recalcBoundaries([L(0.1, 0.3), L(0.15, 0.35)]);
    expect(out[0].bottomFrac).toBeGreaterThanOrEqual(0.3);
  });
});
