import { CANVAS_W, CANVAS_H } from '../constants';
import type { Box } from '../types';

// Where a COMMENTARY reel's video lands on the canvas. The live canvas (CommentaryCanvas) and the exporter
// (useCommentaryRecording) both composite through here so the preview and the MP4 cannot drift apart — the
// fork's whole point is that what you see is what exports, and two hand-copies of this formula would rot.
//
// The shape of it: a commentary reel is ONE full-bleed band, so the video is cover-fit to the WHOLE 1080×1920
// canvas (never letterboxed inside a smaller band), then zoomed and panned by the user's Adjust settings. The
// crop bars do NOT move or rescale it — they only narrow the CLIP window, so cropping hides the top/bottom of
// a fixed image. That is why `draw` ignores the crop box and `clip` ignores the zoom/pan.
//
// This is the collapse of reelLayout()/reelVideoRect() under defaultTwitterTemplateSettings() — the template
// CanvasGrid used to pin commentary reels to (bandX 0, bandY 0, 1080×1920, corner radius 0). fullBleedVideo.test.ts
// pins that equivalence, so a change to the reel-band math can't silently reframe every commentary reel.

/** The two rects a full-bleed composite needs: where to paint the frame, and what to clip it to. */
export interface FullBleedRects {
  /** Destination rect for drawImage — the cover-fit frame after zoom + pan. */
  draw: { dx: number; dy: number; dw: number; dh: number };
  /** Clip window — always full width; the crop bars bound it vertically. */
  clip: { x: number; y: number; w: number; h: number };
}

/**
 * Composite geometry for one frame.
 * @param vw/vh      source video dimensions in pixels
 * @param scaleMul   the Adjust flyout's zoom (videoScaleRef), 1 = untouched
 * @param offset     the manual pan (videoOffsetRef), in canvas px
 * @param crop       the crop box (boxRef) — only y/h are read; a full-bleed video always spans the width
 */
export function fullBleedVideoRects(
  vw: number,
  vh: number,
  scaleMul: number,
  offset: { x: number; y: number },
  crop: Box,
): FullBleedRects {
  const scale = Math.max(CANVAS_W / vw, CANVAS_H / vh) * scaleMul;
  const dw = vw * scale, dh = vh * scale;
  return {
    draw: { dx: (CANVAS_W - dw) / 2 + offset.x, dy: (CANVAS_H - dh) / 2 + offset.y, dw, dh },
    clip: { x: 0, y: crop.y, w: CANVAS_W, h: crop.h },
  };
}
