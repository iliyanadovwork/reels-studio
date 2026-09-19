// Geometry for the ERASE reveal mode: the post image appears whole from its first beat, with every
// text line hidden under a blur-filled "cover strip"; each strip lifts on its line's narration beat,
// un-erasing the ORIGINAL pixels (no re-typesetting — the reveal is the image's own text).
//
// This module is the pure maths: where the strips are (padded, non-overlapping, clamped), how they
// pack into one small atlas bitmap, and when each lifts. The pixel work — blur-filling the strips and
// blitting them into the atlas — lives in redditCard next to the canvas it needs.
//
// Two invariants the tests pin:
//   · strips NEVER overlap: a lifting strip must not un-cover a sliver of a neighbour's still-hidden
//     text (adjacent OCR lines' padded boxes routinely collide, so the later line keeps its rows and
//     the earlier is carved around it — including a below-remainder strip when its box swallowed the
//     later line whole);
//   · a line with no lift time stays covered FOREVER — that's the muted-junk feature: disabling a
//     garbage OCR line in erase mode removes its text from the video outright.

import type { MemeLine } from './memeOcr';
import type { BandRect } from './redditImageLines';

/** One text line's cover, in three coordinate spaces at once: where it sits in the SOURCE image
    (pixels — the region to blur-fill), where it sits in the ATLAS (pixels — where the filled strip
    is stored), and where it lands on the CARD (fractions — the draw-time dest, same space as
    MemeLine bboxes). `lineIdx` indexes the card's ocrLines — the image lines' positions there. */
export interface CoverStrip {
  lineIdx: number;
  src: { x: number; y: number; w: number; h: number };
  atlas: { x: number; y: number };
  dest: { x: number; y: number; w: number; h: number };
}

export interface CoverPlan {
  strips: CoverStrip[];
  atlasW: number;
  atlasH: number;
}

/** Gap between strips in the atlas, so bilinear sampling at the edge of one strip can never bleed a
    neighbour's pixels in. */
const ATLAS_GUTTER = 2;

// Padding around the OCR bbox: tesseract's line boxes hug the glyph cores, but antialiasing halos,
// ascenders/descenders and drop shadows spill past them — an unpadded cover leaves a readable ghost
// outline of the "erased" text. Proportional to the line's own height so big captions get big pads.
const PAD_Y_FRAC = 0.35;
const PAD_X_FRAC = 0.6;    // of line height, not width — horizontal spill is glyph-sized, not line-sized

/**
 * Cover strips for an image's OCR lines.
 *
 * @param imageLines  the OCR lines carrying image-space fraction bboxes (extractMemeLines output)
 * @param lineIdxOf   index of each image line within the CARD's final ocrLines array
 * @param imageW/H    the source image's natural pixel size
 * @param band        the image band's rect on the card, card pixels
 * @param cardW/H     card pixel size (dest rects come out as fractions of these)
 */
export function planCoverStrips(
  imageLines: readonly MemeLine[],
  lineIdxOf: readonly number[],
  imageW: number,
  imageH: number,
  band: BandRect,
  cardW: number,
  cardH: number,
): CoverPlan {
  if (!imageLines.length || !(imageW > 0) || !(imageH > 0) || !(cardW > 0) || !(cardH > 0)) {
    return { strips: [], atlasW: 0, atlasH: 0 };
  }

  // Fraction bboxes → padded pixel rects, clamped to the image.
  const rects = imageLines.map(ln => {
    const h = Math.max(1, (ln.y1 - ln.y0) * imageH);
    const padY = h * PAD_Y_FRAC;
    const padX = h * PAD_X_FRAC;
    const x = Math.max(0, ln.x0 * imageW - padX);
    const y = Math.max(0, ln.y0 * imageH - padY);
    return {
      x,
      y,
      w: Math.min(imageW, ln.x1 * imageW + padX) - x,
      h: Math.min(imageH, ln.y1 * imageH + padY) - y,
    };
  });

  // De-overlap vertically IN ORDER (OCR lines arrive top-to-bottom). Two cases, both resolved by
  // giving CUR its full rows and carving PREV around it (cur's cover lifts on a later beat, so
  // ownership shifting to cur only holds prev's padding halo covered slightly longer):
  //   · plain collision — prev's bottom reaches into cur: prev is trimmed to cur's top;
  //   · NESTING — a tall stylised line's padded box swallows the next line entirely: trimming alone
  //     left the rects overlapping (review-reproduced: prev [5,175] ⊃ cur [53,87] kept prev rows to
  //     the midline 114, ACROSS cur), so prev's below-cur remainder becomes an EXTRA strip carrying
  //     prev's own lineIdx — multiple strips per line are fine, lifts map per strip.
  // A final strict-stacking sweep then guarantees global disjointness whatever the input shape.
  type Rect = { x: number; y: number; w: number; h: number; line: number };
  let carved: Rect[] = rects.map((r, i) => ({ ...r, line: i }));
  for (let i = 1; i < carved.length; i++) {
    const cur = carved[i];
    const prev = carved[i - 1];
    const prevBottom = prev.y + prev.h;
    const curBottom = cur.y + cur.h;
    if (cur.y < prevBottom && overlapsHorizontally(prev, cur)) {
      if (prevBottom > curBottom) {
        carved.push({ x: prev.x, y: curBottom, w: prev.w, h: prevBottom - curBottom, line: prev.line });
      }
      prev.h = Math.max(0, cur.y - prev.y);
    }
  }
  // Strict disjointness sweep — RECTANGLE disjointness, not row disjointness: side-by-side strips
  // (two text columns) may share rows freely, since lifting one exposes nothing of the other. Each
  // rect's top is clipped to the lowest bottom of any EARLIER rect it horizontally overlaps.
  carved = carved.filter(r => r.h > 0 && r.w > 0).sort((a, b) => a.y - b.y);
  const placed: Rect[] = [];
  for (const r of carved) {
    let top = r.y;
    for (const q of placed) if (overlapsHorizontally(q, r) && q.y + q.h > top) top = Math.max(top, q.y + q.h);
    if (top > r.y) { r.h -= top - r.y; r.y = top; }
    if (r.h > 0) placed.push(r);
  }
  carved = placed;

  // Vertical-stack atlas: one strip per row. Simple beats clever — strips are text-line shaped
  // (wide, short), so a vertical stack wastes little and keeps lookup trivial.
  const scaleX = band.w / imageW;
  const scaleY = band.h / imageH;
  const strips: CoverStrip[] = [];
  let atlasY = 0;
  let atlasW = 0;
  carved.forEach(r => {
    strips.push({
      lineIdx: lineIdxOf[r.line] ?? -1,
      src: { x: r.x, y: r.y, w: r.w, h: r.h },
      atlas: { x: 0, y: atlasY },
      dest: {
        x: (band.x + r.x * scaleX) / cardW,
        y: (band.y + r.y * scaleY) / cardH,
        w: (r.w * scaleX) / cardW,
        h: (r.h * scaleY) / cardH,
      },
    });
    atlasY += r.h + ATLAS_GUTTER;
    atlasW = Math.max(atlasW, r.w);
  });
  return { strips, atlasW: Math.ceil(atlasW), atlasH: Math.ceil(Math.max(0, atlasY - ATLAS_GUTTER)) };
}

const overlapsHorizontally = (a: { x: number; w: number }, b: { x: number; w: number }): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w;

/**
 * When each cover lifts, per line state:
 *   · narrated (enabled)        → at its reveal beat — text un-erases as the voice reaches it;
 *   · silent   (!enabled)       → -1, i.e. already lifted: the text is VISIBLE from the moment the
 *     image is, it's just never read (matches crop mode, where a skipped line still shows);
 *   · erased   (erased: true)   → null, never lifts — the text is removed from the video (junk OCR).
 *
 * -1 rather than -Infinity for "already lifted": these persist through JSON, and
 * JSON.stringify(-Infinity) is null — which would silently flip "visible" into "erased forever".
 * Beats are ≥ 0 (audioStart + a non-negative offset), so -1 can never collide with a real one.
 *
 * `revealTimeOf` maps a card-line index to its reveal time (the caller derives it from the same
 * beats that drive the crop), returning undefined for lines that produce no step.
 */
export function coverLiftTimes(
  strips: readonly CoverStrip[],
  lines: readonly { enabled: boolean; erased?: boolean }[],
  revealTimeOf: (lineIdx: number) => number | undefined,
): (number | null)[] {
  return strips.map(s => {
    const line = s.lineIdx >= 0 ? lines[s.lineIdx] : undefined;
    if (!line || line.erased) return null;
    if (!line.enabled) return -1;
    const t = revealTimeOf(s.lineIdx);
    return t === undefined ? null : t;
  });
}

// ── Pixel work (browser-only; the maths above stays node-testable) ─────────────────────────────────

/** Paint the cover strips: each text region blur-filled from ITS OWN surroundings, so on a flat
    caption background the cover is indistinguishable from "no text was ever here", and on a photo it
    reads as a soft smudge. The blur is drawn from a PADDED source region onto a temp canvas and only
    the interior is cut into the atlas — a canvas blur pulls transparency in from the edges of
    whatever was drawn, and an edge halo would let the "erased" text ghost through. */
export async function renderCoverAtlas(image: HTMLImageElement, plan: CoverPlan): Promise<Blob | null> {
  if (!plan.strips.length || !(plan.atlasW > 0) || !(plan.atlasH > 0)) return null;
  const atlas = document.createElement('canvas');
  atlas.width = plan.atlasW;
  atlas.height = plan.atlasH;
  const actx = atlas.getContext('2d');
  if (!actx) return null;
  for (const s of plan.strips) {
    const r = Math.max(4, Math.round(s.src.h / 3));   // radius scales with the text size being hidden
    const pad = 2 * r;
    const t = document.createElement('canvas');
    t.width = Math.ceil(s.src.w + pad * 2);
    t.height = Math.ceil(s.src.h + pad * 2);
    const tctx = t.getContext('2d');
    if (!tctx) return null;
    // The padded source rect, clamped to the image — with the temp-space landing offset kept in sync
    // so the interior cut below always addresses the same pixels.
    const sx = Math.max(0, s.src.x - pad);
    const sy = Math.max(0, s.src.y - pad);
    const sw = Math.min(image.naturalWidth, s.src.x + s.src.w + pad) - sx;
    const sh = Math.min(image.naturalHeight, s.src.y + s.src.h + pad) - sy;
    // Backfill FIRST: when the padded rect is clamped by an image edge (top-text memes — routine),
    // the drawn region's edge lands inside the blur's reach and the blur pulls TRANSPARENCY across
    // the interior cut — review measured the cover at ~50% alpha over the glyphs it exists to hide.
    // Stretching the clamped region over the whole temp canvas first makes every pixel opaque with
    // locally-plausible color; the true content then lands on top at its correct position.
    const fill = document.createElement('canvas');
    fill.width = t.width;
    fill.height = t.height;
    const fctx = fill.getContext('2d');
    if (!fctx) return null;
    fctx.drawImage(image, sx, sy, sw, sh, 0, 0, fill.width, fill.height);
    fctx.drawImage(image, sx, sy, sw, sh, sx - (s.src.x - pad), sy - (s.src.y - pad), sw, sh);
    tctx.filter = `blur(${r}px)`;
    tctx.drawImage(fill, 0, 0);
    actx.drawImage(t, pad, pad, s.src.w, s.src.h, s.atlas.x, s.atlas.y, s.src.w, s.src.h);
  }
  return new Promise(res => atlas.toBlob(b => res(b), 'image/png'));
}

/** Cover assets for a MEME overlay, where the overlay IS the image: the band is the whole image, so
    dest fractions are just the padded strip rects over the image itself, and every OCR line is an
    image line. Returns null when the image can't decode or nothing needs covering — the caller then
    simply doesn't get erase mode, which is the same outcome as crop. */
export async function buildMemeCoverAssets(src: string, lines: readonly MemeLine[]): Promise<{
  coverAtlas: { blob: Blob; w: number; h: number };
  coverPatches: CoverStrip[];
} | null> {
  if (!lines.length) return null;
  const image = await new Promise<HTMLImageElement | null>(resolve => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => resolve(null);
    el.src = src;
  });
  if (!image || !image.naturalWidth || !image.naturalHeight) return null;
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const plan = planCoverStrips(lines, lines.map((_, i) => i), w, h, { x: 0, y: 0, w, h }, w, h);
  const blob = await renderCoverAtlas(image, plan);
  if (!blob || !plan.strips.length) return null;
  return { coverAtlas: { blob, w: plan.atlasW, h: plan.atlasH }, coverPatches: plan.strips };
}

/** One cover draw, precomputed: atlas source rect (px), canvas dest rect (px), and opacity. */
export interface CoverDrawOp {
  sx: number; sy: number; sw: number; sh: number;
  dx: number; dy: number; dw: number; dh: number;
  alpha: number;
}

/**
 * The cover draws for one overlay at time `t` — the WHOLE per-frame decision, pure so it's testable
 * without a canvas: which strips still cover (lift null = forever; mid-fade = partial alpha), and
 * where they land given the overlay's rect, the crop fraction `f` (strips clip to the crop front and
 * never float below the revealed slice) and the frame's `drawTop` (the teleprompter translation).
 * `transitionS` is the lift fade — pass the same constant the crop ease uses.
 */
export function coverDrawOps(
  o: { x: number; w: number; h: number; coverPatches?: CoverStrip[] | { lineIdx: number; src: { x: number; y: number; w: number; h: number }; atlas: { x: number; y: number }; dest: { x: number; y: number; w: number; h: number } }[]; coverLifts?: (number | null)[] },
  t: number,
  f: number,
  drawTop: number,
  transitionS: number,
): CoverDrawOp[] {
  const patches = o.coverPatches;
  const lifts = o.coverLifts;
  if (!patches?.length || !lifts?.length) return [];
  const ops: CoverDrawOp[] = [];
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    const lift = lifts[i] ?? null;   // no narration-time entry = never lifts (muted line)
    let alpha = 1;
    if (lift !== null && t > lift) {
      const u = Math.min(1, (t - lift) / transitionS);
      if (u >= 1) continue;          // fully lifted — original text shows
      alpha = 1 - (1 - Math.pow(1 - u, 3));   // 1 - easeOutCubic(u)
    }
    const visibleFrac = Math.min(p.dest.h, Math.max(0, f - p.dest.y));
    if (visibleFrac <= 0 || !(p.dest.h > 0)) continue;
    ops.push({
      sx: p.atlas.x, sy: p.atlas.y, sw: p.src.w, sh: p.src.h * (visibleFrac / p.dest.h),
      dx: o.x + p.dest.x * o.w, dy: drawTop + p.dest.y * o.h, dw: p.dest.w * o.w, dh: visibleFrac * o.h,
      alpha,
    });
  }
  return ops;
}
