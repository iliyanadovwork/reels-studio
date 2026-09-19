import type { ImageOverlay } from '../types';
import { captionAt, captionDisplayText } from '@/lib/captions';

// ── Commentary captions (karaoke) ───────────────────────────────────────────
// A commentary reel's intro overlay carries caption chunks timed to the voice-over. Draw the word visible at
// intro-clock time `t` in the lower third: black on a bright highlight box, popping in as it lands. Shared by
// the commentary preview + its exporter so both read identically — and by nothing else: the Reddit canvas has
// neither `intro` nor `captions`, which is why this lives here rather than in drawOverlays (the module both
// canvases draw their image layers through).
//
// Every visual here is a PURE FUNCTION OF `t`. The exporter renders frames independently, at arbitrary
// timestamps and out of wall-clock order, so an animation that accumulated state between frames would render
// correctly on screen and wrongly in the MP4.
//
// Captions are ONE WORD at a time (see lib/captions), so the type is big — a single word has to carry the frame.
const CAPTION_SIZE = 84;
const CAPTION_FAMILY = '"Libre Franklin", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const captionFont = (px: number) => `800 ${px}px ${CAPTION_FAMILY}`;
// Lower third, but lifted clear of YouTube's Shorts chrome (title / channel / action buttons overlay the
// bottom of the frame — on some layouts up to ~400px). 1400 of 1920 ≈ 73% down.
const CAPTION_BASELINE = 1400;
const BOX_PAD_X = 30;
const BOX_PAD_Y = 16;
const BOX_RADIUS = 16;
const CAPTION_MAX_W = 960;                            // canvas is 1080 wide — keep a margin each side
const TEXT_MAX_W = CAPTION_MAX_W - BOX_PAD_X * 2;     // the BOX is what must fit, so the text fits inside it
// White on SOLID black — no footage bleeding through, so the text keeps full contrast over any frame.
// Hard-coded rather than read from CSS because the exporter draws on an OffscreenCanvas with no DOM to
// compute styles on.
const BOX_FILL = '#000000';
const TEXT_FILL = '#ffffff';

/** Largest size ≤ CAPTION_SIZE at which `text` fits `TEXT_MAX_W` — so a long word shrinks instead of running
 *  off the frame. Words are short, so this converges in a couple of steps. Leaves the chosen font set. */
function fitFontSize(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, text: string): number {
  let size = CAPTION_SIZE;
  for (let i = 0; i < 8 && size > 28; i++) {
    ctx.font = captionFont(size);
    const w = ctx.measureText(text).width;
    if (w <= TEXT_MAX_W) break;
    size = Math.max(28, Math.floor(size * (TEXT_MAX_W / w)));
  }
  ctx.font = captionFont(size);
  return size;
}

/** Overshooting ease (easeOutBack): rises past 1 then settles — what gives the pop its snap. */
function easeOutBack(p: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  const u = p - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

export function drawCommentaryCaptions(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  overlays: ImageOverlay[],
  t: number,
): void {
  const intro = overlays.find(o => o.intro && o.captions && o.captions.length > 0);
  if (!intro) return;
  const cap = captionAt(intro.captions, t);
  if (!cap || !cap.text.trim()) return;

  // Shown without punctuation — the stored text keeps it so the narrator phrases correctly.
  const word = captionDisplayText(cap.text);
  if (!word) return;   // a token that was nothing but punctuation

  // Pop-in, driven purely by how far into THIS word we are. Capped at half the word's own window so a very
  // short word still finishes its pop while on screen.
  const held = Math.max(0.001, cap.end - cap.start);
  const popDur = Math.min(0.13, held * 0.5);
  const p = Math.min(1, Math.max(0, (t - cap.start) / popDur));
  const scale = 0.72 + 0.28 * easeOutBack(p);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  fitFontSize(ctx, word);

  // Measure for a box that hugs the glyphs. actualBoundingBox gives the real ink extent, so the box sits
  // evenly around a word whether or not it has ascenders/descenders.
  const m = ctx.measureText(word);
  const ascent = m.actualBoundingBoxAscent || CAPTION_SIZE * 0.72;
  const descent = m.actualBoundingBoxDescent || CAPTION_SIZE * 0.22;
  const boxW = m.width + BOX_PAD_X * 2;
  const boxH = ascent + descent + BOX_PAD_Y * 2;
  // Scale about the box's centre so the pop grows from the middle rather than the text baseline.
  const cx = 540;
  const cy = CAPTION_BASELINE - ascent + boxH / 2 - BOX_PAD_Y;

  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);

  ctx.beginPath();
  ctx.roundRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH, BOX_RADIUS);
  ctx.fillStyle = BOX_FILL;
  ctx.fill();

  ctx.fillStyle = TEXT_FILL;
  ctx.fillText(word, cx, CAPTION_BASELINE);
  ctx.restore();
}
