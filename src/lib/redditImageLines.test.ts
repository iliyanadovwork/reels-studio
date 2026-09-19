import { describe, it, expect } from 'vitest';
import { spliceImageLines, belowBandBoundaryFrac, type BandRect } from './redditImageLines';
import type { MemeLine } from './memeOcr';

// Geometry mirrors a real card: 1080 wide, tall canvas, band under the post text.
const W = 1080, H = 2400;
const BAND: BandRect = { x: 76, y: 600, w: 928, h: 600 };   // band spans y 600..1200
const FINAL = 0.53;   // (postBottom + firstComment.top)/2 / H — below the band (1200/2400 = 0.5)

const line = (over: Partial<MemeLine>): MemeLine => ({
  text: 'x', bottomFrac: 0.5, endsBlock: false, blockIdx: 0,
  x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.15, ...over,
});

/** A representative card map: 2 title lines, 1 body line, 2 comment lines. */
const cardLines = (): MemeLine[] => [
  line({ text: 'title a', blockIdx: 0, bottomFrac: 0.10 }),
  line({ text: 'title b', blockIdx: 0, bottomFrac: 0.15, endsBlock: true }),
  line({ text: 'body', blockIdx: 1, bottomFrac: 0.24, endsBlock: true }),   // crops just above the band
  line({ text: 'comment 1', blockIdx: 2, bottomFrac: 0.60, endsBlock: true }),
  line({ text: 'comment 2', blockIdx: 3, bottomFrac: 1, endsBlock: true }),
];

const ocr = (): MemeLine[] => [
  line({ text: 'top of meme', blockIdx: 0, bottomFrac: 0.3, y0: 0.05, y1: 0.25 }),
  line({ text: 'bottom of meme', blockIdx: 1, bottomFrac: 1, endsBlock: true, y0: 0.6, y1: 0.8 }),
];

describe('spliceImageLines', () => {
  it('returns the EXACT same array when OCR found nothing — the keep-the-dwell signal', () => {
    const lines = cardLines();
    expect(spliceImageLines({ lines, imageOcr: [], band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL })).toBe(lines);
  });

  it('inserts the image lines after the last post line and before the first comment', () => {
    const out = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    expect(out.map(l => l.text)).toEqual([
      'title a', 'title b', 'body', 'top of meme', 'bottom of meme', 'comment 1', 'comment 2',
    ]);
  });

  it('maps interior boundaries from image space into the band, not the card', () => {
    const out = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    // bottomFrac 0.3 of a band at y=600 h=600 → (600 + 0.3*600) / 2400 = 780/2400 = 0.325
    expect(out[3].bottomFrac).toBeCloseTo(0.325, 10);
  });

  it('gives the LAST image line the dwell’s old below-band boundary — pills ride along', () => {
    const out = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    // NOT (600 + 1.0*600)/2400 = 0.5 (the band's own bottom) — the caller's boundary wins.
    expect(out[4].bottomFrac).toBe(FINAL);
  });

  it('keeps the whole map monotonic so no reveal ever crops back up', () => {
    const out = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    for (let i = 1; i < out.length; i++) {
      expect(out[i].bottomFrac, `${out[i - 1].text} → ${out[i].text}`).toBeGreaterThanOrEqual(out[i - 1].bottomFrac);
    }
  });

  it('converts bboxes into card space for the highlight buttons', () => {
    const out = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    // x0 0.1 of band w=928 at x=76 → (76 + 92.8)/1080; y0 0.05 of band h=600 at y=600 → 630/2400
    expect(out[3].x0).toBeCloseTo((76 + 0.1 * 928) / 1080, 10);
    expect(out[3].y0).toBeCloseTo((600 + 0.05 * 600) / 2400, 10);
    expect(out[3].x1).toBeCloseTo((76 + 0.9 * 928) / 1080, 10);
    expect(out[3].y1).toBeCloseTo((600 + 0.25 * 600) / 2400, 10);
  });

  it('assigns blockIdx 1 to every image line — the image IS the post, so it gets the post’s voice', () => {
    const out = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    expect(out[3].blockIdx).toBe(1);
    expect(out[4].blockIdx).toBe(1);
    // Comment blocks are untouched — no renumbering, so blockAuthors keeps working.
    expect(out[5].blockIdx).toBe(2);
    expect(out[6].blockIdx).toBe(3);
  });

  it('always ends the image on a block boundary, and keeps OCR’s interior block ends', () => {
    const three = [
      line({ text: 'a', blockIdx: 0, bottomFrac: 0.2, endsBlock: true }),   // real pause inside the meme
      line({ text: 'b', blockIdx: 1, bottomFrac: 0.6 }),
      line({ text: 'c', blockIdx: 1, bottomFrac: 1 }),                       // OCR says mid-block…
    ];
    const out = spliceImageLines({ lines: cardLines(), imageOcr: three, band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    expect(out[3].endsBlock).toBe(true);    // kept from OCR
    expect(out[4].endsBlock).toBe(false);
    expect(out[5].endsBlock).toBe(true);    // …but the last line ALWAYS ends the block — a comment follows
  });

  it('inserts at the front when no post line exists (image above every narratable line)', () => {
    const commentsOnly = [
      line({ text: 'comment 1', blockIdx: 2, bottomFrac: 0.6 }),
      line({ text: 'comment 2', blockIdx: 3, bottomFrac: 1 }),
    ];
    const out = spliceImageLines({ lines: commentsOnly, imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    expect(out.map(l => l.text)).toEqual(['top of meme', 'bottom of meme', 'comment 1', 'comment 2']);
  });

  it('clamps out-of-range OCR geometry instead of emitting fractions outside 0..1', () => {
    // Tesseract can report boxes a hair outside the image; a bottomFrac > 1 would make the reveal
    // overshoot the card and a negative x would put a highlight off-canvas.
    const wild = [line({ text: 'w', bottomFrac: 1.4, x0: -0.2, y0: -0.1, x1: 1.3, y1: 1.2, endsBlock: true })];
    const tallBand: BandRect = { x: 76, y: 1900, w: 928, h: 600 };   // band near the card's bottom
    const out = spliceImageLines({ lines: cardLines(), imageOcr: wild, band: tallBand, cardW: W, cardH: H, finalBoundaryFrac: 1 });
    const l = out[3];
    for (const v of [l.bottomFrac, l.x0, l.y0, l.x1, l.y1]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('does not mutate its inputs', () => {
    const lines = cardLines(); const snapshot = structuredClone(lines);
    const io = ocr(); const ioSnapshot = structuredClone(io);
    spliceImageLines({ lines, imageOcr: io, band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    expect(lines).toEqual(snapshot);
    expect(io).toEqual(ioSnapshot);
  });
});

describe('spliceImageLines — review-hardening cases', () => {
  it('a SINGLE OCR line still takes the below-band boundary — the most common meme shape', () => {
    // Killed mutant: `last && imageOcr.length > 1`. One caption line whose boundary stopped at the
    // band's own bottom would leave the pills below it never revealed by any beat.
    const one = [line({ text: 'the only caption', bottomFrac: 1, endsBlock: true })];
    const out = spliceImageLines({ lines: cardLines(), imageOcr: one, band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    expect(out[3].text).toBe('the only caption');
    expect(out[3].bottomFrac).toBe(FINAL);
  });

  it('clamps an INTERIOR line’s out-of-range boundary (the last line bypasses that code path)', () => {
    // Killed mutant: interior clamp01 removed. Needs ≥2 lines: the last line takes finalBoundaryFrac,
    // so only an interior line exercises the mapped-and-clamped branch.
    const band: BandRect = { x: 76, y: 2100, w: 928, h: 600 };   // band overruns the card bottom
    const two = [
      line({ text: 'a', bottomFrac: 1.2 }),                      // maps to (2100 + 720)/2400 > 1
      line({ text: 'b', bottomFrac: 1, endsBlock: true }),
    ];
    const out = spliceImageLines({ lines: cardLines(), imageOcr: two, band, cardW: W, cardH: H, finalBoundaryFrac: 1 });
    expect(out[3].bottomFrac).toBe(1);
    expect(out[3].bottomFrac).toBeLessThanOrEqual(out[4].bottomFrac);
  });
});

describe('belowBandBoundaryFrac', () => {
  it('is the midpoint between the post bottom and the first comment top, as a card fraction', () => {
    expect(belowBandBoundaryFrac(1200, 1344, 2400)).toBeCloseTo((1200 + 1344) / 2 / 2400, 10);
  });

  it('reaches the card bottom when there are no comments', () => {
    expect(belowBandBoundaryFrac(1200, null, 2400)).toBe(1);
  });

  it('never leaves 0..1, whatever the geometry', () => {
    expect(belowBandBoundaryFrac(2500, 2600, 2400)).toBe(1);    // boundary past the card edge
    expect(belowBandBoundaryFrac(-10, -5, 2400)).toBe(0);       // degenerate negative layout
    expect(belowBandBoundaryFrac(1200, 1344, 0)).toBe(1);       // zero-height card: reveal everything
  });
});

describe('spliceImageLines — erase mode', () => {
  it('gives EVERY image line the below-band boundary — the crop jumps past the whole image at once', () => {
    const out = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL, mode: 'erase' });
    expect(out[3].bottomFrac).toBe(FINAL);
    expect(out[4].bottomFrac).toBe(FINAL);
    // Everything else is identical to crop mode: position, block, flags.
    expect(out.map(l => l.text)).toEqual(['title a', 'title b', 'body', 'top of meme', 'bottom of meme', 'comment 1', 'comment 2']);
    expect(out[3].blockIdx).toBe(1);
  });

  it('marks image lines fromImage in BOTH modes — narration and covers need to find them', () => {
    for (const mode of ['crop', 'erase'] as const) {
      const out = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL, mode });
      expect(out.map(l => !!l.fromImage), mode).toEqual([false, false, false, true, true, false, false]);
    }
  });

  it('defaults to crop mode — the existing boundary behaviour is unchanged without the option', () => {
    const explicit = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL, mode: 'crop' });
    const implicit = spliceImageLines({ lines: cardLines(), imageOcr: ocr(), band: BAND, cardW: W, cardH: H, finalBoundaryFrac: FINAL });
    expect(implicit).toEqual(explicit);
    expect(implicit[3].bottomFrac).toBeCloseTo(0.325, 10);   // interior boundary still maps into the band
  });
});
