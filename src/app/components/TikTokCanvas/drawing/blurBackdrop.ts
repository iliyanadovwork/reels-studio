import { CANVAS_W, CANVAS_H } from '../constants';

// Blurred-video letterbox fill: instead of black bars around the video box, paint the CURRENT video frame
// cover-fit across the whole canvas, heavily blurred and slightly darkened — the classic vertical-video
// backdrop. Shared by the live preview draw loop and the exporter so both composite identically.
//
// Cost control: the frame is first downscaled into a tiny scratch canvas (a cheap, strong prefilter — most
// of the "blur" comes from throwing pixels away), then upscaled with smoothing plus a modest ctx.filter
// blur to hide the upscale blockiness. This keeps the per-frame cost trivial even at 60fps/export speed.

const SCRATCH_W = 68;    // ~1/16 of the canvas width — small enough to be free, big enough to keep hue detail
const SCRATCH_H = 120;

export type BackdropSource = HTMLVideoElement | VideoFrame;

/** A rect in SOURCE-video pixels — the slice of the frame the backdrop samples. */
export interface SrcRect { sx: number; sy: number; sw: number; sh: number }

/** Create the reusable scratch canvas (call once per surface; pass to every draw). */
export function createBackdropScratch(): OffscreenCanvas {
  return new OffscreenCanvas(SCRATCH_W, SCRATCH_H);
}

/** The source-video rect actually VISIBLE inside the crop clip window — so the backdrop can blur only what
    the viewer sees, never the cropped-away parts. `draw` is the video's on-canvas draw rect (reelVideoRect)
    and `clip` the crop clip window (band x/w + box y/h), both in canvas px. Clamped to the frame. */
export function visibleSourceRect(
  draw: { dx: number; dy: number; dw: number; dh: number },
  clip: { x: number; y: number; w: number; h: number },
  srcW: number,
  srcH: number,
): SrcRect {
  const clampX = (v: number) => Math.min(srcW, Math.max(0, v));
  const clampY = (v: number) => Math.min(srcH, Math.max(0, v));
  const sx = clampX(((clip.x - draw.dx) / draw.dw) * srcW);
  const sy = clampY(((clip.y - draw.dy) / draw.dh) * srcH);
  const sx2 = clampX(((clip.x + clip.w - draw.dx) / draw.dw) * srcW);
  const sy2 = clampY(((clip.y + clip.h - draw.dy) / draw.dh) * srcH);
  return { sx, sy, sw: Math.max(1, sx2 - sx), sh: Math.max(1, sy2 - sy) };
}

/** Paint the blurred cover-fit backdrop over the full canvas. `src` limits sampling to that slice of the
    frame (the cropped-visible region); absent = the whole frame. No-ops without a scratch context. */
export function drawBlurredBackdrop(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: BackdropSource,
  srcW: number,
  srcH: number,
  scratch: OffscreenCanvas,
  src?: SrcRect,
): void {
  if (!srcW || !srcH) return;
  const sctx = scratch.getContext('2d');
  if (!sctx) return;

  const { sx, sy, sw, sh } = src ?? { sx: 0, sy: 0, sw: srcW, sh: srcH };
  // Cover-fit the sampled slice into the scratch (crop, never letterbox — the backdrop must fill edge-to-edge).
  const s = Math.max(SCRATCH_W / sw, SCRATCH_H / sh);
  const dw = sw * s, dh = sh * s;
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(source, sx, sy, sw, sh, (SCRATCH_W - dw) / 2, (SCRATCH_H - dh) / 2, dw, dh);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';   // the blur hides any quality difference; low is cheapest
  // ctx.filter is ignored where unsupported — the downscale alone still reads as a heavy blur.
  ctx.filter = 'blur(14px) brightness(0.72)';
  // Overdraw past the edges so the blur can't reveal transparent fringes at the borders.
  const PAD = 32;
  ctx.drawImage(scratch, -PAD, -PAD, CANVAS_W + PAD * 2, CANVAS_H + PAD * 2);
  ctx.restore();
}
