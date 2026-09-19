import { SONOTRADE_CAPTION_MAX_W, SONOTRADE_CAPTION_FONT } from '../constants';

export const SONOTRADE_CAP_FONT = `400 42px ${SONOTRADE_CAPTION_FONT}`;

// How many rendered lines a caption wraps to at the given font/width. Module-private: the removed 'clean'
// caption template was the only caller that needed its own font/width, so the wrap is now reached solely
// through countSonotradeCaptionLines below.
function countCaptionLines(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  overlayCaption: string,
  font: string,
  maxWidth: number,
): number {
  if (!overlayCaption) return 0;

  ctx.font = font;

  const userLines = overlayCaption.split('\n');
  let total = 0;

  for (const userLine of userLines) {
    if (!userLine) { total++; continue; }
    let line = '';
    let lineCount = 1;
    for (const word of userLine.split(' ')) {
      const test = line + word + ' ';
      if (ctx.measureText(test).width > maxWidth && line) {
        lineCount++;
        line = word + ' ';
      } else {
        line = test;
      }
    }
    total += lineCount;
  }

  return total;
}

export function countSonotradeCaptionLines(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  overlayCaption: string,
  font: string = SONOTRADE_CAP_FONT,   // caption size is configurable, so callers pass the resolved font
  maxWidth: number = SONOTRADE_CAPTION_MAX_W,   // …and horizontal padding is configurable, so callers pass the resolved wrap width
): number {
  return countCaptionLines(ctx, overlayCaption, font, maxWidth);
}
