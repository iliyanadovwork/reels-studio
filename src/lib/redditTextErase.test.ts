import { describe, it, expect } from 'vitest';
import { planCoverStrips, coverLiftTimes, coverDrawOps, type CoverStrip } from './redditTextErase';
import type { MemeLine } from './memeOcr';
import type { BandRect } from './redditImageLines';

// A 1000x800 source image in a band at card (76,600) sized 500x400 (uniform 0.5 scale) on a
// 1080x2400 card — round numbers so every expected value below is derivable by hand.
const IMG_W = 1000, IMG_H = 800;
const BAND: BandRect = { x: 76, y: 600, w: 500, h: 400 };
const CARD_W = 1080, CARD_H = 2400;

const ocrLine = (over: Partial<MemeLine>): MemeLine => ({
  text: 'x', bottomFrac: 0.5, endsBlock: false, blockIdx: 0,
  x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15, ...over,
});

const plan = (lines: MemeLine[], idxs = lines.map((_, i) => 3 + i)) =>
  planCoverStrips(lines, idxs, IMG_W, IMG_H, BAND, CARD_W, CARD_H);

describe('planCoverStrips — strip geometry', () => {
  it('pads the OCR bbox so glyph halos and descenders are covered too', () => {
    // Line at y 80..120 (h=40): padY = 14, padX = 24. Box x 100..900.
    const p = plan([ocrLine({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15 })]);
    expect(p.strips).toHaveLength(1);
    const s = p.strips[0].src;
    expect(s.x).toBeCloseTo(100 - 24, 6);
    expect(s.y).toBeCloseTo(80 - 14, 6);
    expect(s.w).toBeCloseTo(800 + 48, 6);
    expect(s.h).toBeCloseTo(40 + 28, 6);
  });

  it('clamps padding at the image edges', () => {
    const p = plan([ocrLine({ x0: 0, y0: 0, x1: 1, y1: 0.05 })]);   // full-width line at the very top
    const s = p.strips[0].src;
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
    expect(s.x + s.w).toBeLessThanOrEqual(IMG_W);
  });

  it('NEVER lets adjacent strips overlap — a lifting strip must not expose a neighbour', () => {
    // Two tightly stacked lines whose padded boxes collide; they must split at the overlap midline.
    const a = ocrLine({ y0: 0.10, y1: 0.15 });   // 80..120, padded → 66..134
    const b = ocrLine({ y0: 0.16, y1: 0.21 });   // 128..168, padded → 114..182 — collides with a
    const p = plan([a, b]);
    const [sa, sb] = p.strips.map(s => s.src);
    expect(sa.y + sa.h).toBeLessThanOrEqual(sb.y + 1e-9);
    // The LATER line keeps its rows (its cover lifts on a later beat): boundary = b's padded top 114.
    expect(sa.y + sa.h).toBeCloseTo(114, 6);
    expect(sb.y).toBeCloseTo(114, 6);
  });

  it('leaves horizontally disjoint strips alone even when their rows overlap', () => {
    const left = ocrLine({ x0: 0.05, x1: 0.4, y0: 0.1, y1: 0.15 });
    const right = ocrLine({ x0: 0.6, x1: 0.95, y0: 0.12, y1: 0.17 });
    const p = plan([left, right]);
    expect(p.strips[0].src.h).toBeCloseTo(40 + 28, 6);   // unclipped
    expect(p.strips[1].src.h).toBeCloseTo(40 + 28, 6);
  });

  it('maps dest rects into CARD fractions through the band transform', () => {
    const p = plan([ocrLine({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15 })]);
    const d = p.strips[0].dest;
    // src x=76px into a 0.5-scale band at x=76 → (76 + 38)/1080.
    expect(d.x).toBeCloseTo((BAND.x + 76 * 0.5) / CARD_W, 6);
    expect(d.y).toBeCloseTo((BAND.y + 66 * 0.5) / CARD_H, 6);
    expect(d.w).toBeCloseTo((848 * 0.5) / CARD_W, 6);
    expect(d.h).toBeCloseTo((68 * 0.5) / CARD_H, 6);
  });

  it('stacks the atlas vertically with a gutter and sizes it to the widest strip', () => {
    const p = plan([
      ocrLine({ x0: 0.1, x1: 0.9, y0: 0.1, y1: 0.15 }),
      ocrLine({ x0: 0.2, x1: 0.5, y0: 0.5, y1: 0.55 }),
    ]);
    expect(p.strips[0].atlas).toEqual({ x: 0, y: 0 });
    expect(p.strips[1].atlas.y).toBeCloseTo(p.strips[0].src.h + 2, 6);
    expect(p.atlasW).toBe(Math.ceil(p.strips[0].src.w));
    expect(p.atlasH).toBe(Math.ceil(p.strips[1].atlas.y + p.strips[1].src.h));
  });

  it('carries each strip’s card-line index through', () => {
    const p = plan([ocrLine({}), ocrLine({ y0: 0.5, y1: 0.55 })], [7, 8]);
    expect(p.strips.map(s => s.lineIdx)).toEqual([7, 8]);
  });

  it('returns an empty plan for no lines or degenerate geometry', () => {
    expect(plan([]).strips).toEqual([]);
    expect(planCoverStrips([ocrLine({})], [0], 0, 0, BAND, CARD_W, CARD_H).strips).toEqual([]);
  });
});

describe('coverLiftTimes — the three line states', () => {
  const strip = (lineIdx: number): CoverStrip => ({
    lineIdx, src: { x: 0, y: 0, w: 10, h: 10 }, atlas: { x: 0, y: 0 }, dest: { x: 0, y: 0, w: 0.1, h: 0.1 },
  });
  const L = (enabled: boolean, erased = false) => ({ enabled, erased });
  const on = L(true);

  it('NARRATED: lifts at the line’s reveal beat', () => {
    const t = coverLiftTimes([strip(3), strip(4)], [on, on, on, on, on], i => i * 10);
    expect(t).toEqual([30, 40]);
  });

  it('SILENT: lifts immediately (-1) — visible from the moment the image is, just never read', () => {
    // Matches crop mode, where a skipped line still shows. -1 rather than -Infinity: these persist
    // through JSON, and JSON.stringify(-Infinity) is null — which would flip visible into erased.
    const t = coverLiftTimes([strip(3), strip(4)], [on, on, on, L(false), on], i => i * 10);
    expect(t).toEqual([-1, 40]);
  });

  it('ERASED: never lifts — the text is removed from the video outright', () => {
    const t = coverLiftTimes([strip(3), strip(4)], [on, on, on, L(false, true), on], i => i * 10);
    expect(t).toEqual([null, 40]);
  });

  it('erased wins even if enabled is somehow still true — never voice-and-hide inconsistently', () => {
    expect(coverLiftTimes([strip(0)], [L(true, true)], () => 5)).toEqual([null]);
  });

  it('treats a narrated line with no reveal time as never lifting rather than lifting at 0', () => {
    expect(coverLiftTimes([strip(3)], [on, on, on, on], () => undefined)).toEqual([null]);
  });

  it('treats an unmapped lineIdx as never lifting', () => {
    expect(coverLiftTimes([strip(-1)], [on], () => 5)).toEqual([null]);
  });

  it('lifts at time 0 (falsy) correctly — 0 is a real beat, not a missing one', () => {
    expect(coverLiftTimes([strip(0)], [on], () => 0)).toEqual([0]);
  });
});

describe('planCoverStrips — nesting and axis wiring (review-hardening)', () => {
  const disjoint = (strips: { src: { x: number; y: number; w: number; h: number } }[]) => {
    for (let i = 0; i < strips.length; i++) for (let j = i + 1; j < strips.length; j++) {
      const a = strips[i].src, b = strips[j].src;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap, `strips ${i}/${j} overlap`).toBe(false);
    }
  };

  it('a NESTED line splits the swallowing strip instead of leaving them overlapping', () => {
    // The review's reproduction: a tall stylised line whose padded box contains the next line
    // entirely. The old midline split kept the tall strip ACROSS the nested one, so lifting the
    // tall line exposed the nested (possibly muted) text.
    const tall = ocrLine({ x0: 0.1, x1: 0.9, y0: 0.05, y1: 0.19 });    // padded ≈ [1, 191]
    const nested = ocrLine({ x0: 0.2, x1: 0.6, y0: 0.075, y1: 0.1 });  // padded ≈ [53, 87]
    const p = plan([tall, nested], [3, 4]);
    disjoint(p.strips);
    // The tall line keeps covers ABOVE and BELOW the nested one, both on its own lineIdx; the
    // nested line owns its full rows.
    const byLine = (idx: number) => p.strips.filter(s => s.lineIdx === idx);
    expect(byLine(3).length).toBe(2);
    expect(byLine(4).length).toBe(1);
    const nestedStrip = byLine(4)[0].src;
    expect(nestedStrip.y).toBeLessThanOrEqual(0.075 * IMG_H);
    expect(nestedStrip.y + nestedStrip.h).toBeGreaterThanOrEqual(0.1 * IMG_H);
  });

  it('stays disjoint under a chain of colliding lines', () => {
    const lines = [0.1, 0.14, 0.18, 0.22].map(y => ocrLine({ y0: y, y1: y + 0.05 }));
    disjoint(plan(lines).strips);
  });

  it('pins the dest axes through a NON-uniform band transform', () => {
    // Killed mutant: scaleX/scaleY swap — invisible under the uniform-scale fixture band.
    const band: BandRect = { x: 10, y: 100, w: 500, h: 200 };   // x-scale 0.5, y-scale 0.25
    const p = planCoverStrips([ocrLine({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15 })], [0], IMG_W, IMG_H, band, CARD_W, CARD_H);
    const d = p.strips[0].dest;
    expect(d.x).toBeCloseTo((10 + 76 * 0.5) / CARD_W, 6);       // src x=76 × scaleX
    expect(d.y).toBeCloseTo((100 + 66 * 0.25) / CARD_H, 6);     // src y=66 × scaleY
    expect(d.w).toBeCloseTo((848 * 0.5) / CARD_W, 6);
    expect(d.h).toBeCloseTo((68 * 0.25) / CARD_H, 6);
  });
});

describe('coverDrawOps — the per-frame cover decision', () => {
  const patch = (destY: number, destH = 0.1): CoverStrip => ({
    lineIdx: 0, src: { x: 0, y: 0, w: 100, h: 40 }, atlas: { x: 0, y: 60 },
    dest: { x: 0.1, y: destY, w: 0.5, h: destH },
  });
  const o = (patches: CoverStrip[], lifts: (number | null)[]) =>
    ({ x: 100, w: 800, h: 1000, coverPatches: patches, coverLifts: lifts });

  it('draws nothing without lifts — an un-narrated card shows its text plainly', () => {
    expect(coverDrawOps({ x: 0, w: 1, h: 1, coverPatches: [patch(0.2)] }, 5, 1, 0, 0.35)).toEqual([]);
    expect(coverDrawOps({ x: 0, w: 1, h: 1, coverLifts: [5] }, 5, 1, 0, 0.35)).toEqual([]);
  });

  it('covers before the lift, fades during it, disappears after', () => {
    const ov = o([patch(0.2)], [10]);
    expect(coverDrawOps(ov, 9, 1, 0, 0.35)[0].alpha).toBe(1);
    const mid = coverDrawOps(ov, 10.1, 1, 0, 0.35)[0];
    expect(mid.alpha).toBeGreaterThan(0);
    expect(mid.alpha).toBeLessThan(1);
    expect(coverDrawOps(ov, 10.4, 1, 0, 0.35)).toEqual([]);
  });

  it('a null lift covers FOREVER — the muted-junk contract at the draw level', () => {
    expect(coverDrawOps(o([patch(0.2)], [null]), 9999, 1, 0, 0.35)[0].alpha).toBe(1);
  });

  it('a missing lift entry behaves like null, never like lift-at-0', () => {
    expect(coverDrawOps(o([patch(0.2), patch(0.4)], [5]), 9999, 1, 0, 0.35)).toHaveLength(1);
  });

  it('clips to the crop front and never floats below the revealed slice', () => {
    const ov = o([patch(0.5, 0.2)], [null]);
    expect(coverDrawOps(ov, 0, 0.4, 0, 0.35)).toEqual([]);               // entirely below the front
    const half = coverDrawOps(ov, 0, 0.6, 0, 0.35)[0];                    // front bisects the strip
    expect(half.dh).toBeCloseTo(0.1 * 1000, 6);
    expect(half.sh).toBeCloseTo(40 * 0.5, 6);                             // atlas rows clip proportionally
    const full = coverDrawOps(ov, 0, 1, 0, 0.35)[0];
    expect(full.dh).toBeCloseTo(0.2 * 1000, 6);
  });

  it('rides the teleprompter translation: dest y is drawTop-relative', () => {
    const op0 = coverDrawOps(o([patch(0.2)], [null]), 0, 1, 0, 0.35)[0];
    const op9 = coverDrawOps(o([patch(0.2)], [null]), 0, 1, -300, 0.35)[0];
    expect(op9.dy).toBeCloseTo(op0.dy - 300, 6);
    expect(op0.dx).toBeCloseTo(100 + 0.1 * 800, 6);
  });
});
